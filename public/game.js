// 连接服务器
const socket = io();

let myPlayerId = localStorage.getItem('uno_playerId') || null;
let myRoomCode = localStorage.getItem('uno_roomCode') || null;
let leftRoom = false;
let showHandCount = false;  // 是否显示手牌数量（默认关闭）
let currentGameState = null;

// DOM
const $ = id => document.getElementById(id);

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('screen-' + name).classList.add('active');
}

// ✅ XSS 防护：HTML 转义
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ===== 首页按钮 =====
$('btn-create').onclick = () => {
  const name = $('input-name').value.trim();
  if (!name) { $('home-error').textContent = '请输入你的名字'; return; }
  const maxPlayers = parseInt($('input-maxplayers').value);
  leftRoom = false;
  socket.emit('createRoom', { name, maxPlayers });
};

$('btn-join').onclick = () => {
  const name = $('input-name').value.trim();
  if (!name) { $('home-error').textContent = '请输入你的名字'; return; }
  const code = $('input-code').value.trim();
  if (!code) { $('home-error').textContent = '请输入房间码'; return; }
  leftRoom = false;
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
$('btn-skip').onclick = () => socket.emit('skipTurn');
$('btn-grab-card').onclick = () => socket.emit('grabCard');
$('btn-menu').onclick = () => $('menu-dropdown').classList.toggle('hidden');
$('toggle-hand-count').onchange = (e) => {
  showHandCount = e.target.checked;
  if (currentGameState) renderGame(currentGameState);
};

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
    leftRoom = true;
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

socket.on('reconnected', (state) => {
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
  if (leftRoom) return;
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
  $('lobby-code').textContent = state.code || '';
  $('btn-start').classList.toggle('hidden', !state.isOwner);
  $('btn-addai').classList.toggle('hidden', !state.isOwner);
  const list = $('lobby-players');
  list.innerHTML = `<div class="section-title">玩家 <span class="count">${state.players.length}/${state.maxPlayers}</span></div>`;
  state.players.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'player';
    const delBtn = p.isAI ? `<button class="del-btn" onclick="socket.emit('removeAI',{index:${i}})">×</button>` : '';
    const ownerBadge = p.isOwner ? `<span class="owner-badge">房主</span>` : '';
    // ✅ escapeHtml 防 XSS
    div.innerHTML = `<span>${escapeHtml(p.name)}${p.isYou ? ' (你)' : ''} ${ownerBadge}</span><span class="badge">${p.isAI ? 'AI' : '玩家'}</span>${delBtn}`;
    list.appendChild(div);
  });
  if (state.players.length < state.maxPlayers) {
    const addBox = document.createElement('div');
    addBox.className = 'add-slot';
    addBox.textContent = '+';
    addBox.title = '点击回到玩家列表';
    addBox.onclick = () => socket.emit('spectatorJoin');
    list.appendChild(addBox);
  }
  const sp = $('lobby-spectators');
  if (sp) {
    const spCount = state.spectators.filter(s => s !== null).length;
    sp.innerHTML = '<div class="section-title">观战席 <span class="count">' + spCount + '/5</span></div>';
    const row = document.createElement('div');
    row.className = 'spectator-row';
    const spList = state.spectators.slice(0, 5);
    while (spList.length < 5) spList.push(null);
    spList.forEach((s, i) => {
      if (s) {
        const container = document.createElement('div');
        container.className = 'spectator-container';
        const div = document.createElement('div');
        div.className = 'spectator-avatar';
        div.textContent = escapeHtml(s.name)[0];  // ✅ 防 XSS
        div.title = escapeHtml(s.name);
        if (!s.isYou) {
          div.onclick = () => socket.emit('moveSpectator', { index: i });
        }
        container.appendChild(div);
        if (s.isOwner) {
          const badge = document.createElement('div');
          badge.className = 'owner-badge-small';
          badge.textContent = '房主';
          container.appendChild(badge);
        }
        row.appendChild(container);
      } else {
        const circle = document.createElement('div');
        circle.className = 'empty-circle';
        circle.textContent = '+';
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
  currentGameState = state;

  // 顶牌
  const top = state.topCard;
  const topEl = $('top-card');
  if (top) {
    if (top.color === 'none') {
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

  // 对手
  const oppEl = $('opponents');
  oppEl.innerHTML = '';
  const players = state.players;
  const total = players.length;
  const isSpectator = !players.some(p => p.isYou);
  const meIdx = Math.max(players.findIndex(p => p.isYou), 0);

  // 座位：以"我"为南位（底部），从我的下家开始沿出牌顺序逆时针排列
  // ≤4人：标准东南西北大方位（东=我右侧 → 北=对面 → 西=我左侧）
  // >4人：紧凑环绕布局
  // 观战者没有自己的座位，所有人的牌都按完整方位环绕显示
  const ring4 = [
    { x: 85, y: 50 },  // 东
    { x: 50, y: 20 },  // 北
    { x: 15, y: 50 },  // 西
  ];
  const ring8 = [
    { x: 85, y: 68 },  // 东南
    { x: 85, y: 45 },  // 东
    { x: 85, y: 22 },  // 东北
    { x: 50, y: 20 },  // 北
    { x: 15, y: 22 },  // 西北
    { x: 15, y: 45 },  // 西
    { x: 15, y: 68 },  // 西南
  ];
  const seatPositions = isSpectator
    ? (total <= 4 ? [...ring4, { x: 50, y: 76 }] : [...ring8, { x: 50, y: 76 }])  // 补一个南位
    : (total <= 4 ? ring4 : ring8);

  // 按出牌顺序（direction=1 时沿数组递增，视觉逆时针）从我的下家开始排座
  // 观战者没有"我"，从第一个玩家开始把所有人排满
  const ordered = [];
  const startOffset = isSpectator ? 0 : 1;
  const seatCount = isSpectator ? total : total - 1;
  for (let k = 0; k < seatCount; k++) {
    const p = players[(meIdx + startOffset + k) % total];
    if (p && !p.isYou) ordered.push(p);
  }

  ordered.forEach((p, i) => {
    const pos = seatPositions[i % seatPositions.length];
    const div = document.createElement('div');
    div.className = 'opponent ' + (p.isCurrent ? ' current' : '');
    div.style.left = pos.x + '%';
    div.style.top = pos.y + '%';
    div.style.transform = 'translate(-50%, -50%)';
    const penalty = (p.isCurrent && state.pendingDraw > 0) ? `<div class="penalty">+${state.pendingDraw}</div>` : '';
    const rankLabel = p.finished ? `<div class="rank">第 ${p.rank} 名</div>` : '';
    const unoLabel = p.unoCalled ? `<div class="uno-called">📢 有岁！</div>` : '';
    const reportBtn = (state.pendingReport && state.pendingReport.playerId === p.id)
      ? `<button class="report-btn" onclick="socket.emit('reportUno')">举报</button>` : '';
    let cardsHtml = '';
    const maxStack = 11;
    if (p.handCount <= maxStack) {
      for (let j = 0; j < p.handCount; j++) {
        cardsHtml += `<div class="opp-card-back" style="left:${j * 8}px"></div>`;
      }
    } else {
      cardsHtml = `<div class="opp-card-back"></div>`;
    }
    const countLabel = showHandCount ? `<div class="hand-count">${p.handCount}张</div>` : '';
    const onlineDot = p.offline ? '<span class="dot offline"></span>' : '<span class="dot online"></span>';
    const proxyBadge = p.aiProxy ? '<span class="proxy-badge">AI代理</span>' : '';
    const ownerBadge = p.isOwner ? '<span class="owner-badge-small">房主</span>' : '';
    // ✅ 名字 escapeHtml
    div.innerHTML = `<div class="name">${p.isCurrent ? '▶ ' : ''}${escapeHtml(p.name)}${onlineDot} ${ownerBadge}${proxyBadge}</div><div class="opp-hand">${cardsHtml}</div>${countLabel}${unoLabel}${penalty}${rankLabel}${reportBtn}`;
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
    $('status-text').textContent = `${escapeHtml(state.currentPlayerName)} 面临 +${state.pendingDraw} 罚牌...`;
  } else if (state.grabAvailable) {
    $('status-text').textContent = `⚡ ${escapeHtml(state.grabAvailable.playedBy)} 刚打出 ${cardText(state.grabAvailable.card)}，你可以抢相同的牌！`;
  } else {
    $('status-text').textContent = `等待 ${escapeHtml(state.currentPlayerName)} 出牌...`;
  }

  // 有岁按钮
  const myHandCount = state.yourHand.length;
  $('btn-uno').classList.toggle('hidden', !(myHandCount === 2 && myTurn && state.status === 'playing'));
  if (state.myUnoCalled) {
    $('btn-uno').textContent = '✓ 有岁（再点取消）';
    $('btn-uno').style.background = '#30b050';
  } else {
    $('btn-uno').textContent = '喊"有岁"';
    $('btn-uno').style.background = '';
  }

  // 我的名次
  const me = state.players.find(p => p.isYou);
  if (me && me.finished) {
    $('my-rank').textContent = `🏆 第 ${me.rank} 名`;
    $('my-rank').classList.remove('hidden');
  } else {
    $('my-rank').classList.add('hidden');
  }

  // 观战席
  const gameSpList = $('game-spectator-list');
  if (gameSpList) {
    gameSpList.innerHTML = '';
    const spectators = (state.spectators || []).filter(s => s !== null);
    if (spectators.length === 0) {
      gameSpList.innerHTML = '<div style="color:#666;font-size:12px;">暂无</div>';
    } else {
      spectators.forEach(s => {
        const div = document.createElement('div');
        div.className = 'game-spectator-avatar';
        div.textContent = escapeHtml(s.name)[0];  // ✅ 防 XSS
        div.title = escapeHtml(s.name);
        gameSpList.appendChild(div);
      });
    }
  }

  $('btn-grab').classList.toggle('hidden', state.status !== 'grabbing');
  $('btn-restart').classList.toggle('hidden', !state.isOwner);
  $('btn-endgame').classList.toggle('hidden', !state.isOwner);

  // 抢牌按钮：我可以抢牌时显示（服务器已按候选人过滤）
  $('btn-grab-card').classList.toggle('hidden', !state.grabAvailable);

  const myTurn2 = state.players.find(p => p.isYou && p.isCurrent);
  if (myTurn2 && state.status === 'playing' && !state.wildPending && state.pendingDraw > 0) {
    $('btn-pass').textContent = `不出(摸${state.pendingDraw}张)`;
    $('btn-pass').classList.remove('hidden');
  } else {
    $('btn-pass').classList.add('hidden');
  }
  if (myTurn2 && state.status === 'playing' && state.justDrew) {
    $('btn-skip').classList.remove('hidden');
  } else {
    $('btn-skip').classList.add('hidden');
  }
  $('game-code').textContent = state.code || '----';
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
    $('pause-by').textContent = `${escapeHtml(state.pausedBy || '')} 暂停了游戏`;
  } else {
    pauseOverlay.classList.add('hidden');
  }

  // 日志（log 来自服务器也需 escape）
  $('game-log').innerHTML = state.log.map(l => `<div>${escapeHtml(l)}</div>`).join('');
  $('game-log').scrollTop = $('game-log').scrollHeight;

  // ✅ 手牌：排序时带上 originalIndex，避免 indexOf 错位
  const handEl = $('hand-area');
  handEl.innerHTML = '';

  // 观战者看不到手牌内容，只显示所有人的牌背
  if (isSpectator) {
    handEl.innerHTML = '<div class="spectator-tip">观战中 · 已显示所有玩家的牌背</div>';
    return;
  }

  const colorOrder = { red: 0, yellow: 1, green: 2, blue: 3, none: 4 };
  // 关键修复：给每张牌附上原始索引
  const indexed = state.yourHand.map((card, originalIndex) => ({ card, originalIndex }));
  indexed.sort((a, b) => {
    const ca = colorOrder[a.card.color] ?? 4;
    const cb = colorOrder[b.card.color] ?? 4;
    if (ca !== cb) return ca - cb;
    const ta = a.card.type === 0 ? a.card.value : a.card.type + 10;
    const tb = b.card.type === 0 ? b.card.value : b.card.type + 10;
    return ta - tb;
  });

  indexed.forEach(({ card, originalIndex }) => {
    const div = document.createElement('div');
    let playable = myTurn && !state.wildPending && state.status === 'playing';
    if (playable && state.pendingDraw > 0) {
      playable = (card.type === 3 || card.type === 5);
    }
    // 可抢牌：手上有和刚打出的牌完全一样的牌（包括自己刚打出的，可连出）
    const canGrabCard = !myTurn && state.status === 'playing' && state.grabAvailable &&
      card.color === state.grabAvailable.card.color &&
      card.type === state.grabAvailable.card.type &&
      card.value === state.grabAvailable.card.value;
    div.className = 'hand-card ' + (card.color || 'none');
    div.textContent = cardText(card);

    if (canGrabCard) {
      div.classList.add('grabbable');
      div.onclick = () => socket.emit('grabCard');
    } else if (playable) {
      div.onclick = () => {
        // 使用 originalIndex，绝不会错
        if (div.classList.contains('selected')) {
          if (card.type === 4 || card.type === 5) {
            window._pendingCardIndex = originalIndex;
            $('color-modal').classList.remove('hidden');
          } else {
            socket.emit('playCard', { cardIndex: originalIndex });
          }
        } else {
          document.querySelectorAll('.hand-card.selected').forEach(d => d.classList.remove('selected'));
          div.classList.add('selected');
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
      socket.emit('playCard', { cardIndex: window._pendingCardIndex, chosenColor: color });
      window._pendingCardIndex = undefined;
    } else {
      socket.emit('chooseColor', { color });
    }
  };
});

// 摸牌堆
document.querySelector('#draw-pile').onclick = () => {
  socket.emit('drawCard');
};

// 不出按钮
$('btn-pass').onclick = () => {
  socket.emit('drawCard');
};
