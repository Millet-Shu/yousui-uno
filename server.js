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
  },
  yousui: {
    label: '有岁 UNO',
    unoWord: '有岁',
    buildDeck: () => createDeck(),   // 有岁专属牌后续在这里额外 push
    grabLead: true,
    grabExchange: true,
  },
};

// 取房间对应模式的规则；模式缺失时按正常版处理
function rulesOf(room) {
  return MODE_RULES[room && room.mode] || MODE_RULES.normal;
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
    discardPile: [],
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
    gameId: 0,                   // 局次：每次开局自增，避免上一局的抢先手定时器串到新局
    paused: false,
    pausedBy: null,
    pausedById: null,
    grabAvailable: null,  // 可以抢牌的状态 { card, playedBy }
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
    isPausedByYou: room.pausedById ? room.pausedById === selfId : room.pausedBy === (selfPlayer ? selfPlayer.name : ''),
    pendingReport: room.pendingReport,
    myUnoCalled: selfId ? !!room.unoCalled[selfId] : false,
    drawPileCount: room.drawPile.length,
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
    if (room.drawPile.length === 0) {
      if (room.discardPile.length <= 1) break;
      const top = room.discardPile.pop();
      room.drawPile = shuffle(room.discardPile);
      room.discardPile = [top];
    }
    if (room.drawPile.length === 0) break;
    out.push(room.drawPile.pop());
  }
  return out;
}

function startGame(room) {
  const rules = rulesOf(room);
  room.status = 'grabbing';
  room.gameId = (room.gameId || 0) + 1;   // 新的一局：旧局的早起手定时器作废
  room.turnSeq = (room.turnSeq || 0) + 1; // 新的一局：旧的回合定时器作废
  room.drawPile = shuffle(rules.buildDeck());
  room.discardPile = [];
  room.topCard = null;

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
  let guard = 0;
  while (starter && isWild(starter) && guard < 20) {
    room.drawPile.unshift(starter);
    starter = room.drawPile.pop();
    guard++;
  }

  room.discardPile.push(starter);
  room.topCard = starter;
  room.currentColor = starter.color;
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
  room.discardPile.push(card);
  room.topCard = card;
  room.justDrew = false;

  // 没喊有岁就出到剩 1 张 → 可以被举报（5 秒内有效）
  if (room.status === 'playing' && player.hand.length === 1 && !myUnoCalled) {
    setPendingReport(room, player);
  } else if (room.pendingReport && room.pendingReport.playerId === player.id) {
    // 只有被举报者本人出牌才撤销举报窗口，别人出牌不影响
    room.pendingReport = null;
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

  if (room.wildPending) { broadcastRoom(room); return; }

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
    room.grabAvailable = { card: lastCard, playedBy: playedBy.name, candidates };
    // AI（含离线代理）自动抢牌
    for (const cand of candidates) {
      const p = room.players.find(x => x.id === cand.playerId);
      if (p && isAutoPlayer(p)) {
        setTimeout(() => {
          if (room.grabAvailable && room.grabAvailable.candidates.some(c => c.playerId === p.id)) {
            grabCard(room, p.id);
          }
        }, 1000 + Math.random() * 900);
      }
    }
    // 3 秒内没人抢就自动关闭，防止卡住游戏
    setTimeout(() => {
      if (room.grabAvailable && room.grabAvailable.candidates === candidates) {
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
  room.discardPile.push(card);
  room.topCard = card;
  room.justDrew = false;

  // 抢出后剩 1 张且没喊有岁 → 可被举报（5 秒内有效）
  if (grabber.hand.length === 1 && !myUnoCalled) {
    setPendingReport(room, grabber);
  } else if (room.pendingReport && room.pendingReport.playerId === grabber.id) {
    // 只撤销自己的举报窗口，不能顺手清掉别人的
    room.pendingReport = null;
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

// 只剩 1 人时不该继续"单人打牌"：直接结束对局，等房主重开
// （离开/被踢都会走到这里，避免人走光了还卡在一个人的对局里）
function abortIfTooFewPlayers(room) {
  if (room.status === 'waiting' || room.status === 'over' || room.players.length >= 2) return false;
  room.status = 'over';
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
    room.players.forEach(p => { p.hand = []; p.finished = false; p.rank = null; });
    room.drawPile = [];
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
    addLog(room, '游戏继续');
    broadcastRoom(room);
    scheduleIfAuto(room);
  });

  socket.on('leaveRoom', () => {
    const room = currentRoom;
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === currentPlayerId);
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
    room.grabAvailable = null;  // 当前玩家已行动，抢牌窗口关闭
    // 用统一的关闭函数，顺手作废候选人在窗口里"提前喊"的标记
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
