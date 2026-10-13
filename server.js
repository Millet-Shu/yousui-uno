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

function isPlayable(c, topCard, currentColor, pendingDraw) {
  // 有叠加罚牌时，只有+2/+4能出
  if (pendingDraw > 0) {
    return c.type === T.DRAW_TWO || c.type === T.WILD_DRAW_FOUR;
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

function createRoom() {
  const code = genRoomCode();
  rooms.set(code, {
    code,
    players: [],        // {id, name, socketId, isAI, hand: []}
    drawPile: [],
    discardPile: [],
    topCard: null,
    currentColor: 'red',
    currentIndex: 0,
    direction: 1,
    pendingDraw: 0,
    status: 'waiting', // waiting | playing | over
    wildPending: false, // 出了万能牌等选颜色
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
}

// 给客户端的状态：每人只看到自己的手牌，其他人只看手牌数
function publicRoomState(room, selfPlayer) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map(p => ({
      id: p.id,
      name: p.name,
      isAI: p.isAI,
      handCount: p.hand.length,
      isYou: p.id === selfPlayer.id,
      isCurrent: room.players[room.currentIndex] && room.players[room.currentIndex].id === p.id
    })),
    topCard: room.topCard,
    currentColor: room.currentColor,
    yourHand: selfPlayer.hand,
    currentPlayerName: room.players[room.currentIndex] ? room.players[room.currentIndex].name : '',
    direction: room.direction,
    pendingDraw: room.pendingDraw,
    wildPending: room.wildPending,
    log: room.log.slice(-20)
  };
}

function addLog(room, msg) {
  room.log.push(msg);
  console.log(`[${room.code}] ${msg}`);
}

function nextIndex(room, offset = 1) {
  const n = room.players.length;
  return (room.currentIndex + room.direction * offset + n) % n;
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
  room.status = 'playing';
  room.drawPile = shuffle(createDeck());
  room.discardPile = [];

  for (const p of room.players) p.hand = [];

  // 每人 7 张
  for (let i = 0; i < 7; i++) {
    for (const p of room.players) {
      const c = room.drawPile.pop();
      if (c) p.hand.push(c);
    }
  }

  // 翻起始牌（数字牌为止）
  let starter;
  do {
    starter = room.drawPile.pop();
  } while (starter && (isWild(starter) || starter.type !== T.NUMBER));

  room.discardPile.push(starter);
  room.topCard = starter;
  room.currentColor = starter.color;
  room.currentIndex = 0;
  room.direction = 1;
  room.pendingDraw = 0;
  room.wildPending = false;
  room.log = [];

  addLog(room, `游戏开始！起始牌 ${cardName(starter)}`);

  // 如果第一个是 AI，触发
  setTimeout(() => aiTurn(room), 800);
  broadcastRoom(room);
}

// 出牌（cardIndex 为玩家手牌中的下标）
function playCard(room, playerId, cardIndex, chosenColor = null) {
  if (room.status !== 'playing') return;
  const player = room.players[room.currentIndex];
  if (!player || player.id !== playerId) return;
  if (room.wildPending) {
    // 正在等选颜色
    resolveWildColor(room, playerId, chosenColor);
    return;
  }

  const card = player.hand[cardIndex];
  if (!card) return;
  if (!isPlayable(card, room.topCard, room.currentColor, room.pendingDraw)) return;

  player.hand.splice(cardIndex, 1);
  room.discardPile.push(card);
  room.topCard = card;

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
  if (room.status !== 'playing') return;
  const player = room.players[room.currentIndex];
  if (!player || player.id !== playerId) return;
  if (room.wildPending) return;
  if (room.pendingDraw > 0) return;

  const drawn = drawCards(room, 1);
  if (drawn.length > 0) {
    player.hand.push(drawn[0]);
    addLog(room, `${player.name} 摸到 ${cardName(drawn[0])}`);
  }
  advance(room);
  broadcastRoom(room);

  const next = room.players[room.currentIndex];
  if (next && next.isAI && room.status === 'playing') {
    setTimeout(() => aiTurn(room), 1000);
  }
}

function advance(room) {
  room.currentIndex = nextIndex(room, 1);
}

function checkWin(room) {
  for (const p of room.players) {
    if (p.hand.length === 0) {
      room.status = 'over';
      addLog(room, `🏆 ${p.name} 获胜！`);
      return;
    }
  }
}

function colorName(c) {
  return { red: '红', yellow: '黄', green: '绿', blue: '蓝' }[c] || c;
}

// ==================== AI ====================

function aiTurn(room) {
  if (room.status !== 'playing') return;
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
    if (isPlayable(player.hand[i], room.topCard, room.currentColor, room.pendingDraw)) playable.push(i);
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

  socket.on('createRoom', ({ name }) => {
    name = (name || '').trim();
    if (!name) { socket.emit('errorMsg', '请输入名字'); return; }
    const room = createRoom();
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
    if (room.players.length >= 4) { socket.emit('errorMsg', '房间已满'); return; }

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

  socket.on('addAI', () => {
    const room = currentRoom;
    if (!room || room.status !== 'waiting') return;
    if (room.players.length >= 4) return;
    room.players.push({
      id: 'ai_' + Date.now() + '_' + Math.random(),
      name: 'AI-' + (room.players.length + 1),
      socketId: null, isAI: true, hand: []
    });
    broadcastRoom(room);
  });

  socket.on('playCard', ({ cardIndex }) => {
    if (currentRoom) playCard(currentRoom, currentPlayerId, cardIndex);
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
    const idx = room.players.findIndex(p => p.id === currentPlayerId);
    if (idx >= 0) {
      addLog(room, `${room.players[idx].name} 离开`);
      room.players.splice(idx, 1);
      if (room.players.length === 0) { rooms.delete(room.code); return; }
      // 如果游戏中离开，且当前玩家走了，推进回合
      if (room.status === 'playing') {
        room.currentIndex = room.currentIndex % room.players.length;
      }
      broadcastRoom(room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`UNO 服务器已启动: http://localhost:${PORT}`);
});
