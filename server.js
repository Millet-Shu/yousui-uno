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
  if (pendingDraw > 0) {
    // +4正在生效，只能出+4
    if (pendingDrawType === T.WILD_DRAW_FOUR) {
      return c.type === T.WILD_DRAW_FOUR;
    }
    // +2正在生效，可以出+2或+4
    if (pendingDrawType === T.DRAW_TWO) {
      return c.type === T.DRAW_TWO || c.type === T.WILD_DRAW_FOUR;
    }
  }
  if (isWild(c)) return true;
  if (c.color === currentColor) return true;
  // 数字牌：同数字不同色也能出
  if (c.type === T.NUMBER && topCard.type === T.NUMBER && c.value === topCard.value) return true;
  // 动作牌：同类型不同色也能出（红⊘接蓝⊘，红⇄接黄⇄）
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

const rooms = new Map(); // code -> room

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(maxPlayers = 4) {
  const code = genRoomCode();
  rooms.set(code, {
    code,
    maxPlayers,
    players: [],        // {id, name, socketId, isAI, hand: []}
    spectators: [],     // 观战席
    drawPile: [],
    discardPile: [],
    topCard: null,
    currentColor: 'red',
    currentIndex: 0,
    direction: 1,
    pendingDraw: 0,
    status: 'waiting',
    wildPending: false,
    unoCalled: {}, // playerId -> true，谁喊了有岁
    pendingReport: null, // { playerId } 可以被举报
    log: []
  });
  return rooms.get(code);
}

function broadcastRoom(room) {
  // 给玩家发
  for (const p of room.players) {
    if (p.isAI) continue;
    const socket = io.sockets.sockets.get(p.socketId);
    if (socket) socket.emit('roomUpdate', publicRoomState(room, p));
  }
  // 给观战者发
  for (const s of (room.spectators || [])) {
    const socket = io.sockets.sockets.get(s.socketId);
    if (socket) socket.emit('roomUpdate', publicRoomState(room, s));
  }
}

// 给客户端的状态：每人只看到自己的手牌，其他人只看手牌数
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
    spectators: (room.spectators || []).map(s => ({ name: s.name, isYou: s.id === selfId })),
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
      // 回收弃牌堆（除顶牌）
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
  room.status = 'grabbing'; // 抢先手阶段
  room.drawPile = shuffle(createDeck());
  room.discardPile = [];
  room.topCard = null;

  for (const p of room.players) { p.hand = []; p.finished = false; p.rank = null; p.unoCalled = false; }

  // 每人 7 张
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
  room.wildPending = false;
  room.log = [];

  addLog(room, `游戏开始！抢"有岁"先手！`);
  broadcastRoom(room);

  // AI 自动抢先手
  setTimeout(() => {
    if (room.status !== 'grabbing') return;
    const ai = room.players.find(p => p.isAI);
    if (ai) grabLead(room, ai.id);
  }, 2000);
}

// 抢先手
function grabLead(room, playerId) {
  if (room.status !== 'grabbing') return;
  room.currentIndex = room.players.findIndex(p => p.id === playerId);
  if (room.currentIndex < 0) return;

  // 翻起始牌
  let starter = room.drawPile.pop();
  // 如果是万能牌，洗回去重翻
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

  // 起始牌是加牌，加给先手
  if (starter.type === T.DRAW_TWO) {
    room.pendingDraw += 2;
    room.pendingDrawType = T.DRAW_TWO;
    const drawn = drawCards(room, 2);
    room.players[room.currentIndex].hand.push(...drawn);
    addLog(room, `${room.players[room.currentIndex].name} 起始罚摸2张`);
    room.pendingDraw = 0;
  } else if (starter.type === T.WILD_DRAW_FOUR) {
    const drawn = drawCards(room, 4);
    room.players[room.currentIndex].hand.push(...drawn);
    addLog(room, `${room.players[room.currentIndex].name} 起始罚摸4张`);
  }

  // 起始牌是禁止/反转，应用效果
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
  if (next && next.isAI) {
    setTimeout(() => aiTurn(room), 1000);
  }
}

// 出牌（cardIndex 为玩家手牌中的下标）
function playCard(room, playerId, cardIndex, chosenColor = null) {
  if (room.status !== 'playing' || room.paused) return;
  const player = room.players[room.currentIndex];
  if (!player || player.id !== playerId) return;
  if (room.wildPending) {
    // 正在等选颜色
    resolveWildColor(room, playerId, chosenColor);
    return;
  }

  const card = player.hand[cardIndex];
  if (!card) return;
  if (!isPlayable(card, room.topCard, room.currentColor, room.pendingDraw, room.pendingDrawType)) return;

  player.hand.splice(cardIndex, 1);
  room.discardPile.push(card);
  room.topCard = card;

  // 没喊有岁就出到剩<=1张，可以被举报（游戏进行中才行）
  if (room.status === 'playing' && player.hand.length <= 1 && !room.unoCalled[player.id]) {
    room.pendingReport = { playerId: player.id, playerName: player.name };
  } else {
    room.pendingReport = null;
  }

  // 出完牌后才显示喊了有岁
  if (room.unoCalled[player.id] && player.hand.length <= 2) {
    addLog(room, `${player.name} 喊了"有岁"`);
    room.unoCalled[player.id] = false; // 出完牌重置
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

  // 在等选颜色时不继续
  if (room.wildPending) { broadcastRoom(room); return; }

  // 当前玩家如果没有+2/+4可叠加，自动摸罚牌
  checkPendingDraw(room);

  broadcastRoom(room);

  const next = room.players[room.currentIndex];
  if (next && next.isAI && room.status === 'playing') {
    setTimeout(() => aiTurn(room), 1000);
  }
}

// 检查当前玩家是否需要自动摸罚牌（手里没有+2/+4时）
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

  checkPendingDraw(room);
  broadcastRoom(room);

  const next = room.players[room.currentIndex];
  if (next && next.isAI && room.status === 'playing') {
    setTimeout(() => aiTurn(room), 1000);
  }
}

function drawCard(room, playerId) {
  if (room.status !== 'playing' || room.paused) return;
  const player = room.players[room.currentIndex];
  if (!player || player.id !== playerId) return;
  if (room.wildPending) return;

  // 有罚牌要摸：摸完跳过回合
  if (room.pendingDraw > 0) {
    const drawn = drawCards(room, room.pendingDraw);
    player.hand.push(...drawn);
    addLog(room, `${player.name} 被罚摸了 ${room.pendingDraw} 张牌`);
    room.pendingDraw = 0;
    room.pendingDrawType = null;
    advance(room);
    broadcastRoom(room);
    const next = room.players[room.currentIndex];
    if (next && next.isAI && room.status === 'playing') {
      setTimeout(() => aiTurn(room), 1000);
    }
    return;
  }

  const drawn = drawCards(room, 1);
  if (drawn.length > 0) {
    player.hand.push(drawn[0]);
    addLog(room, `${player.name} 摸了一张牌`);
  }
  // 不自动出牌，轮到下一个人
  advance(room);
  broadcastRoom(room);

  const next = room.players[room.currentIndex];
  if (next && next.isAI && room.status === 'playing') {
    setTimeout(() => aiTurn(room), 1000);
  }
}

function advance(room) {
  let next = nextIndex(room, 1);
  let guard = 0;
  while (room.players[next] && room.players[next].finished && guard < room.players.length) {
    next = nextIndex(room, 1, next);
    guard++;
  }
  room.currentIndex = next;
}

function checkWin(room) {
  for (const p of room.players) {
    if (p.hand.length === 0 && !p.finished) {
      p.finished = true;
      p.rank = room.players.filter(x => x.finished).length;
      addLog(room, `🏆 ${p.name} 第 ${p.rank} 名！`);
    }
  }
  // 只剩一个未完成玩家，游戏结束
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

// ==================== AI ====================

function aiTurn(room) {
  if (room.status !== 'playing' || room.paused) return;
  const player = room.players[room.currentIndex];
  if (!player || !player.isAI) return;

  if (room.wildPending) {
    // AI 选颜色：手牌最多的颜色
    const counts = {};
    for (const c of player.hand) {
      if (c.color !== 'none') counts[c.color] = (counts[c.color] || 0) + 1;
    }
    let best = 'red';
    for (const c in counts) if (counts[c] > (counts[best] || 0)) best = c;
    resolveWildColor(room, player.id, best);
    return;
  }

  // 找可出的牌
  const playable = [];
  for (let i = 0; i < player.hand.length; i++) {
    if (isPlayable(player.hand[i], room.topCard, room.currentColor, room.pendingDraw, room.pendingDrawType)) playable.push(i);
  }

  if (playable.length === 0) {
    drawCard(room, player.id);
    return;
  }

  // 策略：优先动作牌，然后大数字，万能最后
  let bestIdx = -1;
  let bestScore = -1;
  for (const i of playable) {
    const c = player.hand[i];
    let score = 0;
    if (c.type === T.DRAW_TWO) score = 5;
    else if (c.type === T.SKIP) score = 4;
    else if (c.type === T.REVERSE) score = 3;
    else if (c.type === T.NUMBER) score = c.value;
    else score = 0; // 万能最后
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }

  const card = player.hand[bestIdx];
  let chosenColor = null;
  if (isWild(card)) {
    // AI 选最多颜色
    const counts = {};
    for (const c of player.hand) {
      if (c.color !== 'none') counts[c.color] = (counts[c.color] || 0) + 1;
    }
    chosenColor = 'red';
    for (const c in counts) if (counts[c] > (counts[chosenColor] || 0)) chosenColor = c;
  }
  playCard(room, player.id, bestIdx, chosenColor);
}

// ==================== Socket 事件 ====================

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentPlayerId = null;

  socket.on('createRoom', ({ name, maxPlayers }) => {
    name = (name || '').trim();
    if (!name) { socket.emit('errorMsg', '请输入名字'); return; }
    maxPlayers = Math.min(Math.max(parseInt(maxPlayers) || 4, 2), 8);
    const room = createRoom(maxPlayers);
    const player = { id: socket.id + '_' + Date.now(), name: name, socketId: socket.id, isAI: false, hand: [] };
    room.players.push(player);
    currentRoom = room;
    currentPlayerId = player.id;
    socket.emit('roomCreated', { code: room.code, playerId: player.id });
    broadcastRoom(room);
  });

  socket.on('joinRoom', ({ code, name }) => {
    code = (code || '').toUpperCase().trim();
    name = (name || '').trim();
    if (!name) { socket.emit('errorMsg', '请输入名字'); return; }
    const room = rooms.get(code);
    if (!room) { socket.emit('errorMsg', '房间不存在'); return; }
    if (room.status !== 'waiting') { socket.emit('errorMsg', '游戏已开始'); return; }

    if (room.players.length >= room.maxPlayers) {
      // 进观战席（最多5人）
      if (room.spectators.length >= 5) { socket.emit('errorMsg', '观战席已满'); return; }
      room.spectators.push({ id: socket.id + '_' + Date.now(), name: name, socketId: socket.id });
      currentRoom = room;
      currentPlayerId = null;
      addLog(room, `${name} 进入观战席`);
      socket.emit('roomJoined', { code: room.code, playerId: null, spectator: true });
      io.emit('roomUpdate', {
        code: room.code,
        players: room.players.map(p => ({ name: p.name, isAI: p.isAI })),
        spectators: room.spectators.map(s => s.name),
        maxPlayers: room.maxPlayers
      });
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
    if (!room) return;
    if (room.players.length < 2) { socket.emit('errorMsg', '至少需要2人（可加AI）'); return; }
    startGame(room);
  });

  socket.on('restartGame', () => {
    const room = currentRoom;
    if (!room) return;
    // 清理已完赛状态，重新开始
    for (const p of room.players) { p.finished = false; p.rank = null; }
    startGame(room);
  });

  socket.on('endGame', () => {
    const room = currentRoom;
    if (!room) return;
    room.status = 'waiting';
    room.players.forEach(p => { p.hand = []; p.finished = false; p.rank = null; });
    room.drawPile = [];
    room.discardPile = [];
    room.topCard = null;
    room.pendingDraw = 0;
    room.wildPending = false;
    room.pendingReport = null;
    room.unoCalled = {};
    addLog(room, '回到房间等待区');
    broadcastRoom(room);
  });

  socket.on('addAI', () => {
    const room = currentRoom;
    if (!room || room.status !== 'waiting') return;
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

  // 观战席玩家加入游戏
  socket.on('spectatorJoin', () => {
    const room = currentRoom;
    if (!room || room.status !== 'waiting') return;
    if (room.players.length >= room.maxPlayers) return;
    const idx = room.spectators.findIndex(s => s.socketId === socket.id);
    if (idx >= 0) {
      const sp = room.spectators.splice(idx, 1)[0];
      const newPlayer = { id: sp.id, name: sp.name, socketId: socket.id, isAI: false, hand: [] };
      room.players.push(newPlayer);
      addLog(room, `${sp.name} 从观战席加入游戏`);
      currentPlayerId = sp.id;
      socket.emit('roomJoined', { code: room.code, playerId: sp.id });
      broadcastRoom(room);
    }
  });

  // 玩家主动进入观战席（可选择座位）
  socket.on('becomeSpectator', ({ index } = {}) => {
    const room = currentRoom;
    if (!room || room.status !== 'waiting') return;
    const idx = room.players.findIndex(p => p.id === currentPlayerId);
    if (idx >= 0) {
      const p = room.players.splice(idx, 1)[0];
      const spId = 'sp_' + Date.now();
      const sp = { id: spId, name: p.name, socketId: socket.id };
      // 插入到指定位置，没传索引就加到最后
      const insertAt = Math.min(index ?? room.spectators.length, 4);
      room.spectators.splice(insertAt, 0, sp);
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
    addLog(room, '游戏继续');
    broadcastRoom(room);
    // 继续AI回合
    const next = room.players[room.currentIndex];
    if (next && next.isAI) setTimeout(() => aiTurn(room), 1000);
  });

  socket.on('leaveRoom', () => {
    const room = currentRoom;
    if (!room) return;
    const idx = room.players.findIndex(p => p.id === currentPlayerId);
    if (idx >= 0) {
      const p = room.players[idx];
      room.players.splice(idx, 1);
      addLog(room, `${p.name} 退出房间`);
      if (room.players.length === 0) rooms.delete(room.code);
      broadcastRoom(room);
    }
  });

  socket.on('playCard', ({ cardIndex, chosenColor }) => {
    if (currentRoom) playCard(currentRoom, currentPlayerId, cardIndex, chosenColor);
  });

  socket.on('callUno', () => {
    if (currentRoom && currentPlayerId) {
      currentRoom.unoCalled[currentPlayerId] = !currentRoom.unoCalled[currentPlayerId];
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

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = currentRoom;
    const p = room.players.find(p => p.id === currentPlayerId);
    if (p) {
      p.socketId = null;
      p.offline = true;
      addLog(room, `${p.name} 掉线，等待重连`);
      broadcastRoom(room);
    }
  });

  // 重连
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
    // 找不到房间，清除重连状态
    socket.emit('reconnectFailed');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO 服务器已启动: http://localhost:${PORT}`);
});
