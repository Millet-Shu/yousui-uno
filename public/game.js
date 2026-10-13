// 连接服务器
const socket = io();

let myPlayerId = null;
let myRoomCode = null;

// DOM
const $ = id => document.getElementById(id);

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('screen-' + name).classList.add('active');
}

// ===== 首页按钮 =====
$('btn-create').onclick = () => {
  const name = $('input-name').value.trim() || '玩家';
  socket.emit('createRoom', { name });
};

$('btn-join').onclick = () => {
  const name = $('input-name').value.trim() || '玩家';
  const code = $('input-code').value.trim();
  if (!code) { $('home-error').textContent = '请输入房间码'; return; }
  socket.emit('joinRoom', { code, name });
};

$('btn-leave').onclick = () => location.reload();
$('btn-addai').onclick = () => socket.emit('addAI');
$('btn-start').onclick = () => socket.emit('startGame');

// ===== 服务器事件 =====
socket.on('roomCreated', ({ code, playerId }) => {
  myPlayerId = playerId;
  myRoomCode = code;
  $('lobby-code').textContent = code;
  showScreen('lobby');
});

socket.on('roomJoined', ({ code, playerId }) => {
  myPlayerId = playerId;
  myRoomCode = code;
  $('lobby-code').textContent = code;
  showScreen('lobby');
});

socket.on('errorMsg', (msg) => {
  $('home-error').textContent = msg;
});

socket.on('roomUpdate', (state) => {
  if (state.status === 'waiting') {
    renderLobby(state);
    showScreen('lobby');
  } else {
    renderGame(state);
    showScreen('game');
  }
});

// ===== 渲染房间等待页 =====
function renderLobby(state) {
  const list = $('lobby-players');
  list.innerHTML = '';
  state.players.forEach(p => {
    const div = document.createElement('div');
    div.className = 'player';
    div.innerHTML = `<span>${p.name}${p.isYou ? ' (你)' : ''}</span><span class="badge">${p.isAI ? 'AI' : '玩家'}</span>`;
    list.appendChild(div);
  });
}

// ===== 渲染游戏页 =====
const T_LABEL = { 0: '', 1: '⊘', 2: '⇄', 3: '+2', 4: '万能', 5: '+4' };

function cardText(c) {
  if (c.type === 0) return String(c.value);
  return T_LABEL[c.type];
}

function renderGame(state) {
  // 顶牌
  const top = state.topCard;
  const topEl = $('top-card');
  topEl.className = 'card ' + (top.color || 'none');
  $('top-label').textContent = cardText(top);

  // 对手
  const oppEl = $('opponents');
  oppEl.innerHTML = '';
  state.players.filter(p => !p.isYou).forEach(p => {
    const div = document.createElement('div');
    div.className = 'opponent' + (p.isCurrent ? ' current' : '');
    div.innerHTML = `<div class="name">${p.isCurrent ? '▶ ' : ''}${p.name}</div><div class="count">${p.handCount} 张</div>`;
    oppEl.appendChild(div);
  });

  // 状态栏
  const myTurn = state.players.find(p => p.isYou && p.isCurrent);
  if (state.status === 'over') {
    $('status-text').textContent = '游戏结束！';
  } else if (state.wildPending && myTurn) {
    $('status-text').textContent = '请选择颜色';
    $('color-modal').classList.remove('hidden');
  } else if (myTurn) {
    $('status-text').textContent = '轮到你出牌！';
  } else {
    $('status-text').textContent = `等待 ${state.currentPlayerName} 出牌...`;
  }

  // 日志
  $('game-log').innerHTML = state.log.map(l => `<div>${l}</div>`).join('');
  $('game-log').scrollTop = $('game-log').scrollHeight;

  // 手牌
  const handEl = $('hand-area');
  handEl.innerHTML = '';

  // 排序：颜色 红→黄→绿→蓝→万能，同色数字→+2→跳→转
  const colorOrder = { red: 0, yellow: 1, green: 2, blue: 3, none: 4 };
  const sorted = [...state.yourHand].sort((a, b) => {
    const ca = colorOrder[a.color] ?? 4;
    const cb = colorOrder[b.color] ?? 4;
    if (ca !== cb) return ca - cb;
    const ta = a.type === 0 ? a.value : a.type + 10;
    const tb = b.type === 0 ? b.value : b.type + 10;
    return ta - tb;
  });

  sorted.forEach(card => {
    const div = document.createElement('div');
    const playable = myTurn && !state.wildPending && state.status === 'playing';
    div.className = 'hand-card ' + (card.color || 'none');
    div.textContent = cardText(card);

    if (playable) {
      div.onclick = () => {
        const realIndex = state.yourHand.indexOf(card);
        if (card.type === 4 || card.type === 5) {
          // 万能牌：先选颜色
          window._pendingCardIndex = realIndex;
          $('color-modal').classList.remove('hidden');
        } else {
          socket.emit('playCard', { cardIndex: realIndex });
        }
      };
    } else {
      div.classList.add('dim');
    }
    handEl.appendChild(div);
  });
}

// 颜色选择
document.querySelectorAll('.color-btn').forEach(btn => {
  btn.onclick = () => {
    const color = btn.dataset.color;
    $('color-modal').classList.add('hidden');
    if (window._pendingCardIndex !== undefined) {
      // 出万能牌
      socket.emit('playCard', { cardIndex: window._pendingCardIndex });
      window._pendingCardIndex = undefined;
      // 选颜色
      socket.emit('chooseColor', { color });
    } else {
      socket.emit('chooseColor', { color });
    }
  };
});

// 摸牌堆点击
document.querySelector('#draw-pile').onclick = () => {
  socket.emit('drawCard');
};
