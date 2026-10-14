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
  const name = $('input-name').value.trim();
  if (!name) { $('home-error').textContent = '请输入你的名字'; return; }
  const maxPlayers = parseInt($('input-maxplayers').value);
  socket.emit('createRoom', { name, maxPlayers });
};

$('btn-join').onclick = () => {
  const name = $('input-name').value.trim();
  if (!name) { $('home-error').textContent = '请输入你的名字'; return; }
  const code = $('input-code').value.trim();
  if (!code) { $('home-error').textContent = '请输入房间码'; return; }
  socket.emit('joinRoom', { code, name });
};

$('btn-leave').onclick = () => location.reload();
$('btn-addai').onclick = () => socket.emit('addAI');
$('btn-start').onclick = () => socket.emit('startGame');
$('btn-uno').onclick = () => socket.emit('callUno');
$('btn-grab').onclick = () => socket.emit('grabLead');
$('btn-restart').onclick = () => { socket.emit('restartGame'); $('menu-dropdown').classList.add('hidden'); };
$('btn-endgame').onclick = () => location.reload();
$('btn-menu').onclick = () => $('menu-dropdown').classList.toggle('hidden');

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
  // 顶牌（万能牌只边框显示选中颜色）
  const top = state.topCard;
  const topEl = $('top-card');
  if (top) {
    if (top.color === 'none') {
      // 万能牌：背景保持深色，边框显示选中颜色
      topEl.className = 'card wild';
      const c = state.currentColor;
      topEl.style.boxShadow = c ? `0 0 0 4px var(--color-${c})` : 'none';
    } else {
      topEl.className = 'card ' + top.color;
      topEl.style.boxShadow = 'none';
    }
    $('top-label').textContent = cardText(top);
  } else {
    topEl.className = 'card';
    topEl.style.boxShadow = 'none';
    $('top-label').textContent = '?';
  }

  // 对手（按位置分布：上、左、右，显示手牌背面）
  const oppEl = $('opponents');
  oppEl.innerHTML = '';
  const positions = ['pos-top', 'pos-left', 'pos-right'];
  state.players.filter(p => !p.isYou).forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'opponent ' + (positions[i] || 'pos-top') + (p.isCurrent ? ' current' : '');
    const penalty = (p.isCurrent && state.pendingDraw > 0) ? `<div class="penalty">+${state.pendingDraw}</div>` : '';
    const rankLabel = p.finished ? `<div class="rank">第 ${p.rank} 名</div>` : '';
    const reportBtn = (state.pendingReport && state.pendingReport.playerId === p.id)
      ? `<button class="report-btn" onclick="socket.emit('reportUno')">举报</button>` : '';
    // 手牌背面叠放
    const showCount = Math.min(p.handCount, 14);
    let cardsHtml = '';
    for (let j = 0; j < showCount; j++) {
      cardsHtml += `<div class="opp-card-back" style="left:${j * 8}px"></div>`;
    }
    let overFlowHtml = '';
    if (p.handCount > 14) {
      overFlowHtml = `<div class="opp-card-back overflow">${p.handCount}</div>`;
    }
    div.innerHTML = `<div class="name">${p.isCurrent ? '▶ ' : ''}${p.name}</div><div class="opp-hand">${cardsHtml}${overFlowHtml}</div>${penalty}${rankLabel}${reportBtn}`;
    oppEl.appendChild(div);
  });

  // 状态栏
  const myTurn = state.players.find(p => p.isYou && p.isCurrent);
  if (state.status === 'over') {
    $('status-text').textContent = '游戏结束！';
  } else if (state.status === 'grabbing') {
    $('status-text').textContent = '抢"有岁"先手！点下面按钮！';
  } else if (state.wildPending && myTurn) {
    $('status-text').textContent = '请选择颜色';
    $('color-modal').classList.remove('hidden');
  } else if (myTurn && state.pendingDraw > 0) {
    $('status-text').textContent = `罚牌 +${state.pendingDraw}：出+2/+4叠加，否则自动摸牌`;
  } else if (myTurn) {
    $('status-text').textContent = '轮到你出牌！';
  } else if (state.pendingDraw > 0) {
    $('status-text').textContent = `${state.currentPlayerName} 面临 +${state.pendingDraw} 罚牌...`;
  } else {
    $('status-text').textContent = `等待 ${state.currentPlayerName} 出牌...`;
  }

  // 有岁按钮：手牌刚好2张且轮到自己才显示
  const myHandCount = state.yourHand.length;
  $('btn-uno').classList.toggle('hidden', !(myHandCount === 2 && myTurn && state.status === 'playing'));
  // 按下状态
  if (state.myUnoCalled) {
    $('btn-uno').textContent = '✓ 有岁（再点取消）';
    $('btn-uno').style.background = '#30b050';
  } else {
    $('btn-uno').textContent = '喊"有岁"';
    $('btn-uno').style.background = '';
  }
  // 抢先手按钮
  $('btn-grab').classList.toggle('hidden', state.status !== 'grabbing');
  // 牌组数量
  $('draw-count').textContent = state.drawPileCount || 0;

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
    let playable = myTurn && !state.wildPending && state.status === 'playing';
    // 有罚牌时只有+2/+4能出
    if (playable && state.pendingDraw > 0) {
      playable = (card.type === 3 || card.type === 5);
    }
    div.className = 'hand-card ' + (card.color || 'none');
    div.textContent = cardText(card);

    if (playable) {
      div.onclick = () => {
        const realIndex = state.yourHand.indexOf(card);
        if (card.type === 4 || card.type === 5) {
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
      // 出万能牌，直接带颜色一起发
      socket.emit('playCard', { cardIndex: window._pendingCardIndex, chosenColor: color });
      window._pendingCardIndex = undefined;
    } else {
      socket.emit('chooseColor', { color });
    }
  };
});

// 摸牌堆点击
document.querySelector('#draw-pile').onclick = () => {
  socket.emit('drawCard');
};
