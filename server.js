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
    wildPending: false,
    unoCalled: {},
    pendingReport: null,
    justDrew: false,             // ✅ 之前没初始化
    aiTurnPending: false,        // ✅ AI 去重保护
    paused: false,
    pausedBy: null,
    grabAvailable: null,  // 可以抢牌的状态 { card, playedBy }
    log: []
  });
  return rooms.get(code);
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
      isOwner: p.id === room.ownerSocketId || p.socketId === room.ownerSocketId,
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
    isPausedByYou: room.pausedBy === (selfPlayer ? selfPlayer.name : ''),
    pendingReport: room.pendingReport,
    myUnoCalled: selfId ? !!room.unoCalled[selfId] : false,
    drawPileCount: room.drawPile.length,
    maxPlayers: room.maxPlayers,
    justDrew: !!room.justDrew,
    isOwner: selfPlayer && selfPlayer.socketId === room.ownerSocketId,
    grabAvailable: (() => {
      if (!room.grabAvailable || !selfId) return null;
      const me = room.grabAvailable.candidates.find(c => c.playerId === selfId);
      if (!me) return null;
      return { card: room.grabAvailable.card, playedBy: room.grabAvailable.playedBy, cardIndex: me.cardIndex };
    })(),
    spectators: (room.spectators || []).slice(0, 5).map(s => s ? { id: s.id, name: s.name, isYou: s.id === selfId, isOwner: s.socketId === room.ownerSocketId } : null),
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
  room.status = 'grabbing';
  room.drawPile = shuffle(createDeck());
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
  room.grabAvailable = null;    // ✅ 重开时清理抢牌窗口
  room.paused = false;          // ✅ 重开时不能在暂停状态
  room.pausedBy = null;
  room.pendingReport = null;
  room.unoCalled = {};
  room.log = [];

  addLog(room, `游戏开始！抢"有岁"先手！`);
  broadcastRoom(room);

  setTimeout(() => {
    if (room.status !== 'grabbing') return;
    const ai = room.players.find(p => isAutoPlayer(p));
    if (ai) grabLead(room, ai.id);
  }, 2000);
}

function grabLead(room, playerId) {
  if (room.status !== 'grabbing') return;
  room.currentIndex = room.players.findIndex(p => p.id === playerId);
  if (room.currentIndex < 0) return;

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
    addLog(room, `起始反转，方向反转`);
    advance(room);
  }

  broadcastRoom(room);

  const next = room.players[room.currentIndex];
  if (next && isAutoPlayer(next)) scheduleIfAuto(room);
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
  room.grabAvailable = null;  // 有人已行动，抢牌窗口关闭

  const myUnoCalled = !!room.unoCalled[player.id];
  for (const pid in room.unoCalled) {
    room.unoCalled[pid] = false;
  }

  player.hand.splice(cardIndex, 1);
  room.discardPile.push(card);
  room.topCard = card;
  room.justDrew = false;

  // 没喊有岁就出到剩 1 张 → 可以被举报（5 秒内有效）
  if (room.status === 'playing' && player.hand.length === 1 && !myUnoCalled) {
    setPendingReport(room, player);
  } else {
    room.pendingReport = null;
  }

  // ✅ 修复：UNO 必须打完剩 <=1 张才算数（之前错写成 <=2）
  if (myUnoCalled && player.hand.length <= 1) {
    addLog(room, `${player.name} 喊了"有岁"`);
    room.unoCalled[player.id] = true;
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
    case T.SKIP:
      room.currentColor = card.color;
      advance(room);
      advance(room);
      addLog(room, `${room.players[room.currentIndex].name} 被跳过`);
      break;
    case T.REVERSE:
      room.currentColor = card.color;
      room.direction *= -1;
      addLog(room, `方向反转`);
      advance(room);
      break;
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

// 打开抢牌窗口：手上有和顶牌完全相同的牌即可抢（含出牌者自己，可连出）
function openGrabWindow(room, playedBy) {
  room.grabAvailable = null;
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
        }, 700 + Math.random() * 900);
      }
    }
    // 3 秒内没人抢就自动关闭，防止卡住游戏
    setTimeout(() => {
      if (room.grabAvailable && room.grabAvailable.candidates === candidates) {
        room.grabAvailable = null;
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
  // 选色完成，之前举报窗口不再适用（下一玩家即将行动）
  room.pendingReport = null;
  addLog(room, `${player.name} 指定颜色 ${colorName(color)}`);
  advance(room);

  checkWin(room);
  if (room.status === 'over') { broadcastRoom(room); return; }

  openGrabWindow(room, player);
}

// 打开抢牌窗口：手上有和顶牌完全相同的牌即可抢（含出牌者自己，可连出）
function openGrabWindow(room, playedBy) {
  room.grabAvailable = null;
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
        }, 700 + Math.random() * 900);
      }
    }
    // 3 秒内没人抢就自动关闭，防止卡住游戏
    setTimeout(() => {
      if (room.grabAvailable && room.grabAvailable.candidates === candidates) {
        room.grabAvailable = null;
        broadcastRoom(room);
        scheduleIfAuto(room);
      }
    }, 3000);
  }

  broadcastRoom(room);
  if (!room.grabAvailable) scheduleIfAuto(room);
}

function drawCard(room, playerId) {
  if (room.status !== 'playing' || room.paused) return;
  const player = room.players[room.currentIndex];
  if (!player || player.id !== playerId) return;
  if (room.wildPending) return;
  room.grabAvailable = null;  // 当前玩家已行动，抢牌窗口关闭

  // 有罚牌要摸
  if (room.pendingDraw > 0) {
    const drawn = drawCards(room, room.pendingDraw);
    player.hand.push(...drawn);
    addLog(room, `${player.name} 被罚摸了 ${room.pendingDraw} 张牌`);
    room.pendingDraw = 0;
    room.pendingDrawType = null;   // ✅ 清零
    room.justDrew = false;
    advance(room);
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
    }
  } else {
    advance(room);
  }
  broadcastRoom(room);

  scheduleIfAuto(room);
}

// 是否由 AI 代为行动：真正的 AI，或离线被 AI 代理的玩家
function isAutoPlayer(p) {
  return !!(p && (p.isAI || p.aiProxy));
}

// 轮到某人时，若该玩家由 AI 行动则调度 AI 回合
function scheduleIfAuto(room, delay = 1000) {
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
    addLog(room, `房主转移给 ${next.name}`);
  } else {
    room.ownerSocketId = null;
    addLog(room, '房主离开，暂无可接管的玩家');
  }
}

function advance(room) {
  const n = room.players.length;
  if (n === 0) return;
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
  for (const pid in room.unoCalled) {
    room.unoCalled[pid] = false;
  }

  grabber.hand.splice(cand.cardIndex, 1);
  room.discardPile.push(card);
  room.topCard = card;
  room.justDrew = false;

  // 抢出后剩 1 张且没喊有岁 → 可被举报（5 秒内有效）
  if (grabber.hand.length === 1 && !myUnoCalled) {
    setPendingReport(room, grabber);
  } else {
    room.pendingReport = null;
  }
  if (myUnoCalled && grabber.hand.length <= 1) {
    addLog(room, `${grabber.name} 喊了"有岁"`);
    room.unoCalled[grabber.id] = true;
  }

  // 抢出 +2/+4：之前累加的罚牌数清零，之后重新按这张牌累加为 2 或 4
  room.pendingDraw = 0;
  room.pendingDrawType = null;

  // 轮到抢牌者，由 handleCardEffect 从这里推进到抢牌者的下家
  room.currentIndex = grabberIdx;
  room.grabAvailable = null;

  // 重新处理牌效；万能牌让抢牌者自己选颜色（wildPending 流程）
  handleCardEffect(room, grabber, card, null);
  // 抢到的是万能牌且抢牌者是 AI（含离线代理）时，需要立刻替它选色，否则会卡在选色
  if (room.wildPending && isAutoPlayer(room.players[room.currentIndex])) scheduleIfAuto(room, 800);
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
    if (remaining.length === 1) {
      remaining[0].rank = room.players.filter(x => x.finished).length + 1;
      addLog(room, `🏆 ${remaining[0].name} 第 ${remaining[0].rank} 名！`);
    }
  }
}

function colorName(c) {
  return { red: '红', yellow: '黄', green: '绿', blue: '蓝' }[c] || c;
}

// ✅ 统一调度 AI 回合，防止 setTimeout 堆叠
function scheduleAiTurn(room, delay = 1000) {
  if (room.aiTurnPending) return;
  room.aiTurnPending = true;
  setTimeout(() => {
    room.aiTurnPending = false;
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
      addLog(room, `AI举报了 ${target.name} 没喊有岁！罚摸2张`);
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

  socket.on('createRoom', ({ name, maxPlayers, mode }) => {
    name = (name || '').trim();
    if (!name) { socket.emit('errorMsg', '请输入名字'); return; }
    if (currentRoom) { socket.emit('errorMsg', '你已经在房间里了'); return; }
    if (mode === 'yousui') { socket.emit('errorMsg', '有岁模式还在开发中，敬请期待！'); return; }
    maxPlayers = Math.min(Math.max(parseInt(maxPlayers) || 4, 2), 8);
    const room = createRoom(maxPlayers);
    room.mode = mode || 'uno';
    const player = { id: socket.id + '_' + Date.now(), name: name, socketId: socket.id, isAI: false, hand: [] };
    room.players.push(player);
    room.ownerSocketId = socket.id;
    currentRoom = room;
    currentPlayerId = player.id;
    console.log('创建房间:', room.code, 'maxPlayers:', room.maxPlayers, '房主:', player.name);
    socket.emit('roomCreated', { code: room.code, playerId: player.id });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    name = (name || '').trim();
    if (!name) { socket.emit('errorMsg', '请输入名字'); return; }
    if (currentRoom) { socket.emit('errorMsg', '你已经在房间里了'); return; }
    const room = rooms.get(code);
    if (!room) { socket.emit('errorMsg', '房间不存在'); return; }

    // 开局后或人数已满 → 进观战席
    if (room.status !== 'waiting' || room.players.length >= room.maxPlayers) {
      while (room.spectators.length < 5) room.spectators.push(null);
      const emptyIdx = room.spectators.findIndex(s => !s);
      if (emptyIdx < 0) { socket.emit('errorMsg', '观战席已满'); return; }
      const sp = { id: socket.id + '_' + Date.now(), name: name, socketId: socket.id };
      room.spectators[emptyIdx] = sp;
      currentRoom = room;
      currentPlayerId = sp.id;   // 记录观战者身份，否则退出时清不掉自己
      addLog(room, `${name} 进入观战席`);
      socket.emit('roomJoined', { code: room.code, playerId: sp.id, spectator: true });
      broadcastRoom(room);
      return;
    }

    const player = { id: socket.id + '_' + Date.now(), name: name, socketId: socket.id, isAI: false, hand: [] };
    room.players.push(player);
    currentRoom = room;
    currentPlayerId = player.id;
    addLog(room, `${player.name} 加入房间`);
    socket.emit('roomJoined', { code: room.code, playerId: player.id });
    broadcastRoom(room);
  });

  socket.on('startGame', () => {
    const room = currentRoom;
    if (!room || socket.id !== room.ownerSocketId) return;
    if (room.players.length < 2) { socket.emit('errorMsg', '至少需要2人（可加AI）'); return; }
    startGame(room);
  });

  socket.on('restartGame', () => {
    const room = currentRoom;
    if (!room || socket.id !== room.ownerSocketId) return;
    for (const p of room.players) { p.finished = false; p.rank = null; }
    startGame(room);
  });

  socket.on('endGame', () => {
    const room = currentRoom;
    if (!room || socket.id !== room.ownerSocketId) return;
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
    room.justDrew = false;
    room.aiTurnPending = false;
    room.grabAvailable = null;
    room.paused = false;
    room.pausedBy = null;
    addLog(room, '回到房间等待区');
    broadcastRoom(room);
  });

  socket.on('addAI', () => {
    const room = currentRoom;
    if (!room || room.status !== 'waiting' || socket.id !== room.ownerSocketId) return;
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
    if (!room || room.status !== 'waiting' || socket.id !== room.ownerSocketId) return;
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
    if (!room || socket.id !== room.ownerSocketId) return;
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

      if (room.players.length === 0) { rooms.delete(room.code); return; }

      // 修正轮次指针：被踢者在当前位之前则整体前移
      if (room.status === 'playing') {
        if (pIdx < room.currentIndex) room.currentIndex -= 1;
        const n = room.players.length;
        room.currentIndex = ((room.currentIndex % n) + n) % n;
        if (wasCurrent) {
          // 轮到的人被踢，下一个人顶上来
          room.justDrew = false;
          room.aiTurnPending = false;
          room.grabAvailable = null;
          room.wildPending = false;  // 被踢者可能正在选色，不清会永久卡住
          room.pendingReport = null;
        }
      } else if (room.currentIndex >= room.players.length) {
        room.currentIndex = 0;
      }

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
      const newPlayer = { id: sp.id, name: sp.name, socketId: socket.id, isAI: false, hand: [] };
      room.players.push(newPlayer);
      addLog(room, `${sp.name} 从观战席加入游戏`);
      currentPlayerId = sp.id;
      socket.emit('roomJoined', { code: room.code, playerId: sp.id });
      broadcastRoom(room);
    }
  });

  socket.on('moveSpectator', ({ index }) => {
    const room = currentRoom;
    if (!room || room.status !== 'waiting') return;
    const fromIdx = room.spectators.findIndex(s => s && s.socketId === socket.id);
    if (fromIdx < 0) return;
    const toIdx = Math.max(0, Math.min(index, 4));
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
    let pos = Math.min(Math.max(index ?? 4, 0), 4);
    while (pos < 5 && room.spectators[pos]) pos++;
    if (pos >= 5) { socket.emit('errorMsg', '观战席已满'); return; }
    const p = room.players.splice(idx, 1)[0];
    const spId = 'sp_' + Date.now();
    room.spectators[pos] = { id: spId, name: p.name, socketId: socket.id };
    addLog(room, `${p.name} 进入观战席`);
    currentPlayerId = spId;
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
    addLog(room, `${temp.name} 和 ${room.spectators[fromIdx].name} 交换了位置`);
    socket.emit('swapRequestResult', { accepted: true });
    broadcastRoom(room);
  });

  socket.on('grabLead', () => {
    if (currentRoom) grabLead(currentRoom, currentPlayerId);
  });

  socket.on('pauseGame', () => {
    const room = currentRoom;
    if (!room || room.status !== 'playing' || room.paused) return;
    const me = room.players.find(p => p.id === currentPlayerId);
    if (!me) return;
    // 只有房主或当前该出牌的玩家能暂停，避免多人乱点
    if (socket.id !== room.ownerSocketId && room.players[room.currentIndex]?.id !== currentPlayerId) return;
    room.paused = true;
    room.pausedBy = me.name;
    // 清掉挂起的异步调度与抢牌窗口，恢复后重新建立
    // 注意：wildPending 是"等待选色"状态，不能清，否则这一手会卡死
    room.aiTurnPending = false;
    room.grabAvailable = null;
    addLog(room, `${me.name} 暂停了游戏`);
    broadcastRoom(room);
  });

  socket.on('resumeGame', () => {
    const room = currentRoom;
    if (!room || !room.paused) return;
    // 只有暂停的人或房主可以恢复
    const me = room.players.find(p => p.id === currentPlayerId);
    if (!me || (room.pausedBy !== me.name && socket.id !== room.ownerSocketId)) return;
    room.paused = false;
    room.pausedBy = null;
    room.aiTurnPending = false;
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
      // ✅ 如果退出的是房主 → 转移房主，不给 AI
      if (socket.id === room.ownerSocketId) transferOwner(room, socket.id);
      if (room.players.length > 0) {
        // 修正轮次指针，避免退出后 currentIndex 越界/跳人
        if (idx < room.currentIndex) room.currentIndex -= 1;
        const n = room.players.length;
        room.currentIndex = ((room.currentIndex % n) + n) % n;
        if (wasCurrent) {
          room.justDrew = false;
          room.aiTurnPending = false;
          room.grabAvailable = null;
          room.wildPending = false;
          room.pendingReport = null;
        }
      }
    }
    const specIdx = (room.spectators || []).findIndex(s => s && s.id === currentPlayerId);
    if (specIdx >= 0) {
      const s = room.spectators[specIdx];
      room.spectators[specIdx] = null;
      addLog(room, `${s.name} 退出观战席`);
      if (socket.id === room.ownerSocketId) transferOwner(room, socket.id);
    }
    if (room.players.length === 0) rooms.delete(room.code);
    else {
      broadcastRoom(room);
      scheduleIfAuto(room, 800);
    }
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
    if (!room || room.status !== 'playing' || !currentPlayerId) return;
    const me = room.players.find(p => p.id === currentPlayerId);
    // 只有手牌 ≤2 张时喊"有岁"才有意义，防止乱点刷状态
    if (!me || me.hand.length > 2) return;
    room.unoCalled[currentPlayerId] = !room.unoCalled[currentPlayerId];
    if (room.pendingReport && room.pendingReport.playerId === currentPlayerId) {
      room.pendingReport = null;
    }
    broadcastRoom(room);
  });

  socket.on('reportUno', () => {
    const room = currentRoom;
    if (!room || !room.pendingReport || room.status !== 'playing') return;
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
    if (!room || room.status !== 'playing' || !room.justDrew) return;
    const player = room.players[room.currentIndex];
    if (!player || player.id !== currentPlayerId) return;
    room.grabAvailable = null;  // 当前玩家已行动，抢牌窗口关闭
    room.justDrew = false;
    advance(room);
    broadcastRoom(room);
    scheduleIfAuto(room);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = currentRoom;

    // 同时清理观战席残留（手机关页面直接 disconnect 时会走到这里）
    const specIdx = (room.spectators || []).findIndex(s => s && s.socketId === socket.id);
    if (specIdx >= 0) {
      const s = room.spectators[specIdx];
      room.spectators[specIdx] = null;
      addLog(room, `${s.name} 掉线，退出观战席`);
    }

    const isOwner = socket.id === room.ownerSocketId;
    const p = room.players.find(p => p.id === currentPlayerId);
    if (p) {
      p.socketId = null;
      p.offline = true;
      // 离线后由 AI 代理出牌，游戏不会卡住（抢开局阶段也算）
      p.aiProxy = room.status === 'playing' || room.status === 'grabbing';
      addLog(room, p.aiProxy ? `${p.name} 掉线，由 AI 代理` : `${p.name} 掉线，等待重连`);

      // ✅ 房主掉线 → 稍等 4 秒再转移（刷新页面能抢回来），期间重连则不转移
      if (isOwner) {
        const ownerSocketId = socket.id;
        setTimeout(() => {
          if (rooms.get(room.code) !== room) return;
          if (room.players.some(x => x.socketId === ownerSocketId)) return;  // 已重连
          transferOwner(room, ownerSocketId);
          broadcastRoom(room);
        }, 4000);
      }

      // ✅ 掉线清理状态，下家能继续
      room.justDrew = false;
      room.aiTurnPending = false;

      // ✅ 如果房间只剩离线玩家 → 清理
      const allOffline = room.players.every(x => x.offline || !x.socketId);
      const hasOnlineSpectator = (room.spectators || []).some(s => s && s.socketId);
      if (allOffline && !hasOnlineSpectator) {
        addLog(room, '所有人离线，清理房间');
        rooms.delete(room.code);
        return;
      }

      broadcastRoom(room);
      // 若正好轮到掉线玩家，立即交给 AI 代理行动
      scheduleIfAuto(room, 800);
    } else if (specIdx >= 0) {
      // 掉线的是观战者：若他正好是房主，也要转移
      if (isOwner) transferOwner(room, socket.id);
      broadcastRoom(room);
    }
  });

  socket.on('reconnect', ({ playerId }) => {
    if (!playerId) return;
    for (const room of rooms.values()) {
      const p = room.players.find(p => p.id === playerId);
      if (p) {
        p.socketId = socket.id;
        p.offline = false;
        p.aiProxy = false;  // 玩家回来后立即取消 AI 代理
        currentRoom = room;
        currentPlayerId = playerId;
        addLog(room, `${p.name} 重连回来`);
        broadcastRoom(room);
        socket.emit('reconnected', publicRoomState(room, p));
        return;
      }
      // 观战者刷新页面也要认领回自己的观战位，否则会变成新观众
      const sp = (room.spectators || []).find(s => s && s.id === playerId);
      if (sp) {
        sp.socketId = socket.id;
        currentRoom = room;
        currentPlayerId = sp.id;
        addLog(room, `${sp.name} 重连回来`);
        broadcastRoom(room);
        socket.emit('reconnected', publicRoomState(room, sp));
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
