// 连接服务器
const socket = io();

let myPlayerId = localStorage.getItem('uno_playerId') || null;
let myRoomCode = localStorage.getItem('uno_roomCode') || null;
let leftRoom = false;
let showHandCount = false;  // 是否显示手牌数量（默认关闭）
let roomMode = null;        // 当前房间已选模式：normal / yousui
let currentGameState = null;

// 刷新/断线重连：认领回原来的座位，避免服务端留下"AI 代理的幽灵玩家"
socket.on('connect', () => {
  if (myPlayerId && myRoomCode && !leftRoom) socket.emit('reconnect', { playerId: myPlayerId });
});

// DOM
const $ = id => document.getElementById(id);

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('screen-' + name).classList.add('active');
  // 离开房间页时收起模式选择层，避免被踢/退出后遮罩残留
  if (name !== 'lobby') $('mode-picker').classList.add('hidden');
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
  if (!confirm('确定要离开房间吗？')) return;
  socket.emit('leaveRoom');
  localStorage.clear();
  myPlayerId = null;
  myRoomCode = null;
  leftRoom = true;
  showScreen('home');
};
$('btn-addai').onclick = () => socket.emit('addAI');
// 开始游戏：还没选模式时先弹模式卡片，选完回到房间再点一次开始
$('btn-start').onclick = () => {
  if (!roomMode) { openModePicker(); return; }
  socket.emit('startGame');
};
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

// ===== 模式选择 =====
// roomMode 已在文件顶部声明（let roomMode = null），由 roomUpdate 里 state.mode 赋值
const MODE_NAMES = { normal: '正常版 UNO', yousui: '有岁 UNO' };
const modeName = m => MODE_NAMES[m] || '未选择';

function openModePicker() {
  $('mode-picker').classList.remove('hidden');
  document.querySelectorAll('.mode-card').forEach(c =>
    c.classList.toggle('selected', c.dataset.mode === roomMode));
  requestAnimationFrame(updateModeTrackFit);
}

// 两张卡片放得下就并排居中，手机放不下时才切换成可横滑布局
function updateModeTrackFit() {
  const track = document.querySelector('.mode-track');
  if (!track) return;
  const cards = track.querySelectorAll('.mode-card');
  if (!cards.length) return;
  const gap = parseFloat(getComputedStyle(track).gap) || 0;
  let inner = 0;
  cards.forEach((c, i) => { inner += c.getBoundingClientRect().width + (i ? gap : 0); });
  track.classList.toggle('scrollable', inner + 32 > track.clientWidth + 1);
}
function closeModePicker() { $('mode-picker').classList.add('hidden'); }

$('btn-change-mode').onclick = openModePicker;
$('btn-mode-cancel').onclick = closeModePicker;

// 卡片支持手指横滑 / 桌面拖拽 / 滚轮横向滚动；拖动超过阈值时不触发选中
(() => {
  const track = document.querySelector('.mode-track');
  let down = false, dragged = false, startX = 0, startLeft = 0;
  track.addEventListener('pointerdown', e => {
    down = true; dragged = false; startX = e.clientX; startLeft = track.scrollLeft;
  });
  track.addEventListener('pointermove', e => {
    if (!down) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 8) dragged = true;
    if (dragged) track.scrollLeft = startLeft - dx;
  });
  ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
    track.addEventListener(ev, () => { down = false; }));
  track.addEventListener('wheel', e => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      track.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });
  track.addEventListener('click', e => {
    if (dragged) return;   // 滑动时松手不误选
    const card = e.target.closest('.mode-card');
    if (!card) return;
    roomMode = card.dataset.mode;   // 先行更新，避免服务端回包前再点开始又弹窗
    socket.emit('setMode', { mode: roomMode });
    closeModePicker();
  });
})();

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
  myPlayerId = null;
  myRoomCode = null;
  $('home-error').textContent = '原来的房间已结束，请重新创建或加入';
  showScreen('home');
});

socket.on('errorMsg', (msg) => {
  // 首页用内联提示，其它页面直接弹窗，否则错误信息用户看不到
  if ($('screen-home').classList.contains('active')) $('home-error').textContent = msg;
  else alert(msg);
});

// 观战席换位：收到对方请求 → 弹确认（confirm 是纯文本，不要转义）
socket.on('swapRequest', ({ fromName, fromId, toId }) => {
  const accept = confirm(`${fromName} 想和你交换观战席位置，同意吗？`);
  socket.emit('spectatorSwapConfirm', { accept, fromId, toId });
});

socket.on('swapRequestResult', ({ accepted }) => {
  // 换位完成后 roomUpdate 会自动刷新，这里只提示一下
  if (currentGameState && currentGameState.status === 'waiting') {
    // 已在 lobby 页，roomUpdate 会刷新
  }
});

// 被房主踢出：必须回到首页，否则界面会残留成观战者
socket.on('kicked', ({ reason } = {}) => {
  socket.emit('leaveRoom');  // 让服务端清掉本连接的房间引用，避免后续创建房间被拒
  localStorage.clear();
  myPlayerId = null;
  myRoomCode = null;
  leftRoom = true;
  alert(reason || '你已被踢出房间');
  showScreen('home');
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
  // 模式：房主可更换，其他人只读
  roomMode = state.mode || null;
  $('lobby-mode-name').textContent = modeName(roomMode);
  $('lobby-mode').classList.toggle('empty', !roomMode);
  $('btn-change-mode').classList.toggle('hidden', !state.isOwner);

  const list = $('lobby-players');
  list.innerHTML = `<div class="section-title">玩家 <span class="count">${state.players.length}/${state.maxPlayers}</span></div>`;

  state.players.forEach(p => {
    const row = document.createElement('div');
    row.className = 'player';

    const nameEl = document.createElement('span');
    nameEl.className = 'player-name';
    nameEl.textContent = p.name + (p.isYou ? ' (你)' : '');
    if (p.isOwner) {
      const ob = document.createElement('span');
      ob.className = 'owner-badge';
      ob.textContent = '房主';
      nameEl.appendChild(ob);
    }

    const actions = document.createElement('span');
    actions.className = 'player-actions';

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = p.isAI ? 'AI' : '玩家';
    actions.appendChild(badge);

    // 房主可移除非自己的 AI / 玩家（用 DOM 事件，避免名字里有引号破坏内联脚本）
    if (state.isOwner && !p.isOwner) {
      const btn = document.createElement('button');
      btn.className = 'mini-btn danger';
      btn.textContent = p.isAI ? '移除' : '踢出';
      btn.onclick = () => {
        if (!p.isAI && !confirm(`确定踢出 ${p.name} 吗？`)) return;
        socket.emit(p.isAI ? 'removeAI' : 'kickPlayer', p.isAI ? { id: p.id } : { playerId: p.id });
      };
      actions.appendChild(btn);
    }

    row.appendChild(nameEl);
    row.appendChild(actions);
    list.appendChild(row);
  });

  if (state.players.length < state.maxPlayers) {
    const isAlreadySpectator = state.spectators.some(x => x && x.isYou);
    const addBox = document.createElement('div');
    addBox.className = 'add-slot';
    addBox.textContent = '+';
    addBox.title = '点击回到玩家列表';
    // 只有在观战席的人点这个才有意义，玩家点了会静默无响应
    if (isAlreadySpectator) addBox.onclick = () => socket.emit('spectatorJoin');
    else addBox.style.cursor = 'default';
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
          div.onclick = () => socket.emit('spectatorSwapRequest', { targetId: s.id });
          div.title = `点击和 ${escapeHtml(s.name)} 换位`;
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

// 座位坐标（百分比）：按对手数量选环，避开底部手牌区
const SEAT_RING_1 = [{ x: 50, y: 20 }];
const SEAT_RING_2 = [{ x: 85, y: 40 }, { x: 15, y: 40 }];
const SEAT_RING_3 = [
  { x: 85, y: 50 },  // 东（我的右侧）
  { x: 50, y: 20 },  // 北（对面）
  { x: 15, y: 50 },  // 西（我的左侧）
];
// 4 个对手（自己观战时）：上排两张 + 左右各一张，不压中间牌堆
const SEAT_RING_4 = [
  { x: 85, y: 42 }, { x: 72, y: 15 }, { x: 28, y: 15 }, { x: 15, y: 42 },
];
const SEAT_RING_8 = [
  { x: 85, y: 68 }, { x: 85, y: 45 }, { x: 85, y: 22 },
  { x: 50, y: 20 },
  { x: 15, y: 22 }, { x: 15, y: 45 }, { x: 15, y: 68 },
];

function cardText(c) {
  if (c.type === 0) return String(c.value);
  return T_LABEL[c.type];
}

function renderGame(state) {
  currentGameState = state;
  // 游戏开始后收起模式选择器，并把模式显示在牌桌顶部
  closeModePicker();
  roomMode = state.mode || null;
  $('game-mode-chip').textContent = modeName(roomMode);
  $('game-mode-chip').classList.toggle('hidden', !roomMode);

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
  // 观战者没有自己的座位，按玩家总数选环（不再额外补南位，避免压住中间牌堆）
  const oppCount = isSpectator ? total : total - 1;
  let seatPositions;
  if (isSpectator && total >= 8) seatPositions = [...SEAT_RING_8, { x: 50, y: 88 }];
  else if (oppCount >= 5) seatPositions = SEAT_RING_8;
  else if (oppCount === 4) seatPositions = SEAT_RING_4;
  else if (oppCount === 3) seatPositions = SEAT_RING_3;
  else if (oppCount === 2) seatPositions = SEAT_RING_2;
  else seatPositions = SEAT_RING_1;

  // 按出牌顺序（direction=1 时沿数组递增，视觉逆时针）从我的下家开始排座
  // 观战者没有"我"，从第一个玩家开始把所有人排满
  const ordered = [];
  const startOffset = isSpectator ? 0 : 1;
  const seatCount = isSpectator ? total : total - 1;
  for (let k = 0; k < seatCount; k++) {
    const p = players[(meIdx + startOffset + k) % total];
    if (p && !p.isYou) ordered.push(p);
  }

  const narrow = window.innerWidth <= 900;  // 窄屏顶部有观战席横条，座位需要让位
  ordered.forEach((p, i) => {
    const pos = seatPositions[i % seatPositions.length];
    const div = document.createElement('div');
    div.className = 'opponent ' + (p.isCurrent ? ' current' : '');
    div.style.left = pos.x + '%';
    div.style.top = (narrow ? Math.max(pos.y, 30) : pos.y) + '%';
    div.style.transform = 'translate(-50%, -50%)';
    const penalty = (p.isCurrent && state.pendingDraw > 0) ? `<div class="penalty">+${state.pendingDraw}</div>` : '';
    const rankLabel = p.finished ? `<div class="rank">第 ${p.rank} 名</div>` : '';
    const unoLabel = p.unoCalled ? `<div class="uno-called">📢 有岁！</div>` : '';
    const reportBtn = (state.pendingReport && state.pendingReport.playerId === p.id && !p.isYou)
      ? `<button class="report-btn" onclick="socket.emit('reportUno')">举报</button>` : '';
    let cardsHtml = '';
    // 最多显示 11 张牌背，叠放间距由 CSS 控制（居中、不撑出面板）
    const maxStack = 11;
    const shown = Math.min(p.handCount, maxStack);
    for (let j = 0; j < shown; j++) {
      cardsHtml += '<div class="opp-card-back"></div>';
    }
    if (p.handCount > maxStack) cardsHtml += '<div class="opp-card-back overflow">+' + (p.handCount - maxStack) + '</div>';
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
  } else if (state.grabAvailable) {
    $('status-text').textContent = `⚡ ${escapeHtml(state.grabAvailable.playedBy)} 刚打出 ${cardText(state.grabAvailable.card)}，你可以抢相同的牌！`;
  } else if (state.wildPending && myTurn) {
    $('status-text').textContent = '请选择颜色';
  } else if (myTurn && state.pendingDraw > 0) {
    $('status-text').textContent = `罚牌 +${state.pendingDraw}：出+2/+4叠加，否则自动摸牌`;
  } else if (myTurn) {
    $('status-text').textContent = '轮到你出牌！';
  } else if (state.pendingDraw > 0) {
    $('status-text').textContent = `${escapeHtml(state.currentPlayerName)} 面临 +${state.pendingDraw} 罚牌...`;
  } else {
    $('status-text').textContent = `等待 ${escapeHtml(state.currentPlayerName)} 出牌...`;
  }

  // 有岁按钮
  const myHandCount = state.yourHand.length;
  $('btn-uno').classList.toggle('hidden', !(myHandCount === 2 && myTurn && state.status === 'playing'));
  if (state.myUnoCalled) {
    $('btn-uno').textContent = '✓ 有岁（再点取消）';
    $('btn-uno').classList.add('called');
  } else {
    $('btn-uno').textContent = '喊"有岁"';
    $('btn-uno').classList.remove('called');
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
        div.title = escapeHtml(s.name) + (s.isOwner ? '（房主）' : '');
        gameSpList.appendChild(div);
      });
    }
  }

  // 颜色弹窗：只有"服务端要求选色"或"本地已点开万能牌"时才显示，否则自动关闭
  const needColor = !!myTurn && (state.wildPending || window._pendingCardIndex !== undefined);
  $('color-modal').classList.toggle('hidden', !needColor);
  if (!needColor) window._pendingCardIndex = undefined;

  $('btn-grab').classList.toggle('hidden', state.status !== 'grabbing' || isSpectator);
  $('btn-restart').classList.toggle('hidden', !state.isOwner);
  $('btn-endgame').classList.toggle('hidden', !state.isOwner);
  // 暂停只有房主或当前回合玩家能操作，其他人隐藏避免点了没反应
  $('btn-pause').classList.toggle('hidden', !(state.isOwner || myTurn));

  // 抢牌按钮：我可以抢牌时显示（服务器已按候选人过滤）
  $('btn-grab-card').classList.toggle('hidden', !state.grabAvailable);

  if (myTurn && state.status === 'playing' && !state.wildPending && state.pendingDraw > 0) {
    $('btn-pass').textContent = `不出(摸${state.pendingDraw}张)`;
    $('btn-pass').classList.remove('hidden');
  } else {
    $('btn-pass').classList.add('hidden');
  }
  if (myTurn && state.status === 'playing' && state.justDrew) {
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
  const prevScroll = handEl.scrollLeft;  // 记住横向拖动位置，状态刷新时不要跳回最左
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
    // wildPending 时整手牌禁用（必须通过颜色弹窗选色，防止乱点把 currentColor 置 null）
    // 可抢牌：手上有和刚打出的牌完全一样的牌（包括自己刚打出的，可连出）
    const canGrabCard = !myTurn && state.status === 'playing' && !state.wildPending && state.grabAvailable &&
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

  // 放得下就整体居中；放不下改为左对齐并允许横向拖动（不再压缩重叠）
  requestAnimationFrame(() => {
    const cards = handEl.querySelectorAll('.hand-card');
    if (!cards.length) return;
    const cs = getComputedStyle(handEl);
    const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const gap = parseFloat(cs.gap) || 0;
    const cardW = cards[0].getBoundingClientRect().width;
    const need = cards.length * cardW + (cards.length - 1) * gap + pad;
    handEl.classList.toggle('scrollable', need > handEl.clientWidth + 1);
    handEl.scrollLeft = prevScroll;
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

// 横竖屏切换后重新计算手牌重叠与座位，避免牌被裁掉
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (currentGameState) renderGame(currentGameState);
    if (!$('mode-picker').classList.contains('hidden')) updateModeTrackFit();
  }, 150);
});

// 不出按钮
$('btn-pass').onclick = () => {
  socket.emit('drawCard');
};
