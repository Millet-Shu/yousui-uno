const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// ==================== UNO 核心逻辑 ====================

const COLORS = ['red', 'yellow', 'green', 'blue'];
const T = { NUMBER: 0, SKIP: 1, REVERSE: 2, DRAW_TWO: 3, WILD: 4, WILD_DRAW_FOUR: 5 };

function createDeck() {
  const cards = [];
  for (const color of COLORS) {
    cards.push({ color, type: T.NUMBER, value: 0 });
    for (let v = 1; v <= 9; v++) {
      cards.push({ color, type: T.NUMBER, value: v });
      cards.push({ color, type: T.NUMBER, value: v });
    }
    for (let i = 0; i < 2; i++) {
      cards.push({ color, type: T.SKIP });
      cards.push({ color, type: T.REVERSE });
      cards.push({ color, type: T.DRAW_TWO });
    }
  }
  for (let i = 0; i < 4; i++) {
    cards.push({ color: 'none', type: T.WILD });
    cards.push({ color: 'none', type: T.WILD_DRAW_FOUR });
  }
  return cards;
}

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ==================== 模式规则 ====================
// 每个模式一份独立规则：以后"有岁"要加专属牌或改玩法，只改这里，主流程不用动
const MODE_RULES = {
  normal: {
    label: '正常版 UNO',
    unoWord: 'UNO',       // 剩 1 张时要喊的词
    buildDeck: () => createDeck(),
    grabLead: true,       // 是否有"抢先手"阶段
    grabExchange: true,   // 是否允许抢别人打出的相同牌
    shop: false,          // 是否有商店
  },
  yousui: {
    label: '有岁 UNO',
    unoWord: '有岁',
    buildDeck: () => createDeck(),   // 有岁专属牌后续在这里额外 push
    grabLead: true,
    grabExchange: true,
    shop: true,           // 有岁模式：正中间的商店，用同色手牌换牌
  },
};

// 取房间对应模式的规则；模式缺失时按正常版处理
function rulesOf(room) {
  return MODE_RULES[room && room.mode] || MODE_RULES.normal;
}

// ===== 回合计时器 =====
// 每位玩家一回合 30 秒：挂机不动就由服务端代为行动（摸牌/清罚牌/补选颜色），
// 避免有人坐在座位上但一直不出牌，把整局永远卡在那一个人身上。
const TURN_LIMIT = 30000;

// ===== 有岁商店 =====
const SHOP_SIZE = 4;

// 商品直接从牌堆拿牌（所以牌堆真的会少牌）。
// 万能牌本身没有颜色，就在上架时随机给它定一个"价签颜色"，用同色牌就能买走。
function makeShopSlot(room) {
  if (room.drawPile.length === 0) reshuffleIntoDraw(room);
  const card = room.drawPile.pop() || null;
  if (!card) return null;
  const priceColor = isWild(card)
    ? COLORS[Math.floor(Math.random() * COLORS.length)]
    : card.color;
  return { card, priceColor, sold: false };
}

function buildShop(room) {
  const out = [];
  for (let i = 0; i < SHOP_SIZE; i++) out.push(makeShopSlot(room));
  return out;
}

// 商店补货：把售罄/空掉的格子补上新货（牌堆不够就空着，等洗牌）
// 只有在四件商品全部卖光、或玩家主动刷新时才会走到这里
function refillShop(room) {
  if (!rulesOf(room).shop || !Array.isArray(room.shop)) return;
  room.shop = room.shop.map(s => (s && !s.sold) ? s : (makeShopSlot(room) || null));
}

function isWild(c) { return c.type === T.WILD || c.type === T.WILD_DRAW_FOUR; }

function isPlayable(c, topCard, currentColor, pendingDraw, pendingDrawType) {
  // 有叠加罚牌时
  if (pendingDraw > 0 && pendingDrawType) {
    if (pendingDrawType === T.WILD_DRAW_FOUR) {
      return c.type === T.WILD_DRAW_FOUR;
    }
    if (pendingDrawType === T.DRAW_TWO) {
      return c.type === T.DRAW_TWO || c.type === T.WILD_DRAW_FOUR;
    }
  }
  if (isWild(c)) return true;
  if (c.color === currentColor) return true;
  // 数字牌：同数字不同色也能出
  if (c.type === T.NUMBER && topCard.type === T.NUMBER && c.value === topCard.value) return true;
  // 动作牌：同类型不同色也能出
  if (c.type === topCard.type && c.type !== T.NUMBER) return true;
  return false;
}

function cardName(c) {
  const cn = { red: '红', yellow: '黄', green: '绿', blue: '蓝', none: '' };
  switch (c.type) {
    case T.NUMBER: return cn[c.color] + c.value;
    case T.SKIP: return cn[c.color] + '跳';
    case T.REVERSE: return cn[c.color] + '转';
    case T.DRAW_TWO: return cn[c.color] + '+2';
    case T.WILD: return '万能';
    case T.WILD_DRAW_FOUR: return '+4';
  }
}

// ==================== 房间管理 ====================

const rooms = new Map();

// 入参统一转成安全字符串，避免 name/code 传非字符串时 trim/toUpperCase 抛错拖垮进程
function safeStr(v) {
  return typeof v === 'string' ? v : '';
}

// 座位令牌：重连时凭令牌认领座位，避免拿别人公开的 playerId 顶号
function newSeatToken() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// ⚠️ 修复：所有字段正确初始化
function createRoom(maxPlayers = 4) {
  const code = genRoomCode();
  rooms.set(code, {
    code,
    maxPlayers,
    ownerSocketId: null,
    ownerPlayerId: null,
    players: [],
    spectators: [null, null, null, null, null],
    drawPile: [],
    playPile: [],      // 打牌堆：大家打出的牌（topCard 是它最上面那张）
    discardPile: [],   // 弃牌堆：商店付款等被弃掉的牌，不再混进打牌堆
    topCard: null,
    currentColor: 'red',
    currentIndex: 0,
    direction: 1,
    pendingDraw: 0,
    pendingDrawType: null,       // ✅ 之前没初始化
    status: 'waiting',
    mode: null,                  // 游戏模式：normal=正常版，yousui=有岁版；开局前由房主选择
    wildPending: false,
    unoCalled: {},
    unoBadge: null,              // 喊牌飘带：{ playerId, expire }，只在这一个回合内显示
    pendingReport: null,
    justDrew: false,             // ✅ 之前没初始化
    aiTurnPending: false,        // ✅ AI 已排程标记
    aiTurnSeq: null,             // 该排程对应的回合序号，回合切换后旧定时器自动作废
    turnSeq: 0,                  // 回合序号：每次换人/重开都自增，用于作废旧异步定时器
    turnDeadline: null,          // 本回合截止时间戳（毫秒）；给前端算剩余秒数
    turnRemain: null,            // 暂停时记下的剩余毫秒，恢复后接着走
    turnTimer: null,             // 回合计时器句柄
    turnClockId: 0,              // 计时器版本号：每次重新起表自增，前端据此重置倒计时显示
    gameId: 0,                   // 局次：每次开局自增，避免上一局的抢先手定时器串到新局
    paused: false,
    pausedBy: null,
    pausedById: null,
    grabAvailable: null,  // 可以抢牌的状态 { card, playedBy }
    shop: null,           // 有岁商店：4 张在售牌（只有 yousui 模式才有）
    shopRerollUsed: false, // 本回合是否已经刷新过商店（每人每回合一次）
    log: []
  });
  return rooms.get(code);
}

// 只剩 AI、且没有观战者时清理房间，避免房间越积越多（AI 不会自己退出）
function dropRoomIfAiOnly(room) {
  const hasHuman = room.players.some(p => !p.isAI);
  const hasSpectator = (room.spectators || []).some(s => s);
  if (!hasHuman && !hasSpectator) {
    rooms.delete(room.code);
    return true;
  }
  return false;
}

function broadcastRoom(room) {
  for (const p of room.players) {
    if (p.isAI || !p.socketId) continue;
    const socket = io.sockets.sockets.get(p.socketId);
    if (socket) socket.emit('roomUpdate', publicRoomState(room, p));
  }
  for (const s of (room.spectators || [])) {
    if (!s) continue;
    const socket = io.sockets.sockets.get(s.socketId);
    if (socket) socket.emit('roomUpdate', publicRoomState(room, s));
  }
}

function publicRoomState(room, selfPlayer) {
  const selfId = selfPlayer ? selfPlayer.id : null;
  return {
    code: room.code,
    status: room.status,
    mode: room.mode || null,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isAI: p.isAI,
      aiProxy: !!p.aiProxy,
      offline: !!p.offline,
      handCount: p.hand.length,
      finished: !!p.finished,
      rank: p.rank || null,
      unoCalled: !!room.unoCalled[p.id],
      unoAnnounced: !!(room.unoBadge && room.unoBadge.playerId === p.id),
      isOwner: p.id === room.ownerPlayerId,
      isYou: p.id === selfId,
      isCurrent: room.players[room.currentIndex] && room.players[room.currentIndex].id === p.id
    })),
    topCard: room.topCard,
    currentColor: room.currentColor,
    yourHand: selfPlayer && selfPlayer.hand ? selfPlayer.hand : [],
    currentPlayerName: room.players[room.currentIndex] ? room.players[room.currentIndex].name : '',
    direction: room.direction,
    pendingDraw: room.pendingDraw,
    pendingDrawType: room.pendingDrawType,
    wildPending: room.wildPending,
    paused: !!room.paused,
    pausedBy: room.pausedBy || null,
    // 回合计时：只在对局进行中且没暂停时给剩余毫秒，前端用本地时间倒计时
    turnRemain: (room.status === 'playing' && !room.paused && room.turnDeadline)
      ? Math.max(0, room.turnDeadline - Date.now()) : null,
    turnLimit: TURN_LIMIT,
    turnClockId: room.turnClockId || 0,
    turnPlayerId: (room.status === 'playing' && room.players[room.currentIndex])
      ? room.players[room.currentIndex].id : null,
    isPausedByYou: room.pausedById ? room.pausedById === selfId : room.pausedBy === (selfPlayer ? selfPlayer.name : ''),
    pendingReport: room.pendingReport,
    myUnoCalled: selfId ? !!room.unoCalled[selfId] : false,
    drawPileCount: room.drawPile.length,
    playCount: room.playPile.length,
    discardCount: room.discardPile.length,
    // 弃牌堆最上面那张（正面展示用）；没有弃牌时为 null
    discardTop: room.discardPile.length > 0 ? room.discardPile[room.discardPile.length - 1] : null,
    // 有岁商店：只在有商店的模式、且对局进行中下发
    shopEnabled: !!rulesOf(room).shop,
    shop: (rulesOf(room).shop && (room.status === 'playing' || room.status === 'grabbing')) ? (room.shop || null) : null,
    shopRerollUsed: !!room.shopRerollUsed,
    maxPlayers: room.maxPlayers,
    justDrew: !!room.justDrew,
    // 房主身份按玩家 id 判定：socket 重连换了新 id 也不会丢失房主
    isOwner: !!(selfPlayer && selfPlayer.id === room.ownerPlayerId),
    grabAvailable: (() => {
      if (!room.grabAvailable || !selfId) return null;
      const me = room.grabAvailable.candidates.find(c => c.playerId === selfId);
      if (!me) return null;
      return { card: room.grabAvailable.card, playedBy: room.grabAvailable.playedBy, cardIndex: me.cardIndex };
    })(),
    spectators: (room.spectators || []).slice(0, 5).map(s => s ? { id: s.id, name: s.name, isYou: s.id === selfId, isOwner: s.id === room.ownerPlayerId } : null),
    log: room.log.slice(-20)
  };
}

function addLog(room, msg) {
  room.log.push(msg);
  // 只保最近的记录：长局里日志会无限增长，既占内存又拖慢每次广播
  if (room.log.length > 120) room.log.splice(0, room.log.length - 120);
  console.log(`[${room.code}] ${msg}`);
}

function nextIndex(room, offset = 1, fromIdx = null) {
  const n = room.players.length;
  const base = fromIdx === null ? room.currentIndex : fromIdx;
  return (base + room.direction * offset + n * 100) % n;
}

// 有人离开/被踢后校正轮次指针：保证指向未出完牌的玩家，避免卡在空位
function normalizeCurrentIndex(room) {
  const n = room.players.length;
  if (n === 0) { room.currentIndex = 0; return; }
  room.currentIndex = ((room.currentIndex % n) + n) % n;
  for (let i = 0; i < n; i++) {
    const idx = (room.currentIndex + room.direction * i + n * 100) % n;
    if (!room.players[idx].finished) { room.currentIndex = idx; return; }
  }
}

function drawCards(room, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    if (room.drawPile.length === 0) reshuffleIntoDraw(room);
    if (room.drawPile.length === 0) break;
    out.push(room.drawPile.pop());
  }
  return out;
}

// 牌堆摸空了怎么补：
// 1) 先把弃牌堆（商店付掉的牌等）整堆洗回牌堆
// 2) 还不够，就把打牌堆除最上面那张外的牌洗回牌堆（顶牌必须留在场上）
function reshuffleIntoDraw(room) {
  if (room.discardPile.length > 0) {
    room.drawPile = shuffle(room.drawPile.concat(room.discardPile));
    room.discardPile = [];
    addLog(room, '弃牌堆洗回牌堆');
  }
  if (room.drawPile.length > 0) return;
  if (room.playPile.length > 1) {
    const top = room.playPile.pop();
    room.drawPile = shuffle(room.playPile);
    room.playPile = [top];
    addLog(room, '打牌堆除顶牌外洗回牌堆');
  }
}

function startGame(room) {
  const rules = rulesOf(room);
  room.status = 'grabbing';
  room.gameId = (room.gameId || 0) + 1;   // 新的一局：旧局的早起手定时器作废
  room.turnSeq = (room.turnSeq || 0) + 1; // 新的一局：旧的回合定时器作废
  stopTurnClock(room);                    // 上一局的回合计时器作废
  room.turnRemain = null;
  room.drawPile = shuffle(rules.buildDeck());
  room.playPile = [];
  room.discardPile = [];
  room.topCard = null;
  room.shop = rules.shop ? buildShop(room) : null;   // 有岁模式：从牌堆抽 4 件商品上架
  room.shopRerollUsed = false;

  for (const p of room.players) {
    p.hand = []; p.finished = false; p.rank = null; p.unoCalled = false;
    p.aiProxy = !!p.offline;  // 开局就离线的玩家由 AI 代理
  }

  for (let i = 0; i < 7; i++) {
    for (const p of room.players) {
      const c = room.drawPile.pop();
      if (c) p.hand.push(c);
    }
  }

  room.currentColor = null;
  room.currentIndex = 0;
  room.direction = 1;
  room.pendingDraw = 0;
  room.pendingDrawType = null;   // ✅ 清零
  room.wildPending = false;
  room.justDrew = false;        // ✅ 清零
  room.aiTurnPending = false;
  room.aiTurnSeq = null;
  room.grabAvailable = null;    // ✅ 重开时清理抢牌窗口
  room.paused = false;          // ✅ 重开时不能在暂停状态
  room.pausedBy = null;
  room.pausedById = null;
  room.pendingReport = null;
  room.unoCalled = {};
  room.unoBadge = null;
  room.log = [];

  addLog(room, `【${rules.label}】游戏开始！抢"${rules.unoWord}"先手！`);
  broadcastRoom(room);

  // 没有"抢先手"阶段的模式，直接由第一位玩家先手
  if (!rules.grabLead) {
    grabLead(room, room.players[0].id);
    return;
  }

  const gid = room.gameId;
  setTimeout(() => {
    // 只对同一局、仍在抢阶段的房间生效，避免上一局的定时器串到新局
    if (room.gameId !== gid || room.status !== 'grabbing') return;
    const ai = room.players.find(p => isAutoPlayer(p));
    if (ai) grabLead(room, ai.id);
  }, 2000);
}

function grabLead(room, playerId) {
  if (room.status !== 'grabbing') return;
  const leadIdx = room.players.findIndex(p => p.id === playerId);
  if (leadIdx < 0) return;   // 观战者乱点不能把 currentIndex 改成 -1
  room.currentIndex = leadIdx;

  let starter = room.drawPile.pop();
  // 牌堆见底（有岁模式商店会先抽走 4 张，极端情况可能抽空）先洗回再抽，避免 starter 为 null 直接崩
  if (!starter) { reshuffleIntoDraw(room); starter = room.drawPile.pop(); }
  if (!starter) {
    addLog(room, '牌不够，无法发起始牌，回到等待区');
    room.status = 'waiting';
    broadcastRoom(room);
    return;
  }
  let guard = 0;
  while (starter && isWild(starter) && guard < 20) {
    room.drawPile.unshift(starter);
    starter = room.drawPile.pop();
    guard++;
  }

  room.playPile.push(starter);
  room.topCard = starter;
  // 连续抽到万能牌导致循环用尽 guard 时，起始牌仍是万能牌（color = none），必须随机给一个颜色，
  // 否则 currentColor 会是 'none'，之后谁都出不了牌、整个对局卡死
  room.currentColor = isWild(starter)
    ? COLORS[Math.floor(Math.random() * COLORS.length)]
    : starter.color;
  room.status = 'playing';

  addLog(room, `${room.players[room.currentIndex].name} 抢到先手！起始牌 ${cardName(starter)}`);

  // ✅ 修复：起始罚牌一次性发给先手，清 pendingDraw 同时清 pendingDrawType
  if (starter.type === T.DRAW_TWO) {
    const drawn = drawCards(room, 2);
    room.players[room.currentIndex].hand.push(...drawn);
    addLog(room, `${room.players[room.currentIndex].name} 起始罚摸2张`);
    room.pendingDraw = 0;
    room.pendingDrawType = null;
  } else if (starter.type === T.WILD_DRAW_FOUR) {
    const drawn = drawCards(room, 4);
    room.players[room.currentIndex].hand.push(...drawn);
    addLog(room, `${room.players[room.currentIndex].name} 起始罚摸4张`);
    room.pendingDraw = 0;
    room.pendingDrawType = null;
  }

  if (starter.type === T.SKIP) {
    addLog(room, `起始禁止，下家跳过`);
    advance(room);
  } else if (starter.type === T.REVERSE) {
    room.direction *= -1;
    if (room.players.filter(p => !p.finished).length === 2) {
      // 与对局中一致：2 人局反转等同跳过，先手者保留回合
      addLog(room, `起始反转（2 人局=跳过），下家被跳过`);
    } else {
      addLog(room, `起始反转，方向反转`);
      advance(room);
    }
  }

  startTurnClock(room);   // 先起表再广播，前端第一次渲染就能看到倒计时
  broadcastRoom(room);

  const next = room.players[room.currentIndex];
  if (next && isAutoPlayer(next)) scheduleIfAuto(room);
}

// 抢先手阶段已没有任何在线人类玩家时兜底开局，避免全场卡在 grabbing
function scheduleGrabLeadFallback(room) {
  if (room.status !== 'grabbing' || room.players.length === 0) return;
  if (!room.players.every(p => p.isAI || p.offline || p.aiProxy)) return;
  setTimeout(() => {
    if (room.status !== 'grabbing' || room.players.length === 0) return;
    grabLead(room, room.players[0].id);
  }, 800);
}

function playCard(room, playerId, cardIndex, chosenColor = null) {
  if (room.status !== 'playing' || room.paused) return;
  const player = room.players[room.currentIndex];
  if (!player || player.id !== playerId) return;
  if (room.wildPending) {
    // wildPending 期间必须通过颜色弹窗传合法颜色，不能乱点手牌绕过
    if (chosenColor && ['red', 'yellow', 'green', 'blue'].includes(chosenColor)) {
      resolveWildColor(room, playerId, chosenColor);
    }
    return;
  }

  const card = player.hand[cardIndex];
  if (!card) return;
  if (!isPlayable(card, room.topCard, room.currentColor, room.pendingDraw, room.pendingDrawType)) return;

  const myUnoCalled = !!room.unoCalled[player.id];
  closeGrabWindow(room);  // 有人已行动，抢牌窗口关闭，并作废旧回合的定时器
  for (const pid in room.unoCalled) {
    room.unoCalled[pid] = false;
  }
  room.unoBadge = null;   // 进入下一回合，喊牌飘带随之消失

  player.hand.splice(cardIndex, 1);
  room.playPile.push(card);
  room.topCard = card;
  room.justDrew = false;

  // 又有人出牌 → 上一张牌留下的举报窗口立即失效
  // 举报只在"刚打完、还没人接着出"的间隙里有效，给没喊的人留一个逃脱机会
  room.pendingReport = null;
  // 没喊有岁就出到剩 1 张 → 可以被举报（直到下一张牌被打出/抢出，或 5 秒超时）
  if (room.status === 'playing' && player.hand.length === 1 && !myUnoCalled) {
    setPendingReport(room, player);
  }

  // ✅ 修复：UNO 必须打完剩 <=1 张才算数（之前错写成 <=2）
  if (myUnoCalled && player.hand.length <= 1) {
    addLog(room, `${player.name} 喊了"${rulesOf(room).unoWord}"`);
    room.unoCalled[player.id] = true;
    setUnoBadge(room, player.id);   // 飘带亮到下一个回合开始
  }

  handleCardEffect(room, player, card, chosenColor);
}

function handleCardEffect(room, player, card, chosenColor) {
  addLog(room, `${player.name} 打出 ${cardName(card)}`);

  switch (card.type) {
    case T.NUMBER:
      room.currentColor = card.color;
      advance(room);
      break;
    case T.SKIP: {
      room.currentColor = card.color;
      advance(room);
      // 先记录被跳过的人是第一次换人后的那位，再推进一次
      const skipped = room.players[room.currentIndex];
      advance(room);
      addLog(room, `${skipped ? skipped.name : ''} 被跳过`);
      break;
    }
    case T.REVERSE: {
      room.currentColor = card.color;
      room.direction *= -1;
      if (room.players.filter(p => !p.finished).length === 2) {
        // 官方规则：2 人局反转等同"跳过"，对手被跳过、出牌者再来一回合
        const skipped = room.players[nextIndex(room)];
        advance(room);
        advance(room);
        addLog(room, `方向反转（2 人局=跳过），${skipped ? skipped.name : ''} 被跳过`);
      } else {
        addLog(room, `方向反转`);
        advance(room);
      }
      break;
    }
    case T.DRAW_TWO:
      room.currentColor = card.color;
      room.pendingDraw += 2;
      room.pendingDrawType = T.DRAW_TWO;
      advance(room);
      break;
    case T.WILD:
      room.wildPending = true;
      if (chosenColor) { resolveWildColor(room, player.id, chosenColor); return; }
      break;
    case T.WILD_DRAW_FOUR:
      room.pendingDraw += 4;
      room.pendingDrawType = T.WILD_DRAW_FOUR;
      room.wildPending = true;
      if (chosenColor) { resolveWildColor(room, player.id, chosenColor); return; }
      break;
  }

  checkWin(room);
  if (room.status === 'over') { broadcastRoom(room); return; }

  if (room.wildPending) {
    // 等待选色：重新计一次时（选色也是这一手的一部分，不然后面可能一秒都不剩）
    startTurnClock(room);
    broadcastRoom(room);
    return;
  }

  openGrabWindow(room, player);
}

// 关闭抢牌窗口：清掉窗口内"提前喊"的标记与飘带，并作废旧回合的异步调度
function closeGrabWindow(room) {
  const win = room.grabAvailable;
  if (win) {
    for (const c of win.candidates) {
      if (room.unoCalled[c.playerId]) {
        room.unoCalled[c.playerId] = false;
        if (room.unoBadge && room.unoBadge.playerId === c.playerId) room.unoBadge = null;
      }
    }
  }
  room.grabAvailable = null;
  room.turnSeq = (room.turnSeq || 0) + 1;
}

// AI 是否愿意抢这张牌：罚牌（+2/+4）不抢，留给自己的回合继续叠加罚牌
function aiWantsGrab(card) {
  return card.type !== T.DRAW_TWO && card.type !== T.WILD_DRAW_FOUR;
}

// 打开抢牌窗口：手上有和顶牌完全相同的牌即可抢（含出牌者自己，可连出）
function openGrabWindow(room, playedBy) {
  room.grabAvailable = null;

  // 该模式不开放"抢相同的牌"时，直接结束本轮
  if (!rulesOf(room).grabExchange) {
    broadcastRoom(room);
    scheduleIfAuto(room);
    return;
  }

  const lastCard = room.topCard;
  const candidates = [];
  for (const p of room.players) {
    if (p.finished) continue;
    const idx = p.hand.findIndex(c =>
      c.color === lastCard.color && c.type === lastCard.type && c.value === lastCard.value
    );
    if (idx >= 0) candidates.push({ playerId: p.id, cardIndex: idx });
  }

  if (candidates.length > 0) {
    // AI（含离线代理）自动抢牌；但罚牌（+2/+4）一律不抢：
    // 抢牌会把已经累加的 pendingDraw 清零再重置成本张牌的罚数，
    // 等于替后面的人解围。留到自己回合正常打出，罚牌才能继续往上叠。
    const aiGrabbers = candidates
      .map(c => room.players.find(x => x.id === c.playerId))
      .filter(p => p && isAutoPlayer(p) && aiWantsGrab(lastCard));
    const hasHumanCandidate = candidates.some(c => {
      const p = room.players.find(x => x.id === c.playerId);
      return p && !isAutoPlayer(p);
    });

    // 只有 AI 候选、且它们都不想抢 → 不用开窗，直接回到正常回合（否则白等 3 秒）
    if (!hasHumanCandidate && aiGrabbers.length === 0) {
      broadcastRoom(room);
      scheduleIfAuto(room);
      return;
    }

    const win = { card: lastCard, playedBy: playedBy.name, candidates };
    room.grabAvailable = win;
    for (const p of aiGrabbers) {
      setTimeout(() => {
        // 必须比对同一个窗口对象：否则上一次窗口的残留定时器会误抢新窗口里的牌
        if (room.grabAvailable !== win) return;
        if (!win.candidates.some(c => c.playerId === p.id)) return;
        grabCard(room, p.id);
      }, 1000 + Math.random() * 900);
    }
    // 3 秒内没人抢就自动关闭，防止卡住游戏（同样按窗口对象比对，避免误关新窗口）
    setTimeout(() => {
      if (room.grabAvailable === win) {
        // 窗口过期：抢牌候选人在窗口里"提前喊"的标记作废，避免带到之后的回合
        closeGrabWindow(room);
        broadcastRoom(room);
        scheduleIfAuto(room);
      }
    }, 3000);
  }

  broadcastRoom(room);
  if (!room.grabAvailable) scheduleIfAuto(room);
}

function resolveWildColor(room, playerId, color) {
  if (!room.wildPending) return;  // 没有待选色状态，忽略乱点
  const player = room.players[room.currentIndex];
  if (!player || player.id !== playerId) return;
  if (!['red', 'yellow', 'green', 'blue'].includes(color)) return;  // 非法颜色直接丢弃
  room.currentColor = color;
  room.wildPending = false;
  // 注意：不要清 pendingReport，否则剩 1 张时打万能牌会白白跳过举报窗口
  addLog(room, `${player.name} 指定颜色 ${colorName(color)}`);
  advance(room);

  checkWin(room);
  if (room.status === 'over') { broadcastRoom(room); return; }

  openGrabWindow(room, player);
}

function drawCard(room, playerId) {
  if (room.status !== 'playing' || room.paused) return;
  const player = room.players[room.currentIndex];
  if (!player || player.id !== playerId) return;
  if (room.wildPending) return;
  if (room.justDrew) return;   // 本回合已摸过一张，防止连点摸牌堆无限摸牌
  closeGrabWindow(room);  // 当前玩家已行动，抢牌窗口关闭

  // 有罚牌要摸
  if (room.pendingDraw > 0) {
    const drawn = drawCards(room, room.pendingDraw);
    player.hand.push(...drawn);
    addLog(room, `${player.name} 被罚摸了 ${room.pendingDraw} 张牌`);
    room.pendingDraw = 0;
    room.pendingDrawType = null;   // ✅ 清零
    room.justDrew = false;
    advance(room);
    room.unoBadge = null;   // 换到下一位玩家，飘带消失
    broadcastRoom(room);
    scheduleIfAuto(room);
    return;
  }

  const drawn = drawCards(room, 1);
  if (drawn.length > 0) {
    player.hand.push(drawn[0]);
    addLog(room, `${player.name} 摸了一张牌`);
    if (isPlayable(drawn[0], room.topCard, room.currentColor, 0, null)) {
      room.justDrew = true;
    } else {
      advance(room);
      room.unoBadge = null;   // 换到下一位玩家，飘带消失
    }
  } else {
    advance(room);
    room.unoBadge = null;   // 换到下一位玩家，飘带消失
  }
  // 摸到能出的牌 → 这回合继续，给他重新计一次时（要先起表再广播，前端才看得到新的倒计时）
  if (room.justDrew) startTurnClock(room);
  broadcastRoom(room);

  scheduleIfAuto(room);
}

// 是否由 AI 代为行动：真正的 AI，或离线被 AI 代理的玩家
function isAutoPlayer(p) {
  return !!(p && (p.isAI || p.aiProxy));
}

// 轮到某人时，若该玩家由 AI 行动则调度 AI 回合
// AI 出牌前的停顿：给人类玩家留出看清牌面的时间（太慢会拖节奏）
const AI_DELAY = 1700;      // 常规出牌
const AI_DELAY_EXTRA = 1400; // 选色/摸牌等紧随动作

function scheduleIfAuto(room, delay = AI_DELAY) {
  const cur = room.players[room.currentIndex];
  if (room.status === 'playing' && !room.paused && isAutoPlayer(cur)) {
    scheduleAiTurn(room, delay);
  }
}

// 选下一个房主：优先非 AI 在线玩家 → 非 AI 离线玩家 → 在线观战者，绝不选 AI
function pickNextOwner(room) {
  return room.players.find(x => !x.isAI && !x.offline && x.socketId)
    || room.players.find(x => !x.isAI && x.socketId)
    || (room.spectators || []).find(s => s && s.socketId);
}

// 房主离开/掉线时转移房主；fromSocketId 必须仍是当前房主才转移
function transferOwner(room, fromSocketId) {
  if (room.ownerSocketId !== fromSocketId) return;
  const next = pickNextOwner(room);
  if (next) {
    room.ownerSocketId = next.socketId;
    room.ownerPlayerId = next.id;
    addLog(room, `房主转移给 ${next.name}`);
  } else {
    room.ownerSocketId = null;
    room.ownerPlayerId = null;
    addLog(room, '房主离开，暂无可接管的玩家');
  }
}

// 是否是房主：优先按玩家 id 判断，兼容观战者与旧数据
function isRoomOwner(room, socketId, playerId) {
  if (!room) return false;
  if (room.ownerPlayerId) return playerId === room.ownerPlayerId;
  return socketId === room.ownerSocketId;
}

// 找出当前房主对象（玩家或观战者）；找不到说明房主身份已失效
function findOwner(room) {
  if (!room.ownerPlayerId) return null;
  return room.players.find(p => p.id === room.ownerPlayerId)
    || (room.spectators || []).find(s => s && s.id === room.ownerPlayerId)
    || null;
}

// 房主身份丢失（离开/被踢/换号）时兜底选一个新房主，避免全房间没人能开始游戏
function ensureOwner(room) {
  const cur = findOwner(room);
  if (cur) {
    if (cur.socketId) room.ownerSocketId = cur.socketId;  // 同步可能变过的 socket
    return;
  }
  const next = pickNextOwner(room);
  if (next) {
    room.ownerPlayerId = next.id;
    room.ownerSocketId = next.socketId;
    addLog(room, `房主转移给 ${next.name}`);
  } else {
    room.ownerPlayerId = null;
    room.ownerSocketId = null;
  }
}

// 停表：暂停/结束时调用。顺手记下还剩多少毫秒，恢复时接着走
function stopTurnClock(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  if (room.turnDeadline) room.turnRemain = Math.max(0, room.turnDeadline - Date.now());
  room.turnDeadline = null;
}

// 起表：每次换人/重开计时都用这个。remainMs 传了就按剩余时间续（暂停恢复用）
function startTurnClock(room, remainMs) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  room.turnDeadline = null;
  if (!room || room.status !== 'playing' || room.paused || room.players.length === 0) {
    room.turnRemain = null;
    return;
  }
  const ms = Math.max(1000, (remainMs === undefined || remainMs === null) ? TURN_LIMIT : remainMs);
  room.turnClockId = (room.turnClockId || 0) + 1;   // 前端看到这个号变了就重置倒计时
  const cid = room.turnClockId;
  room.turnRemain = ms;
  room.turnDeadline = Date.now() + ms;
  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    // 只认最后一张表：中途重起过表（换人/续时/暂停恢复）时旧表直接作废。
    // 注意要用 clockId 而不是 turnSeq —— 抢牌窗口开关也会动 turnSeq
    if (room.turnClockId !== cid) return;
    timeoutTurn(room);
  }, ms);
}

// 有人离开/被踢/暂停解除后，把回合计时重新对齐到现在的当前玩家。
// turnChanged=true（回合换人）给满时间，否则按暂停时记下的剩余时间继续。
function refreshTurnClockAfterSeatChange(room, turnChanged) {
  if (!room || room.status !== 'playing' || room.paused) { stopTurnClock(room); return; }
  // 没换人时按"这一刻真正还剩多少"续，不能直接拿 turnRemain（那是起表时的满值）
  const remain = room.turnDeadline
    ? Math.max(1000, room.turnDeadline - Date.now())
    : (room.turnRemain || TURN_LIMIT);
  startTurnClock(room, turnChanged ? TURN_LIMIT : remain);
}

// 超时：替挂机的人把这一手走完，别让对局停住
function timeoutTurn(room) {
  if (!room || room.status !== 'playing' || room.paused) return;
  const player = room.players[room.currentIndex];
  if (!player) return;
  // AI 由自己的排程行动：这里只轻轻催一下，再给它几秒
  if (isAutoPlayer(player)) {
    startTurnClock(room, 5000);
    scheduleIfAuto(room, 400);
    return;
  }

  room.turnDeadline = null;
  room.turnRemain = null;

  // 卡在选色：超时就随便替它选一个，否则这一手永远走不完
  if (room.wildPending) {
    const color = COLORS[Math.floor(Math.random() * COLORS.length)];
    addLog(room, `${player.name} 超时，自动选色 ${colorName(color)}`);
    resolveWildColor(room, player.id, color);
    broadcastRoom(room);
    return;   // resolveWildColor 内部会 advance 并重起计时
  }

  // 有罚牌：替它认罚（drawCard 会清罚牌、换人、重起计时）
  if (room.pendingDraw > 0) {
    addLog(room, `${player.name} 超时，自动收下 ${room.pendingDraw} 张罚牌`);
    drawCard(room, player.id);
    return;
  }

  // 普通超时：摸一张就走（摸到能出的也直接过，挂机就是挂机）
  // 已经摸过牌的人（justDrew）不再补发，免得靠超时多摸一张
  const drawn = room.justDrew ? [] : drawCards(room, 1);
  if (drawn.length) player.hand.push(...drawn);
  addLog(room, drawn.length ? `${player.name} 超时，自动摸 1 张并跳过` : `${player.name} 超时，跳过`);
  closeGrabWindow(room);
  room.justDrew = false;
  advance(room);          // advance 内部会重起计时
  room.unoBadge = null;
  broadcastRoom(room);
  scheduleIfAuto(room);
}

function advance(room) {
  const n = room.players.length;
  if (n === 0) return;
  room.turnSeq = (room.turnSeq || 0) + 1;   // 回合切换：作废旧回合遗留的 AI 定时器
  let next = nextIndex(room, 1);
  let guard = 0;
  while (room.players[next] && room.players[next].finished && guard < n) {
    next = nextIndex(room, 1, next);
    guard++;
  }
  room.currentIndex = next;
  // ✅ 切换玩家时清理 justDrew
  room.justDrew = false;
  // 新回合开始：本回合的商店刷新次数重置
  room.shopRerollUsed = false;
  // 新回合重新起表（暂停中会自己停掉）
  startTurnClock(room);
}

// 抢牌功能：任何人（包括刚打出的人自己）抢出与顶牌完全相同的牌
// 中间的人全部被跳过，轮到抢牌者的下一家行动
function grabCard(room, playerId) {
  if (room.status !== 'playing' || room.paused) return;
  if (!room.grabAvailable) return;
  const cand = room.grabAvailable.candidates.find(c => c.playerId === playerId);
  if (!cand) return;

  const grabberIdx = room.players.findIndex(p => p.id === playerId);
  const grabber = room.players[grabberIdx];
  if (!grabber || grabber.finished) return;

  // 校验那张牌仍在手上且与顶牌完全相同（防止状态变化后错抢）
  const card = grabber.hand[cand.cardIndex];
  const lastCard = room.grabAvailable.card;
  if (!card || card.color !== lastCard.color || card.type !== lastCard.type || card.value !== lastCard.value) return;

  addLog(room, `⚡ ${grabber.name} 抢出相同的牌 ${cardName(card)}！`);

  // UNO 喊牌逻辑与 playCard 保持一致
  const myUnoCalled = !!room.unoCalled[grabber.id];
  closeGrabWindow(room);   // 抢牌成功，窗口关闭并作废旧回合的定时器
  for (const pid in room.unoCalled) {
    room.unoCalled[pid] = false;
  }
  room.unoBadge = null;   // 进入下一回合，喊牌飘带随之消失

  grabber.hand.splice(cand.cardIndex, 1);
  room.playPile.push(card);
  room.topCard = card;
  room.justDrew = false;

  // 抢牌也算"有人接着出牌"，上一张牌的举报窗口立即失效
  room.pendingReport = null;
  // 抢出后剩 1 张且没喊有岁 → 可被举报（直到下一张牌被打出/抢出，或 5 秒超时）
  if (grabber.hand.length === 1 && !myUnoCalled) {
    setPendingReport(room, grabber);
  }
  if (myUnoCalled && grabber.hand.length <= 1) {
    addLog(room, `${grabber.name} 喊了"${rulesOf(room).unoWord}"`);
    room.unoCalled[grabber.id] = true;
    setUnoBadge(room, grabber.id);   // 飘带亮到下一个回合开始
  }

  // 抢出 +2/+4：之前累加的罚牌数清零，之后重新按这张牌累加为 2 或 4
  room.pendingDraw = 0;
  room.pendingDrawType = null;

  // 轮到抢牌者，由 handleCardEffect 从这里推进到抢牌者的下家
  room.currentIndex = grabberIdx;

  // 重新处理牌效；万能牌让抢牌者自己选颜色（wildPending 流程）
  handleCardEffect(room, grabber, card, null);
  // 抢到的是万能牌且抢牌者是 AI（含离线代理）时，需要立刻替它选色，否则会卡在选色
  if (room.wildPending && isAutoPlayer(room.players[room.currentIndex])) scheduleIfAuto(room, AI_DELAY_EXTRA);
}

// ===== 有岁商店：用一张同色手牌换走商店里的牌 =====
// 规则：只能在自己回合买；付款牌必须和商品同色；付款牌进弃牌堆（不影响顶牌与当前颜色）
function buyShopCard(room, playerId, slot, payIndex) {
  if (!rulesOf(room).shop) return false;
  if (room.status !== 'playing' || room.paused) return false;
  if (!Array.isArray(room.shop)) return false;
  const player = room.players[room.currentIndex];
  if (!player || player.id !== playerId) return false;   // 只有当前回合的玩家能买
  if (room.wildPending || room.pendingDraw > 0) return false;  // 先处理选色/罚牌，别拿商店躲罚

  slot = parseInt(slot, 10);
  payIndex = parseInt(payIndex, 10);
  if (!(slot >= 0 && slot < room.shop.length)) return false;
  const goods = room.shop[slot];
  const pay = player.hand[payIndex];
  if (!goods || goods.sold || !goods.card) return false;    // 已售罄的格子不能买
  if (!pay) return false;
  if (pay.color === 'none' || pay.color !== goods.priceColor) return false;  // 只能同色付款，万能牌不能当货币

  player.hand.splice(payIndex, 1);
  room.discardPile.push(pay);        // 手上的付款牌进弃牌堆
  player.hand.push(goods.card);      // 买到的牌进手牌
  room.shop[slot] = { sold: true };  // 卖掉的位置留空，四件都卖光才补货
  addLog(room, `${player.name} 用 ${cardName(pay)} 在商店换走了 ${cardName(goods.card)}`);

  // 买牌也是"本回合已行动"：上一张牌的举报窗口关闭。
  // 但如果这个举报窗口正是针对自己的（刚出到剩 1 张没喊），不能靠买牌躲掉，得留着
  if (room.pendingReport && room.pendingReport.playerId !== player.id) room.pendingReport = null;
  // 喊牌标记：买牌是"自己的行动"，保留自己的，其他人的作废（跟出牌/抢牌一致）
  const keepUnoCall = !!room.unoCalled[player.id];
  for (const pid in room.unoCalled) room.unoCalled[pid] = false;
  if (keepUnoCall) room.unoCalled[player.id] = true;
  // 飘带同理：自己的留着，别人的收起
  if (room.unoBadge && room.unoBadge.playerId !== player.id) room.unoBadge = null;

  // 买牌直接过回合：既然来买，说明手上没有能出的牌
  closeGrabWindow(room);
  // 四件商品全部卖光才自动补货，没卖完就一直空着，等玩家自己刷新
  if (room.shop.every(s => !s || s.sold)) {
    refillShop(room);
    addLog(room, '商店卖空了，重新上架 4 件商品');
  }
  advance(room);

  broadcastRoom(room);
  scheduleIfAuto(room);
  return true;
}

// 刷新商店：每个玩家每回合限一次，四件商品全部换掉。
// 从牌堆顶抽 4 张上架，刷新前的商品全部进弃牌堆。
function rerollShop(room, playerId) {
  if (!rulesOf(room).shop) return false;
  if (room.status !== 'playing' || room.paused) return false;
  if (!Array.isArray(room.shop)) return false;
  const player = room.players[room.currentIndex];
  if (!player || player.id !== playerId) return false;     // 只有当前回合的玩家能刷新
  if (room.wildPending || room.pendingDraw > 0) return false;  // 先处理选色/罚牌
  if (room.shopRerollUsed) return false;                   // 本回合已经刷过

  const old = room.shop.map(s => (s && s.card) ? s.card : null).filter(Boolean);
  // 先抽新货再扔旧货，避免牌堆见底时把刚扔掉的四张又直接洗回来
  const next = [];
  for (let i = 0; i < SHOP_SIZE; i++) next.push(makeShopSlot(room) || null);
  room.shop = next;
  if (old.length) room.discardPile.push(...old);   // 刷新前的商品进弃牌堆
  room.shopRerollUsed = true;

  addLog(room, `${player.name} 刷新了商店，${old.length} 件旧货进弃牌堆`);
  broadcastRoom(room);
  return true;
}

// 只剩 1 人时不该继续"单人打牌"：直接结束对局，等房主重开
// （离开/被踢都会走到这里，避免人走光了还卡在一个人的对局里）
function abortIfTooFewPlayers(room) {
  if (room.status === 'waiting' || room.status === 'over' || room.players.length >= 2) return false;
  room.status = 'over';
  stopTurnClock(room);   // 人走光了，回合计时停掉
  room.grabAvailable = null;
  room.pendingReport = null;
  room.wildPending = false;
  room.justDrew = false;
  room.pendingDraw = 0;
  room.pendingDrawType = null;
  room.unoBadge = null;
  room.paused = false;
  room.pausedBy = null;
  room.pausedById = null;
  addLog(room, '对手都离开了，本局结束');
  return true;
}

// 设置举报窗口（5 秒后自动失效，避免过时的举报按钮一直挂着）
function setPendingReport(room, player) {
  const report = { playerId: player.id, playerName: player.name };
  room.pendingReport = report;
  setTimeout(() => {
    if (room.status === 'playing' && room.pendingReport === report) {
      room.pendingReport = null;
      broadcastRoom(room);
    }
  }, 5000);
}

// 喊牌飘带：显示"这一个回合"，下一回合（下一张牌打出）自动消失；10 秒兜底防挂
function setUnoBadge(room, playerId) {
  if (!playerId) return;
  const badge = { playerId };
  room.unoBadge = badge;
  setTimeout(() => {
    if (room.unoBadge === badge) { room.unoBadge = null; broadcastRoom(room); }
  }, 10000);
}

function checkWin(room) {
  for (const p of room.players) {
    if (p.hand.length === 0 && !p.finished) {
      p.finished = true;
      p.rank = room.players.filter(x => x.finished).length;
      addLog(room, `🏆 ${p.name} 第 ${p.rank} 名！`);
    }
  }
  const remaining = room.players.filter(p => !p.finished);
  if (remaining.length <= 1 && room.status === 'playing') {
    room.status = 'over';
    stopTurnClock(room);   // 对局结束，回合计时不必再走
    // 对局结束：清掉所有挂起的抢牌/举报窗口，避免结束后按钮还亮着
    room.grabAvailable = null;
    room.pendingReport = null;
    room.justDrew = false;
    room.wildPending = false;
    room.unoBadge = null;   // 结束后不要再挂着喊牌飘带
    if (remaining.length === 1) {
      remaining[0].rank = room.players.filter(x => x.finished).length + 1;
      addLog(room, `🏆 ${remaining[0].name} 第 ${remaining[0].rank} 名！`);
    }
  }
}

function colorName(c) {
  return { red: '红', yellow: '黄', green: '绿', blue: '蓝' }[c] || c;
}

// ✅ 统一调度 AI 回合：turnSeq 作废旧回合的定时器，避免新回合里重复执行 aiTurn
function scheduleAiTurn(room, delay = AI_DELAY) {
  // 同一个回合已排过程序就不再排；回合切换后旧标记自动失效
  if (room.aiTurnPending && room.aiTurnSeq === room.turnSeq) return;
  const seq = room.turnSeq;
  room.aiTurnPending = true;
  room.aiTurnSeq = seq;
  setTimeout(() => {
    if (room.aiTurnSeq !== seq) return;   // 已被更新的排程或回合切换取代
    room.aiTurnPending = false;
    room.aiTurnSeq = null;
    if (room.status === 'playing' && !room.paused && isAutoPlayer(room.players[room.currentIndex])) {
      aiTurn(room);
    }
  }, delay);
}

// ==================== AI ====================

function aiTurn(room) {
  if (room.status !== 'playing' || room.paused) return;
  const player = room.players[room.currentIndex];
  if (!player || !isAutoPlayer(player)) return;

  // AI 举报：有玩家剩1张没喊有岁
  if (room.pendingReport) {
    const target = room.players.find(p => p.id === room.pendingReport.playerId);
    if (target) {
      addLog(room, `AI举报了 ${target.name} 没喊${rulesOf(room).unoWord}！罚摸2张`);
      target.hand.push(...drawCards(room, 2));
      room.pendingReport = null;
    }
  }

  if (room.wildPending) {
    const counts = {};
    for (const c of player.hand) {
      if (c.color !== 'none') counts[c.color] = (counts[c.color] || 0) + 1;
    }
    let best = 'red';
    for (const c in counts) if (counts[c] > (counts[best] || 0)) best = c;
    resolveWildColor(room, player.id, best);
    return;
  }

  const playable = [];
  for (let i = 0; i < player.hand.length; i++) {
    if (isPlayable(player.hand[i], room.topCard, room.currentColor, room.pendingDraw, room.pendingDrawType)) playable.push(i);
  }

  if (playable.length === 0) {
    // 有岁商店：出不了牌时先去商店逛逛（买一张指定的牌比随机摸一张划算）。
    // 商店操作放到定时器里做，给玩家留出看清"AI 在换牌"的时间，避免瞬间执行显得卡顿
    if (rulesOf(room).shop && room.pendingDraw === 0 && Array.isArray(room.shop)
        && room.shop.some(s => s && s.card)) {
      scheduleAiShopAction(room, player, () => aiShopVisit(room, player));
      return;
    }
    drawCard(room, player.id);
    return;
  }

  let bestIdx = -1;
  let bestScore = -1;
  for (const i of playable) {
    const c = player.hand[i];
    let score = 0;
    if (c.type === T.DRAW_TWO) score = 5;
    else if (c.type === T.SKIP) score = 4;
    else if (c.type === T.REVERSE) score = 3;
    else if (c.type === T.NUMBER) score = c.value;
    else score = 0;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }

  const card = player.hand[bestIdx];
  let chosenColor = null;
  if (isWild(card)) {
    const counts = {};
    for (const c of player.hand) {
      if (c.color !== 'none') counts[c.color] = (counts[c.color] || 0) + 1;
    }
    chosenColor = 'red';
    for (const c in counts) if (counts[c] > (counts[chosenColor] || 0)) chosenColor = c;
  }

  // AI 75%概率喊"有岁"（出牌后剩1张时）
  if (player.hand.length - 1 === 1 && Math.random() < 0.75) {
    room.unoCalled[player.id] = true;
    if (room.pendingReport && room.pendingReport.playerId === player.id) {
      room.pendingReport = null;
    }
  }

  playCard(room, player.id, bestIdx, chosenColor);
}

// ==================== AI 逛有岁商店 ====================
// 买牌会结束回合，所以 AI 只在"手上没有牌可出"时才来（否则白白浪费一次出牌机会）。
// 所有商店操作都走定时器，给玩家留出看清动作的时间，避免瞬间执行让对局看起来卡顿。
const AI_SHOP_PAUSE = 1000;     // 商店动作前的停顿（毫秒）
const AI_REROLL_CHANCE = 0.45;  // 没有值得买的商品时，刷新商店的概率
const AI_BUY_SCORE = 26;        // 净收益到这条线才值得买（买完这一回合就没了）

// AI 眼里一张牌值多少分：万能 / 加四最香，+2 次之，功能牌看情况，数字牌看同色搭配
function aiCardValue(card, hand) {
  let v;
  if (card.type === T.WILD_DRAW_FOUR) v = 100;
  else if (card.type === T.WILD) v = 82;
  else if (card.type === T.DRAW_TWO) v = 70;
  else if (card.type === T.SKIP || card.type === T.REVERSE) v = 46;
  else v = 10 + (card.value || 0);

  if (card.color !== 'none') {
    // 手上同色越多，这张越好打出去
    v += Math.min(hand.filter(c => c.color === card.color).length * 2, 10);
    // 手里已经有完全一样的牌：打出一张后能立刻抢出另一张（连打），价值陡增
    const dup = hand.filter(c => c.color === card.color && c.type === card.type && c.value === card.value).length;
    if (dup > 0) v += 30;
  }
  // 残局阶段万能牌更值钱
  if (isWild(card) && hand.length <= 4) v += 10;
  return v;
}

// 拿这张牌付款有多亏：同款（连打资源）最亏，罚牌 / 功能牌次之，数字牌按点数
function aiPayCost(card, hand) {
  let cost = 4 + (card.type === T.NUMBER ? (card.value || 0) : 0);
  if (card.type === T.SKIP || card.type === T.REVERSE) cost += 40;
  if (card.type === T.DRAW_TWO) cost += 60;
  const sameCount = hand.filter(c => c.color === card.color && c.type === card.type && c.value === card.value).length;
  if (sameCount > 1) cost += 30;   // 拆连打组合去付款很亏
  if (hand.filter(c => c.color === card.color).length <= 1) cost += 10;  // 这个颜色只剩这一张
  return cost;
}

// 找出最划算的一笔交易：商品价值 - 付款代价；没有任何能付得起的就返回 null
function aiBestPurchase(room, player) {
  if (!rulesOf(room).shop || !Array.isArray(room.shop)) return null;
  let best = null;
  room.shop.forEach((slot, slotIdx) => {
    if (!slot || slot.sold || !slot.card) return;
    const gain = aiCardValue(slot.card, player.hand);
    for (let payIndex = 0; payIndex < player.hand.length; payIndex++) {
      const pay = player.hand[payIndex];
      if (pay.color === 'none' || pay.color !== slot.priceColor) continue;  // 万能牌不能当货币
      const net = gain - aiPayCost(pay, player.hand);
      if (!best || net > best.net) best = { slot: slotIdx, payIndex, net };
    }
  });
  return best;
}

// AI 逛商店：有划算的就买（买完自动结束回合）；没有就按概率刷新一次再看；都不行才摸牌
function aiShopVisit(room, player) {
  const plan = aiBestPurchase(room, player);
  if (plan && plan.net >= AI_BUY_SCORE
      && buyShopCard(room, player.id, plan.slot, plan.payIndex)) return;

  // 完全没有付得起的商品 → 刷新概率更高；有能付但不够划算 → 刷新概率低一些
  const chance = plan ? AI_REROLL_CHANCE : Math.min(AI_REROLL_CHANCE + 0.25, 0.85);
  if (!room.shopRerollUsed && Math.random() < chance && rerollShop(room, player.id)) {
    // 刷新后再评估一次：中间留个停顿，别让两个操作挤在同一帧
    scheduleAiShopAction(room, player, () => aiShopVisit(room, player));
    return;
  }

  drawCard(room, player.id);
}

// 商店动作的定时器：回合没变、还是这个 AI、没暂停才执行（否则这一手作废，等重新排程）
// 同时占住本回合的"AI 行动槽"，避免这 1 秒里又被 scheduleAiTurn 排一次（会变成瞬间连动两下）
function scheduleAiShopAction(room, player, fn) {
  const seq = room.turnSeq;
  const pid = player.id;
  room.aiTurnPending = true;
  room.aiTurnSeq = seq;
  setTimeout(() => {
    // 先释放行动槽：fn 里买牌/摸牌会推进回合并重新排程
    if (room.aiTurnSeq === seq) { room.aiTurnPending = false; room.aiTurnSeq = null; }
    if (room.turnSeq !== seq) return;
    if (room.status !== 'playing' || room.paused) return;
    const cur = room.players[room.currentIndex];
    if (!cur || cur.id !== pid || !isAutoPlayer(cur)) return;
    fn();
  }, AI_SHOP_PAUSE);
}

// ==================== Socket 事件 ====================

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentPlayerId = null;

  socket.on('createRoom', ({ name, maxPlayers } = {}) => {
    name = safeStr(name).trim().slice(0, 12);
    if (!name) { socket.emit('errorMsg', '请输入名字'); return; }
    if (currentRoom) { socket.emit('errorMsg', '你已经在房间里了'); return; }
    maxPlayers = Math.min(Math.max(parseInt(maxPlayers) || 4, 2), 8);
    const room = createRoom(maxPlayers);
    const player = { id: socket.id + '_' + Date.now(), name: name, socketId: socket.id, isAI: false, hand: [], seatToken: newSeatToken() };
    room.players.push(player);
    room.ownerSocketId = socket.id;
    room.ownerPlayerId = player.id;
    currentRoom = room;
    currentPlayerId = player.id;
    console.log('创建房间:', room.code, 'maxPlayers:', room.maxPlayers, '房主:', player.name);
    socket.emit('roomCreated', { code: room.code, playerId: player.id, seatToken: player.seatToken });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ code, name } = {}) => {
    code = safeStr(code).toUpperCase().trim();
    name = safeStr(name).trim().slice(0, 12);
    if (!name) { socket.emit('errorMsg', '请输入名字'); return; }
    if (currentRoom) { socket.emit('errorMsg', '你已经在房间里了'); return; }
    const room = rooms.get(code);
    if (!room) { socket.emit('errorMsg', '房间不存在'); return; }

    // 开局后或人数已满 → 进观战席
    if (room.status !== 'waiting' || room.players.length >= room.maxPlayers) {
      while (room.spectators.length < 5) room.spectators.push(null);
      const emptyIdx = room.spectators.findIndex(s => !s);
      if (emptyIdx < 0) { socket.emit('errorMsg', '观战席已满'); return; }
      const sp = { id: socket.id + '_' + Date.now(), name: name, socketId: socket.id, seatToken: newSeatToken() };
      room.spectators[emptyIdx] = sp;
      currentRoom = room;
      currentPlayerId = sp.id;   // 记录观战者身份，否则退出时清不掉自己
      ensureOwner(room);         // 已定义于 L543：房间若没有有效房主，由新加入者接管
      addLog(room, `${name} 进入观战席`);
      socket.emit('roomJoined', { code: room.code, playerId: sp.id, spectator: true, seatToken: sp.seatToken });
      broadcastRoom(room);
      return;
    }

    const player = { id: socket.id + '_' + Date.now(), name: name, socketId: socket.id, isAI: false, hand: [], seatToken: newSeatToken() };
    room.players.push(player);
    currentRoom = room;
    currentPlayerId = player.id;
    ensureOwner(room);   // 已定义于 L543：房间若没有有效房主，由新加入者接管
    addLog(room, `${player.name} 加入房间`);
    socket.emit('roomJoined', { code: room.code, playerId: player.id, seatToken: player.seatToken });
    broadcastRoom(room);
  });

  socket.on('startGame', () => {
    const room = currentRoom;
    if (!room || room.status !== 'waiting' || !isRoomOwner(room, socket.id, currentPlayerId)) return;
    if (!room.mode) { socket.emit('errorMsg', '请先选择游戏模式'); return; }
    if (room.players.length < 2) { socket.emit('errorMsg', '至少需要2人（可加AI）'); return; }
    startGame(room);
  });

  // 房主在开局前选择游戏模式（目前两种模式规则一致，仅作标签与展示）
  socket.on('setMode', ({ mode } = {}) => {
    const room = currentRoom;
    if (!room || room.status !== 'waiting' || !isRoomOwner(room, socket.id, currentPlayerId)) return;
    if (!['normal', 'yousui'].includes(mode)) return;
    room.mode = mode;
    addLog(room, `游戏模式设为 ${mode === 'normal' ? '正常版 UNO' : '有岁 UNO'}`);
    broadcastRoom(room);
  });

  socket.on('restartGame', () => {
    const room = currentRoom;
    if (!room || !isRoomOwner(room, socket.id, currentPlayerId)) return;
    // 与 startGame 同样的前置校验，避免空房间/未选模式时进入 grabbing 僵尸状态
    if (!room.mode) { socket.emit('errorMsg', '请先选择游戏模式'); return; }
    if (room.players.length < 2) { socket.emit('errorMsg', '至少需要2人（可加AI）'); return; }
    for (const p of room.players) { p.finished = false; p.rank = null; }
    startGame(room);
  });

  socket.on('endGame', () => {
    const room = currentRoom;
    if (!room || !isRoomOwner(room, socket.id, currentPlayerId)) return;
    room.status = 'waiting';
    stopTurnClock(room);    // 回到等待区，回合计时停掉
    room.turnRemain = null;
    room.players.forEach(p => { p.hand = []; p.finished = false; p.rank = null; });
    room.drawPile = [];
    room.playPile = [];
    room.discardPile = [];
    room.topCard = null;
    room.pendingDraw = 0;
    room.pendingDrawType = null;
    room.wildPending = false;
    room.pendingReport = null;
    room.unoCalled = {};
    room.unoBadge = null;   // 回到房间时不要再残留喊牌飘带
    room.justDrew = false;
    room.aiTurnPending = false;
    room.aiTurnSeq = null;
    room.grabAvailable = null;
    room.shop = null;       // 结束对局回到房间：商店下架
    room.shopRerollUsed = false;
    room.paused = false;
    room.pausedBy = null;
    room.pausedById = null;
    addLog(room, '回到房间等待区');
    broadcastRoom(room);
  });

  socket.on('addAI', () => {
    const room = currentRoom;
    if (!room || room.status !== 'waiting' || !isRoomOwner(room, socket.id, currentPlayerId)) return;
    if (room.players.length >= room.maxPlayers) return;
    room.players.push({
      id: 'ai_' + Date.now() + '_' + Math.random(),
      name: 'AI-' + (room.players.length + 1),
      socketId: null, isAI: true, hand: []
    });
    broadcastRoom(room);
  });

  socket.on('removeAI', ({ id, index }) => {
    const room = currentRoom;
    if (!room || room.status !== 'waiting' || !isRoomOwner(room, socket.id, currentPlayerId)) return;
    // 优先按 id 定位，避免列表刷新后 index 错位
    let i = id ? room.players.findIndex(p => p.id === id) : -1;
    if (i < 0 && Number.isInteger(index) && room.players[index] && room.players[index].isAI) i = index;
    if (i >= 0 && room.players[i].isAI) {
      room.players.splice(i, 1);
      broadcastRoom(room);
    }
  });

  // 房主踢人（玩家或观战者）
  socket.on('kickPlayer', ({ playerId }) => {
    const room = currentRoom;
    if (!room || !isRoomOwner(room, socket.id, currentPlayerId)) return;
    if (playerId === currentPlayerId) return;  // 不能踢自己
    // 踢玩家
    const pIdx = room.players.findIndex(p => p.id === playerId);
    if (pIdx >= 0) {
      const kicked = room.players[pIdx];
      const wasCurrent = room.status === 'playing' && room.players[room.currentIndex] === kicked;
      room.players.splice(pIdx, 1);
      addLog(room, `房主踢出了 ${kicked.name}`);

      // 通知被踢的人回首页，否则他的界面会残留成"观战者"
      if (kicked.socketId) {
        const ks = io.sockets.sockets.get(kicked.socketId);
        if (ks) ks.emit('kicked', { reason: `你被房主踢出了房间` });
      }

      if (dropRoomIfAiOnly(room)) return;

      // 被踢的人正好是暂停发起者时，清掉暂停状态，避免全场永久卡在暂停
      if (room.pausedById === kicked.id) {
        room.paused = false;
        room.pausedBy = null;
        room.pausedById = null;
      }

      // 修正轮次指针：被踢者在当前位之前则整体前移
      if (room.status === 'playing') {
        if (pIdx < room.currentIndex) room.currentIndex -= 1;
        normalizeCurrentIndex(room);
        if (wasCurrent) {
          // 轮到的人被踢，下一个人顶上来
          room.justDrew = false;
          room.aiTurnPending = false;
          room.aiTurnSeq = null;
          closeGrabWindow(room);
          room.wildPending = false;  // 被踢者可能正在选色，不清会永久卡住
          room.pendingReport = null;
          room.pendingDraw = 0;      // 被踢者的罚牌不能留给下一个人
          room.pendingDrawType = null;
        }
      } else if (room.currentIndex >= room.players.length) {
        room.currentIndex = 0;
      }
      // 踢完只剩 1 人：结束对局，避免单人僵尸局
      abortIfTooFewPlayers(room);

      scheduleGrabLeadFallback(room);   // 抢先手阶段没人能点按钮时兜底开局
      refreshTurnClockAfterSeatChange(room, wasCurrent);   // 被踢的是当前玩家 → 下家重新计时
      broadcastRoom(room);
      scheduleIfAuto(room);
      return;
    }
    // 踢观战者
    const sIdx = (room.spectators || []).findIndex(s => s && s.id === playerId);
    if (sIdx >= 0) {
      const kicked = room.spectators[sIdx];
      room.spectators[sIdx] = null;
      addLog(room, `房主踢出观战者 ${kicked.name}`);
      // 观战席上的房主暂停后被踢，同样要清暂停状态
      if (room.pausedById === kicked.id) {
        room.paused = false;
        room.pausedBy = null;
        room.pausedById = null;
      }
      if (kicked.socketId) {
        const ks = io.sockets.sockets.get(kicked.socketId);
        if (ks) ks.emit('kicked', { reason: '你被房主踢出了观战席' });
      }
      refreshTurnClockAfterSeatChange(room, false);   // 暂停发起者被踢 → 计时按剩余时间继续
      broadcastRoom(room);
    }
  });

  socket.on('spectatorJoin', () => {
    const room = currentRoom;
    if (!room || room.status !== 'waiting') return;
    if (room.players.length >= room.maxPlayers) return;
    const idx = room.spectators.findIndex(s => s && s.socketId === socket.id);
    if (idx >= 0) {
      const sp = room.spectators[idx];
      room.spectators[idx] = null;
      const newPlayer = { id: sp.id, name: sp.name, socketId: socket.id, isAI: false, hand: [], seatToken: sp.seatToken || newSeatToken() };
      room.players.push(newPlayer);
      addLog(room, `${sp.name} 从观战席加入游戏`);
      currentPlayerId = sp.id;
      ensureOwner(room);   // 已定义于 L543，校正/兜底房主身份
      socket.emit('roomJoined', { code: room.code, playerId: sp.id, seatToken: newPlayer.seatToken });
      broadcastRoom(room);
    }
  });

  socket.on('moveSpectator', ({ index }) => {
    const room = currentRoom;
    if (!room || room.status !== 'waiting') return;
    const fromIdx = room.spectators.findIndex(s => s && s.socketId === socket.id);
    if (fromIdx < 0) return;
    if (!Number.isInteger(index) || index < 0 || index > 4) return;  // 非法索引会造出空槽位
    const toIdx = index;
    const temp = room.spectators[fromIdx];
    room.spectators[fromIdx] = room.spectators[toIdx];
    room.spectators[toIdx] = temp;
    broadcastRoom(room);
  });

  socket.on('becomeSpectator', ({ index } = {}) => {
    const room = currentRoom;
    if (!room || room.status !== 'waiting') return;
    const idx = room.players.findIndex(p => p.id === currentPlayerId);
    if (idx < 0) return;
    while (room.spectators.length < 5) room.spectators.push(null);
    // 先找到空位再移除玩家，避免观战席已满时玩家凭空消失
    let pos = Number.isInteger(index) && index >= 0 && index <= 4 ? index : 4;
    while (pos < 5 && room.spectators[pos]) pos++;
    if (pos >= 5) { socket.emit('errorMsg', '观战席已满'); return; }
    const p = room.players.splice(idx, 1)[0];
    const spId = 'sp_' + Date.now();
    // 换成观战身份后保留原令牌，刷新页面仍能认领回来
    const spToken = p.seatToken || newSeatToken();
    // 房主进观战席：房主身份要跟着新 id 走，否则回到玩家列表后就没有房主权限了
    if (isRoomOwner(room, socket.id, currentPlayerId)) {
      room.ownerPlayerId = spId;
      room.ownerSocketId = socket.id;
    }
    room.spectators[pos] = { id: spId, name: p.name, socketId: socket.id, seatToken: spToken };
    addLog(room, `${p.name} 进入观战席`);
    currentPlayerId = spId;
    ensureOwner(room);   // 已定义于 L543，校正/兜底房主身份
    // 告知前端新的身份 id：否则刷新后按旧 id 重连失败，会被当成新玩家
    socket.emit('roomJoined', { code: room.code, playerId: spId, spectator: true, seatToken: spToken });
    broadcastRoom(room);
  });

  // 观战席换位：点击别人头像 → 对方确认后交换位置
  socket.on('spectatorSwapRequest', ({ targetId }) => {
    const room = currentRoom;
    if (!room) return;
    // 找自己在观战席的位置
    const fromIdx = (room.spectators || []).findIndex(s => s && s.socketId === socket.id);
    if (fromIdx < 0) { socket.emit('errorMsg', '你不在观战席'); return; }
    // 找目标
    const toIdx = (room.spectators || []).findIndex(s => s && s.id === targetId);
    if (toIdx < 0) { socket.emit('errorMsg', '找不到对方'); return; }
    if (fromIdx === toIdx) return;
    const me = room.spectators[fromIdx];
    const target = room.spectators[toIdx];
    // 通知目标玩家弹确认
    const targetSocket = io.sockets.sockets.get(target.socketId);
    if (targetSocket) {
      targetSocket.emit('swapRequest', {
        fromName: me.name, fromId: me.id, toId: target.id, toName: target.name,
        fromIndex: fromIdx, toIndex: toIdx
      });
      addLog(room, `${me.name} 请求和 ${target.name} 换位`);
    }
  });

  socket.on('spectatorSwapConfirm', ({ accept, fromId, toId }) => {
    const room = currentRoom;
    if (!room) return;
    const fromIdx = (room.spectators || []).findIndex(s => s && s.id === fromId);
    const toIdx = (room.spectators || []).findIndex(s => s && s.id === toId);
    if (fromIdx < 0 || toIdx < 0) return;
    // 只有被请求的一方可以同意/拒绝
    if (room.spectators[toIdx].socketId !== socket.id) return;
    if (!accept) {
      addLog(room, `${room.spectators[toIdx].name} 拒绝了换位`);
      socket.emit('swapRequestResult', { accepted: false });
      return;
    }
    const temp = room.spectators[fromIdx];
    room.spectators[fromIdx] = room.spectators[toIdx];
    room.spectators[toIdx] = temp;
    addLog(room, `${room.spectators[toIdx].name} 和 ${room.spectators[fromIdx].name} 交换了位置`);
    socket.emit('swapRequestResult', { accepted: true });
    broadcastRoom(room);
  });

  socket.on('grabLead', () => {
    const room = currentRoom;
    if (!room || !rulesOf(room).grabLead) return;
    grabLead(room, currentPlayerId);
  });

  socket.on('pauseGame', () => {
    const room = currentRoom;
    if (!room || room.status !== 'playing' || room.paused) return;
    const me = room.players.find(p => p.id === currentPlayerId);
    const owner = isRoomOwner(room, socket.id, currentPlayerId);
    // 只有房主（含在观战席上的房主）或当前该出牌的玩家能暂停
    if (!owner && (!me || room.players[room.currentIndex]?.id !== currentPlayerId)) return;
    room.paused = true;
    room.pausedBy = me ? me.name : '房主';
    room.pausedById = currentPlayerId;
    // 清掉挂起的异步调度与抢牌窗口，恢复后重新建立
    // 注意：wildPending 是"等待选色"状态，不能清，否则这一手会卡死
    room.aiTurnPending = false;
    room.aiTurnSeq = null;
    closeGrabWindow(room);   // 暂停时关闭抢牌窗口，并作废旧回合的定时器
    stopTurnClock(room);     // 回合计时也停表，恢复后从剩余时间接着走
    room.turnSeq = (room.turnSeq || 0) + 1;
    addLog(room, `${room.pausedBy} 暂停了游戏`);
    broadcastRoom(room);
  });

  socket.on('resumeGame', () => {
    const room = currentRoom;
    if (!room || !room.paused) return;
    // 只有暂停的人或房主可以恢复
    if (room.pausedById !== currentPlayerId && !isRoomOwner(room, socket.id, currentPlayerId)) return;
    room.paused = false;
    room.pausedBy = null;
    room.pausedById = null;
    room.aiTurnPending = false;
    room.aiTurnSeq = null;
    room.turnSeq = (room.turnSeq || 0) + 1;   // 恢复后重新起排程，旧的定时器一律作废
    // 暂停期间停掉的回合计时从剩余时间继续
    startTurnClock(room, room.turnRemain || TURN_LIMIT);
    addLog(room, '游戏继续');
    broadcastRoom(room);
    scheduleIfAuto(room);
  });

  socket.on('leaveRoom', () => {
    const room = currentRoom;
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === currentPlayerId);
    let seatTurnChanged = false;
    if (idx >= 0) {
      const p = room.players[idx];
      const wasCurrent = room.status === 'playing' && room.currentIndex === idx;
      room.players.splice(idx, 1);
      addLog(room, `${p.name} 退出房间`);
      // 离开的人正好是暂停发起者时，清掉暂停状态，避免全场永久卡在暂停
      if (room.pausedById === p.id) {
        room.paused = false;
        room.pausedBy = null;
        room.pausedById = null;
      }
      // ✅ 如果退出的是房主 → 转移房主，不给 AI
      if (isRoomOwner(room, socket.id, currentPlayerId)) transferOwner(room, room.ownerSocketId);
      if (room.players.length > 0) {
        // 修正轮次指针，避免退出后 currentIndex 越界/跳人
        if (idx < room.currentIndex) room.currentIndex -= 1;
        normalizeCurrentIndex(room);
        if (wasCurrent) {
          room.justDrew = false;
          room.aiTurnPending = false;
          room.aiTurnSeq = null;
          closeGrabWindow(room);
          room.wildPending = false;
          room.pendingReport = null;
          room.pendingDraw = 0;
          room.pendingDrawType = null;
          room.shopRerollUsed = false;   // 换人接手这一回合，刷新次数跟着重置
          seatTurnChanged = true;        // 回合计时交给下一个人重新计时
        }
      }
    }
    // 有人走后只剩 1 人：结束对局，别让剩下的人独自打牌
    abortIfTooFewPlayers(room);
    const specIdx = (room.spectators || []).findIndex(s => s && s.id === currentPlayerId);
    if (specIdx >= 0) {
      const s = room.spectators[specIdx];
      room.spectators[specIdx] = null;
      addLog(room, `${s.name} 退出观战席`);
      // 观战席上的房主暂停后离开，同样要清暂停状态
      if (room.pausedById === s.id) {
        room.paused = false;
        room.pausedBy = null;
        room.pausedById = null;
      }
      if (isRoomOwner(room, socket.id, currentPlayerId)) transferOwner(room, room.ownerSocketId);
    }
    if (dropRoomIfAiOnly(room)) {
      currentRoom = null;
      currentPlayerId = null;
      return;
    }
    ensureOwner(room);   // 已定义于 L543：房主已离开且无人接管时兜底选人
    scheduleGrabLeadFallback(room);   // 抢先手阶段没人能点按钮时兜底开局
    refreshTurnClockAfterSeatChange(room, seatTurnChanged);   // 换人/解除暂停后计时接上
    broadcastRoom(room);
    scheduleIfAuto(room, AI_DELAY_EXTRA);
    currentRoom = null;
    currentPlayerId = null;
  });

  socket.on('playCard', ({ cardIndex, chosenColor }) => {
    if (currentRoom) playCard(currentRoom, currentPlayerId, cardIndex, chosenColor);
  });

  socket.on('grabCard', () => {
    if (currentRoom) grabCard(currentRoom, currentPlayerId);
  });

  socket.on('buyShopCard', ({ slot, payIndex } = {}) => {
    if (currentRoom) buyShopCard(currentRoom, currentPlayerId, slot, payIndex);
  });

  socket.on('rerollShop', () => {
    if (currentRoom) rerollShop(currentRoom, currentPlayerId);
  });

  socket.on('callUno', () => {
    const room = currentRoom;
    if (!room || room.status !== 'playing' || room.paused || !currentPlayerId) return;
    const me = room.players.find(p => p.id === currentPlayerId);
    // 只有手上正好 2 张（打完就剩 1 张）时才能喊，防止乱点刷状态
    if (!me || me.hand.length !== 2) return;
    // 只有轮到自己才能喊；抢牌窗口里作为候选（抢完就剩 1 张）也允许
    const isMyTurn = !!room.players[room.currentIndex] && room.players[room.currentIndex].id === currentPlayerId;
    const isGrabCandidate = !!(room.grabAvailable && room.grabAvailable.candidates.some(c => c.playerId === currentPlayerId));
    if (!isMyTurn && !isGrabCandidate) return;
    room.unoCalled[currentPlayerId] = !room.unoCalled[currentPlayerId];
    // 喊牌时不出飘带：只有真的打出牌、剩 1 张时（playCard / grabCard）才对外显示
    if (!room.unoCalled[currentPlayerId] && room.unoBadge && room.unoBadge.playerId === currentPlayerId) {
      room.unoBadge = null;
    }
    if (room.pendingReport && room.pendingReport.playerId === currentPlayerId) {
      room.pendingReport = null;
    }
    broadcastRoom(room);
  });

  socket.on('reportUno', () => {
    const room = currentRoom;
    if (!room || !room.pendingReport || room.status !== 'playing' || room.paused) return;
    // 只有坐在座位上的人才能举报，观战者不行
    if (!room.players.some(p => p.id === currentPlayerId)) return;
    // 不能举报自己
    if (room.pendingReport.playerId === currentPlayerId) return;
    const target = room.players.find(p => p.id === room.pendingReport.playerId);
    if (target) {
      const drawn = drawCards(room, 2);
      target.hand.push(...drawn);
      addLog(room, `举报成功！${target.name} 被罚摸2张`);
    }
    room.pendingReport = null;
    broadcastRoom(room);
  });

  socket.on('chooseColor', ({ color }) => {
    if (currentRoom) resolveWildColor(currentRoom, currentPlayerId, color);
  });

  socket.on('drawCard', () => {
    if (currentRoom) drawCard(currentRoom, currentPlayerId);
  });

  socket.on('skipTurn', () => {
    const room = currentRoom;
    if (!room || room.status !== 'playing' || room.paused || !room.justDrew) return;
    const player = room.players[room.currentIndex];
    if (!player || player.id !== currentPlayerId) return;
    // 用统一的关闭函数：既关窗口，也作废候选人在窗口里"提前喊"的标记
    // （不能先把 grabAvailable 置空，否则 closeGrabWindow 拿不到候选名单，提前喊的标记会留到之后的回合）
    closeGrabWindow(room);
    room.justDrew = false;
    advance(room);
    room.unoBadge = null;   // 换到下一位玩家，飘带消失
    broadcastRoom(room);
    scheduleIfAuto(room);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = currentRoom;

    const specIdx = (room.spectators || []).findIndex(s => s && s.socketId === socket.id);
    const p = room.players.find(x => x.id === currentPlayerId);

    // 玩家已被新连接接管（刷新页面时新 socket 先完成 reconnect）→ 忽略这条过期断开
    if (p && p.socketId !== socket.id) return;

    // 观战者掉线：延迟几秒再清位，给刷新重连留时间
    if (specIdx >= 0 && !p) {
      const sp = room.spectators[specIdx];
      if (isRoomOwner(room, socket.id, currentPlayerId)) {
        setTimeout(() => {
          if (rooms.get(room.code) !== room) return;
          const still = room.spectators[specIdx];
          if (still && still.id === sp.id && still.socketId === socket.id) {
            transferOwner(room, room.ownerSocketId);
            broadcastRoom(room);
          }
        }, 6000);
      }
      setTimeout(() => {
        if (rooms.get(room.code) !== room) return;
        const still = room.spectators[specIdx];
        if (still && still.id === sp.id && still.socketId === socket.id) {
          room.spectators[specIdx] = null;
          addLog(room, `${sp.name} 掉线，退出观战席`);
          broadcastRoom(room);
        }
      }, 6000);
      return;
    }

    if (p) {
      p.socketId = null;
      p.offline = true;
      // 离线后由 AI 代理出牌，游戏不会卡住（抢开局阶段也算）
      p.aiProxy = room.status === 'playing' || room.status === 'grabbing';
      addLog(room, p.aiProxy ? `${p.name} 掉线，由 AI 代理` : `${p.name} 掉线，等待重连`);
      const wasOwner = isRoomOwner(room, socket.id, currentPlayerId);

      // ✅ 房主掉线 → 稍等 4 秒再转移（刷新页面能抢回来），期间重连则不转移
      if (wasOwner) {
        const ownerSocketId = room.ownerSocketId;
        setTimeout(() => {
          if (rooms.get(room.code) !== room) return;
          if (room.ownerPlayerId !== p.id) return;   // 已经不是他的房主
          if (p.socketId) return;                    // 已重连
          // 没有可接管的玩家时保留房主身份，等原房主重连后直接接管
          if (!pickNextOwner(room)) return;
          transferOwner(room, ownerSocketId);
          broadcastRoom(room);
        }, 4000);
      }

      // ✅ 掉线清理：只有掉线者正好是当前回合玩家时才清 justDrew；AI 排程交给 turnSeq 机制作废
      const cur = room.players[room.currentIndex];
      if (cur && cur.id === p.id) room.justDrew = false;

      // ✅ 所有人离线 → 延迟清理，避免"刷新页面"时把房间删掉
      const checkEmpty = () => {
        if (rooms.get(room.code) !== room) return;
        const allOffline = room.players.every(x => x.offline || !x.socketId);
        const hasOnlineSpectator = (room.spectators || []).some(s => s && s.socketId);
        if (allOffline && !hasOnlineSpectator) {
          addLog(room, '所有人离线，清理房间');
          rooms.delete(room.code);
        }
      };
      if (room.players.every(x => x.offline || !x.socketId)) setTimeout(checkEmpty, 6000);

      scheduleGrabLeadFallback(room);   // 抢先手阶段没人能点按钮时兜底开局
      broadcastRoom(room);
      // 若正好轮到掉线玩家，立即交给 AI 代理行动
      scheduleIfAuto(room, AI_DELAY_EXTRA);
    } else if (specIdx >= 0) {
      broadcastRoom(room);
    }
  });

  socket.on('reconnect', ({ playerId, seatToken } = {}) => {
    playerId = safeStr(playerId);
    seatToken = safeStr(seatToken);
    if (!playerId) return;
    // 座位令牌校验：有令牌的座位必须出示正确令牌，防止拿别人公开的 playerId 顶号
    // 旧版本会话（座位上还没有令牌）允许降级认领一次，并顺手补发令牌
    const seatAllowed = (seat) => {
      if (!seat.seatToken) { seat.seatToken = newSeatToken(); return true; }
      return seat.seatToken === seatToken;
    };
    for (const room of rooms.values()) {
      const p = room.players.find(p => p.id === playerId);
      if (p) {
        if (!seatAllowed(p)) { socket.emit('reconnectFailed'); return; }
        // 座位已被另一条活跃连接占用时拒绝认领，避免两个页面同时控制一个人
        if (p.socketId && p.socketId !== socket.id && io.sockets.sockets.get(p.socketId)) {
          socket.emit('reconnectFailed');
          return;
        }
        p.socketId = socket.id;
        p.offline = false;
        p.aiProxy = false;  // 玩家回来后立即取消 AI 代理
        // 掉线期间回合计时一直在走：如果正轮到他，人回来了就重新计一次时
        if (room.status === 'playing' && !room.paused
            && room.players[room.currentIndex] && room.players[room.currentIndex].id === p.id) {
          startTurnClock(room);
        }
        // 房主换了 socket 也要保住房主身份；房间暂时无房主时由重连者接管
        if (room.ownerPlayerId === p.id || !room.ownerPlayerId) {
          room.ownerPlayerId = p.id;
          room.ownerSocketId = socket.id;
        }
        currentRoom = room;
        currentPlayerId = playerId;
        addLog(room, `${p.name} 重连回来`);
        broadcastRoom(room);
        socket.emit('reconnected', { ...publicRoomState(room, p), seatToken: p.seatToken });
        return;
      }
      // 观战者刷新页面也要认领回自己的观战位，否则会变成新观众
      const sp = (room.spectators || []).find(s => s && s.id === playerId);
      if (sp) {
        if (!seatAllowed(sp)) { socket.emit('reconnectFailed'); return; }
        if (sp.socketId && sp.socketId !== socket.id && io.sockets.sockets.get(sp.socketId)) {
          socket.emit('reconnectFailed');
          return;
        }
        sp.socketId = socket.id;
        if (room.ownerPlayerId === sp.id) room.ownerSocketId = socket.id;
        currentRoom = room;
        currentPlayerId = sp.id;
        addLog(room, `${sp.name} 重连回来`);
        broadcastRoom(room);
        socket.emit('reconnected', { ...publicRoomState(room, sp), seatToken: sp.seatToken });
        return;
      }
    }
    socket.emit('reconnectFailed');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO 服务器已启动: http://localhost:${PORT}`);
});
