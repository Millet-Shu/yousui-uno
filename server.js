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
    if (p.isAI) continue;
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
    spectators: (room.spectators || []).slice(0, 5).map(s => s ? { name: s.name, isYou: s.id === selfId, isOwner: s.socketId === room.ownerSocketId } : null),
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

  for (const p of room.players) { p.hand = []; p.finished = false; p.rank = null; p.unoCalled = false; }

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
  room.log = [];

  addLog(room, `游戏开始！抢"有岁"先手！`);
  broadcastRoom(room);

  setTimeout(() => {
    if (room.status !== 'grabbing') return;
    const ai = room.players.find(p => p.isAI);
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
  if (next && next.isAI) scheduleAiTurn(room);
}

function playCard(room, playerId, cardIndex, chosenColor = null) {
  if (room.status !== 'playing' || room.paused) return;
  const player = room.players[room.currentIndex];
  if (!player || player.id !== playerId) return;
  if (room.wildPending) {
    resolveWildColor(room, playerId, chosenColor);
    return;
  }

  const card = player.hand[cardIndex];
  if (!card) return;
  if (!isPlayable(card, room.topCard, room.currentColor, room.pendingDraw, room.pendingDrawType)) return;

  const myUnoCalled = !!room.unoCalled[player.id];
  for (const pid in room.unoCalled) {
    room.unoCalled[pid] = false;
  }

  player.hand.splice(cardIndex, 1);
  room.discardPile.push(card);
  room.topCard = card;
  room.justDrew = false;

  // 没喊有岁就出到剩 1 张 → 可以被举报
  if (room.status === 'playing' && player.hand.length === 1 && !myUnoCalled) {
    room.pendingReport = { playerId: player.id, playerName: player.name };
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
      if (chosenColor) {
        room.currentColor = chosenColor;
        addLog(room, `${player.name} 指定颜色 ${colorName(chosenColor)}`);
        advance(room);
      } else {
        room.wildPending = true;
      }
      break;
    case T.WILD_DRAW_FOUR:
      room.pendingDraw += 4;
      room.pendingDrawType = T.WILD_DRAW_FOUR;
      if (chosenColor) {
        room.currentColor = chosenColor;
        addLog(room, `${player.name} 指定颜色 ${colorName(chosenColor)}`);
        advance(room);
      } else {
        room.wildPending = true;
      }
      break;
  }

  checkWin(room);
  if (room.status === 'over') { broadcastRoom(room); return; }

  if (room.wildPending) { broadcastRoom(room); return; }

  // 检查谁可以抢牌：手上有和刚打出的牌完全一样的牌（包括刚打出的人自己，可以连出）
  room.grabAvailable = null;
  const lastCard = room.topCard;
  const candidates = [];
  for (const p of room.players) {
    if (p.finished) continue;  // 只排除已经打完的
    const idx = p.hand.findIndex(c =>
      c.color === lastCard.color && c.type === lastCard.type && c.value === lastCard.value
    );
    if (idx >= 0) candidates.push({ playerId: p.id, cardIndex: idx });
  }
  if (candidates.length > 0) {
    room.grabAvailable = { card: lastCard, playedBy: player.name, candidates };
    // AI 自动抢牌
    for (const cand of candidates) {
      const p = room.players.find(x => x.id === cand.playerId);
      if (p && p.isAI) {
        setTimeout(() => {
          if (room.grabAvailable && room.grabAvailable.candidates.some(c => c.playerId === p.id)) {
            grabCard(room, p.id);
          }
        }, 700 + Math.random() * 900);
      }
    }
    // 抢牌窗口 3 秒超时自动关闭，防止没人抢时卡住游戏
    setTimeout(() => {
      if (room.grabAvailable && room.grabAvailable.candidates === candidates) {
        room.grabAvailable = null;
        broadcastRoom(room);
        const cur = room.players[room.currentIndex];
        if (cur && cur.isAI && room.status === 'playing' && !room.paused) scheduleAiTurn(room);
      }
    }, 3000);
  }

  broadcastRoom(room);

  const next = room.players[room.currentIndex];
  if (next && next.isAI && room.status === 'playing' && !room.grabAvailable) scheduleAiTurn(room);
}

// 检查当前玩家是否可以叠加罚牌（手里有 +2/+4 时自动让过，让他们选择出 or 摸）
// 这个函数保留但改为仅用于 checkPendingDraw 后的状态确认，实际逻辑已在 drawCard 中处理
function checkPendingDraw(room) {
  if (room.pendingDraw <= 0) return;
  const player = room.players[room.currentIndex];
  if (!player) return;
  const canStack = player.hand.some(c => c.type === T.DRAW_TWO || c.type === T.WILD_DRAW_FOUR);
  if (!canStack) {
    const drawn = drawCards(room, room.pendingDraw);
    player.hand.push(...drawn);
    addLog(room, `${player.name} 摸了 ${drawn.length} 张`);
    room.pendingDraw = 0;
    room.pendingDrawType = null;   // ✅ 之前没清
  }
}

function resolveWildColor(room, playerId, color) {
  const player = room.players[room.currentIndex];
  if (!player || player.id !== playerId) return;
  room.currentColor = color;
  room.wildPending = false;
  addLog(room, `${player.name} 指定颜色 ${colorName(color)}`);
  advance(room);

  checkWin(room);
  if (room.status === 'over') { broadcastRoom(room); return; }

  broadcastRoom(room);

  const next = room.players[room.currentIndex];
  if (next && next.isAI && room.status === 'playing') scheduleAiTurn(room);
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
    const next = room.players[room.currentIndex];
    if (next && next.isAI && room.status === 'playing') scheduleAiTurn(room);
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

  const next = room.players[room.currentIndex];
  if (next && next.isAI && room.status === 'playing') scheduleAiTurn(room);
}

function advance(room) {
  let next = nextIndex(room, 1);
  let guard = 0;
  while (room.players[next] && room.players[next].finished && guard < room.players.length) {
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

  addLog(room, `⚡ ${grabber.name} 抢出了 ${cardName(card)}！`);

  // UNO 喊牌逻辑与 playCard 保持一致
  const myUnoCalled = !!room.unoCalled[grabber.id];
  for (const pid in room.unoCalled) {
    room.unoCalled[pid] = false;
  }

  grabber.hand.splice(cand.cardIndex, 1);
  room.discardPile.push(card);
  room.topCard = card;
  room.justDrew = false;

  // 抢出后剩 1 张且没喊有岁 → 可被举报
  if (grabber.hand.length === 1 && !myUnoCalled) {
    room.pendingReport = { playerId: grabber.id, playerName: grabber.name };
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
    if (room.status === 'playing' && !room.paused && room.players[room.currentIndex]?.isAI) {
      aiTurn(room);
    }
  }, delay);
}

// ==================== AI ====================

function aiTurn(room) {
  if (room.status !== 'playing' || room.paused) return;
  const player = room.players[room.currentIndex];
  if (!player || !player.isAI) return;

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
    const room = rooms.get(code);
    if (!room) { socket.emit('errorMsg', '房间不存在'); return; }

    if (room.status !== 'waiting') {
      while (room.spectators.length < 5) room.spectators.push(null);
      const emptyIdx = room.spectators.findIndex(s => !s);
      if (emptyIdx < 0) { socket.emit('errorMsg', '观战席已满'); return; }
      room.spectators[emptyIdx] = { id: socket.id + '_' + Date.now(), name: name, socketId: socket.id };
      currentRoom = room;
      currentPlayerId = null;
      addLog(room, `${name} 进入观战席`);
      socket.emit('roomJoined', { code: room.code, playerId: null, spectator: true });
      broadcastRoom(room);
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      while (room.spectators.length < 5) room.spectators.push(null);
      const emptyIdx = room.spectators.findIndex(s => !s);
      if (emptyIdx < 0) { socket.emit('errorMsg', '观战席已满'); return; }
      room.spectators[emptyIdx] = { id: socket.id + '_' + Date.now(), name: name, socketId: socket.id };
      currentRoom = room;
      currentPlayerId = null;
      addLog(room, `${name} 进入观战席`);
      socket.emit('roomJoined', { code: room.code, playerId: null, spectator: true });
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

  socket.on('removeAI', ({ index }) => {
    const room = currentRoom;
    if (!room || room.status !== 'waiting') return;
    if (room.players[index] && room.players[index].isAI) {
      room.players.splice(index, 1);
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
    if (idx >= 0) {
      const p = room.players.splice(idx, 1)[0];
      const spId = 'sp_' + Date.now();
      const sp = { id: spId, name: p.name, socketId: socket.id };
      while (room.spectators.length < 5) room.spectators.push(null);
      const insertAt = Math.min(Math.max(index ?? 4, 0), 4);
      let pos = insertAt;
      while (pos < 5 && room.spectators[pos]) pos++;
      if (pos >= 5) return;
      room.spectators[pos] = sp;
      addLog(room, `${p.name} 进入观战席`);
      currentPlayerId = spId;
      broadcastRoom(room);
    }
  });

  socket.on('grabLead', () => {
    if (currentRoom) grabLead(currentRoom, currentPlayerId);
  });

  socket.on('pauseGame', () => {
    const room = currentRoom;
    if (!room || room.status !== 'playing') return;
    const p = room.players.find(p => p.id === currentPlayerId);
    if (p) {
      room.paused = true;
      room.pausedBy = p.name;
      addLog(room, `${p.name} 暂停了游戏`);
      broadcastRoom(room);
    }
  });

  socket.on('resumeGame', () => {
    const room = currentRoom;
    if (!room) return;
    room.paused = false;
    room.pausedBy = null;
    room.aiTurnPending = false;  // ✅ 解锁 AI 调度
    addLog(room, '游戏继续');
    broadcastRoom(room);
    const next = room.players[room.currentIndex];
    if (next && next.isAI) scheduleAiTurn(room);
  });

  socket.on('leaveRoom', () => {
    const room = currentRoom;
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === currentPlayerId);
    if (idx >= 0) {
      const p = room.players[idx];
      room.players.splice(idx, 1);
      addLog(room, `${p.name} 退出房间`);
      // ✅ 如果退出的是房主 → 转移房主
      if (socket.id === room.ownerSocketId) {
        const nextOwner = room.players.find(x => !x.isAI);
        if (nextOwner) {
          room.ownerSocketId = nextOwner.socketId;
          addLog(room, `房主转移给 ${nextOwner.name}`);
        }
      }
    }
    const specIdx = (room.spectators || []).findIndex(s => s && s.id === currentPlayerId);
    if (specIdx >= 0) {
      const s = room.spectators[specIdx];
      room.spectators[specIdx] = null;
      addLog(room, `${s.name} 退出观战席`);
    }
    if (room.players.length === 0) rooms.delete(room.code);
    broadcastRoom(room);
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
    if (currentRoom && currentPlayerId) {
      currentRoom.unoCalled[currentPlayerId] = !currentRoom.unoCalled[currentPlayerId];
      if (currentRoom.pendingReport && currentRoom.pendingReport.playerId === currentPlayerId) {
        currentRoom.pendingReport = null;
      }
      broadcastRoom(currentRoom);
    }
  });

  socket.on('reportUno', () => {
    if (!currentRoom || !currentRoom.pendingReport || currentRoom.status !== 'playing') return;
    const target = currentRoom.players.find(p => p.id === currentRoom.pendingReport.playerId);
    if (target) {
      const drawn = drawCards(currentRoom, 2);
      target.hand.push(...drawn);
      addLog(currentRoom, `举报成功！${target.name} 被罚摸2张`);
    }
    currentRoom.pendingReport = null;
    broadcastRoom(currentRoom);
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
    const next = room.players[room.currentIndex];
    if (next && next.isAI && room.status === 'playing') scheduleAiTurn(room);
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = currentRoom;
    const isOwner = socket.id === room.ownerSocketId;
    const p = room.players.find(p => p.id === currentPlayerId);
    if (p) {
      p.socketId = null;
      p.offline = true;
      addLog(room, `${p.name} 掉线，等待重连`);

      // ✅ 房主掉线 → 转移房主
      if (isOwner) {
        const nextOwner = room.players.find(x => x.socketId && !x.offline);
        if (nextOwner) {
          room.ownerSocketId = nextOwner.socketId;
          addLog(room, `房主转移给 ${nextOwner.name}`);
        }
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
    }
  });

  socket.on('reconnect', ({ playerId }) => {
    if (!playerId) return;
    for (const room of rooms.values()) {
      const p = room.players.find(p => p.id === playerId);
      if (p) {
        p.socketId = socket.id;
        p.offline = false;
        currentRoom = room;
        currentPlayerId = playerId;
        addLog(room, `${p.name} 重连回来`);
        broadcastRoom(room);
        socket.emit('reconnected', publicRoomState(room, p));
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
