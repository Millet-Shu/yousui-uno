// 连接服务器
const socket = io();

let myPlayerId = localStorage.getItem('uno_playerId') || null;
let myRoomCode = localStorage.getItem('uno_roomCode') || null;
let leftRoom = false;  // 离开房间标志

// 页面加载时尝试重连
if (myPlayerId) {
  socket.emit('reconnect', { playerId: myPlayerId });
}

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

$('btn-leave').onclick = () => {
  socket.emit('leaveRoom');
  localStorage.clear();
  myPlayerId = null;
  myRoomCode = null;
  leftRoom = true;
  showScreen('home');
};
$('btn-addai').onclick = () => socket.emit('addAI');
$('btn-start').onclick = () => socket.emit('startGame');
$('btn-uno').onclick = () => socket.emit('callUno');
$('btn-grab').onclick = () => socket.emit('grabLead');
$('btn-menu').onclick = () => $('menu-dropdown').classList.toggle('hidden');

// 确认弹窗
let confirmCallback = null;
function showConfirm(text, cb) {
  $('confirm-text').textContent = text;
  confirmCallback = cb;
  $('confirm-modal').classList.remove('hidden');
}
$('confirm-no').onclick = () => { $('confirm-modal').classList.add('hidden'); confirmCallback = null; };
$('confirm-yes').onclick = () => { $('confirm-modal').classList.add('hidden'); if (confirmCallback) confirmCallback(); confirmCallback = null; };

$('btn-restart').onclick = () => {
  $('menu-dropdown').classList.add('hidden');
  showConfirm('确定要重开游戏吗？', () => socket.emit('restartGame'));
};
$('btn-endgame').onclick = () => {
  $('menu-dropdown').classList.add('hidden');
  showConfirm('确定要结束游戏回到房间吗？', () => socket.emit('endGame'));
};
$('btn-leave-room').onclick = () => {
  $('menu-dropdown').classList.add('hidden');
  showConfirm('确定要退出房间吗？', () => {
    socket.emit('leaveRoom');
    localStorage.clear();
    myPlayerId = null;
    myRoomCode = null;
    leftRoom = true;  // 标记已离开
    showScreen('home');
  });
};
$('btn-pause').onclick = () => {
  $('menu-dropdown').classList.add('hidden');
  socket.emit('pauseGame');
};
$('btn-resume').onclick = () => socket.emit('resumeGame');

// ===== 服务器事件 =====
socket.on('roomCreated', ({ code, playerId }) => {
  myPlayerId = playerId;
  myRoomCode = code;
  localStorage.setItem('uno_playerId', playerId);
  localStorage.setItem('uno_roomCode', code);
  $('lobby-code').textContent = code;
  showScreen('lobby');
});

socket.on('roomJoined', ({ code, playerId }) => {
  myPlayerId = playerId;
  myRoomCode = code;
  if (playerId) {
    localStorage.setItem('uno_playerId', playerId);
    localStorage.setItem('uno_roomCode', code);
  }
  $('lobby-code').textContent = code;
  showScreen('lobby');
});

// 重连成功，直接进游戏
socket.on('reconnected', (state) => {
  // 根据房间状态显示对应页面
  if (state.status === 'waiting') {
    renderLobby(state);
    showScreen('lobby');
  } else {
    renderGame(state);
    showScreen('game');
  }
});

socket.on('reconnectFailed', () => {
  localStorage.removeItem('uno_playerId');
  localStorage.removeItem('uno_roomCode');
  showScreen('home');
});

socket.on('errorMsg', (msg) => {
  $('home-error').textContent = msg;
});

socket.on('roomUpdate', (state) => {
  if (leftRoom) return;  // 离开后不再响应
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
  list.innerHTML = `<div class="section-title">玩家 <span class="count">${state.players.length}/${state.maxPlayers}</span></div>`;
  state.players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'player';
    const delBtn = p.isAI ? `<button class="del-btn" onclick="socket.emit('removeAI',{index:${i}})">×</button>` : '';
    div.innerHTML = `<span>${p.name}${p.isYou ? ' (你)' : ''}</span><span class="badge">${p.isAI ? 'AI' : '玩家'}</span>${delBtn}`;
    list.appendChild(div);
  });
  // 空位加号长方形（观战者点击回到玩家列表）
  if (state.players.length < state.maxPlayers) {
    const addBox = document.createElement('div');
    addBox.className = 'add-slot';
    addBox.textContent = '+';
    addBox.title = '点击回到玩家列表';
    addBox.onclick = () => socket.emit('spectatorJoin');
    list.appendChild(addBox);
  }
  // 观战席（固定5个位置）
  const sp = $('lobby-spectators');
  if (sp) {
    const spCount = state.spectators.filter(s => s !== null).length;
    sp.innerHTML = '<div class="section-title">观战席 <span class="count">' + spCount + '/5</span></div>';
    const row = document.createElement('div');
    row.className = 'spectator-row';
    // 确保长度是5
    const spList = state.spectators.slice(0, 5);
    while (spList.length < 5) spList.push(null);
    spList.forEach((s, i) => {
      if (s) {
        const div = document.createElement('div');
        div.className = 'spectator-avatar';
        div.textContent = s.name[0];
        div.title = s.name;
        // 别人的头像，点了交换位置
        if (!s.isYou) {
          div.onclick = () => socket.emit('moveSpectator', { index: i });
        }
        row.appendChild(div);
      } else {
        const circle = document.createElement('div');
        circle.className = 'empty-circle';
        circle.textContent = '+';
        // 判断我是不是已经在观战席了
        const isAlreadySpectator = state.spectators.some(x => x && x.isYou);
        circle.title = isAlreadySpectator ? '点击移动到这里' : '点击进入观战席';
        circle.onclick = () => {
          if (isAlreadySpectator) {
            socket.emit('moveSpectator', { index: i });
          } else {
            socket.emit('becomeSpectator', { index: i });
          }
        };
        row.appendChild(circle);
      }
    });
    sp.appendChild(row);
  }
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

  // 对手（上半圆均匀分布：右边开始逆时针到左边）
  const oppEl = $('opponents');
  oppEl.innerHTML = '';
  const opponents = state.players.filter(p => !p.isYou);
  const n = opponents.length;
  opponents.forEach((p, i) => {
    // 从右边(0°)到左边(180°)均匀分布
    const angle = (180 / (n + 1)) * (i + 1);
    const rad = angle * Math.PI / 180;
    const x = 50 + 42 * Math.cos(rad);  // 百分比
    const y = 50 - 38 * Math.sin(rad);  // 往上为负
    const div = document.createElement('div');
    div.className = 'opponent ' + (p.isCurrent ? ' current' : '');
    div.style.left = x + '%';
    div.style.top = y + '%';
    div.style.transform = 'translate(-50%, -50%)';
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
    const onlineDot = p.offline ? '<span class="dot offline"></span>' : '<span class="dot online"></span>';
    div.innerHTML = `<div class="name">${p.isCurrent ? '▶ ' : ''}${p.name}${onlineDot}</div><div class="opp-hand">${cardsHtml}${overFlowHtml}</div>${penalty}${rankLabel}${reportBtn}`;
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

  // 暂停遮罩
  const pauseOverlay = $('pause-overlay');
  if (state.paused) {
    pauseOverlay.classList.remove('hidden');
    const pauseText = pauseOverlay.querySelector('.pause-text');
    if (state.isPausedByYou) {
      pauseText.textContent = '你暂停了游戏';
      $('btn-resume').classList.remove('hidden');
    } else {
      pauseText.textContent = '游戏暂停';
      $('btn-resume').classList.add('hidden');
    }
    $('pause-by').textContent = state.pausedBy + ' 暂停了游戏';
  } else {
    pauseOverlay.classList.add('hidden');
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
