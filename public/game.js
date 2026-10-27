// 连接服务器
const socket = io();

let myPlayerId = localStorage.getItem('uno_playerId') || null;
let myRoomCode = localStorage.getItem('uno_roomCode') || null;
// 座位令牌：重连时证明这个座位是自己的，别人拿到公开的 playerId 也顶不了号
let mySeatToken = localStorage.getItem('uno_seatToken') || '';
let leftRoom = false;
let showHandCount = false;  // 是否显示手牌数量（默认关闭）
let roomMode = null;        // 当前房间已选模式：normal / yousui
let currentGameState = null;

// 保存服务端下发的座位凭证
function saveSeat(playerId, code, seatToken) {
  if (playerId) localStorage.setItem('uno_playerId', playerId);
  if (code) localStorage.setItem('uno_roomCode', code);
  if (seatToken) { mySeatToken = seatToken; localStorage.setItem('uno_seatToken', seatToken); }
}

// 刷新/断线重连：认领回原来的座位，避免服务端留下"AI 代理的幽灵玩家"
socket.on('connect', () => {
  if (myPlayerId && myRoomCode && !leftRoom) socket.emit('reconnect', { playerId: myPlayerId, seatToken: mySeatToken });
});

// DOM
const $ = id => document.getElementById(id);

// 手牌横向滚动位置：持续记录，避免连续两次刷新时读到 0 把视图拉回最左
let handScrollLeft = 0;
// 有岁商店：当前选中的商品格子（null = 没选）与付款手牌
let shopPick = null;
let shopPayIndex = null;
const COLOR_NAME = { red: '红', yellow: '黄', green: '绿', blue: '蓝' };
(() => {
  const el = $('hand-area');
  if (!el) return;
  el.addEventListener('scroll', () => { handScrollLeft = el.scrollLeft; });
})();

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('screen-' + name).classList.add('active');
  // 游戏页右上角已经有 ☰ 菜单，齿轮按钮要往左挪，靠这个 class 区分
  document.body.classList.toggle('in-game', name === 'game');
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
// 商店购买：商品和付款牌都选好后才会显示这个按钮
$('btn-shop-buy').onclick = () => {
  if (shopPick === null || shopPayIndex === null) return;
  socket.emit('buyShopCard', { slot: shopPick, payIndex: shopPayIndex });
  shopPick = null;
  shopPayIndex = null;
};
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
// 暂停遮罩盖住了右上角菜单，这里给所有人一个退出通道
$('btn-pause-leave').onclick = () => {
  showConfirm('确定要退出房间吗？', () => {
    socket.emit('leaveRoom');
    localStorage.clear();
    myPlayerId = null;
    myRoomCode = null;
    leftRoom = true;
    showScreen('home');
  });
};

// ===== 音频引擎（Web Audio 实时合成，不依赖音频文件）=====
// 音乐与音效各走一条总线，音量/开关互不影响
const AudioCore = (() => {
  let ctx = null, bgmBus = null, sfxBus = null;
  function ensure() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;          // 极老的浏览器不支持合成，静默降级
    ctx = new AC();
    bgmBus = ctx.createGain(); bgmBus.gain.value = 0;
    sfxBus = ctx.createGain(); sfxBus.gain.value = 0;
    mkBus(bgmBus, true);
    mkBus(sfxBus, false);
    return ctx;
  }
  function mkBus(bus, isBgm) {
    if (isBgm) {
      // 背景音乐加低通，压掉高频让它更"垫"在下面，长时间听不刺耳
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2200;
      bus.connect(lp); lp.connect(ctx.destination);
    } else {
      bus.connect(ctx.destination);
    }
  }
  function resume() { if (ctx && ctx.state !== 'running') ctx.resume(); }
  return {
    ensure, resume,
    get ctx() { return ctx; },
    get bgm() { return bgmBus; },
    get sfx() { return sfxBus; },
  };
})();

// 浏览器不允许无交互自动播放：每次点击/按键都顺手解锁并启动音乐
// （只监听"第一次"不够：断线重连、切后台再回来时音频会被系统挂起，之后就没声了）
function kickAudio() { AudioCore.resume(); BGM.start(); }
['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
  window.addEventListener(ev, kickAudio, { passive: true }));
// 从后台切回前台时也补一次（手机锁屏/切 App 后音频上下文会被挂起）
document.addEventListener('visibilitychange', () => { if (!document.hidden) kickAudio(); });

function loadCfg(key, def) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null');
    if (saved && typeof saved === 'object') return { ...def, ...saved };
  } catch (e) { /* 本地数据坏了就用默认值 */ }
  return { ...def };
}
function saveCfg(key, cfg) {
  try { localStorage.setItem(key, JSON.stringify(cfg)); } catch (e) {}
}

// ===== 背景音乐 =====
const BGM = (() => {
  const KEY = 'uno_bgm';
  const cfg = loadCfg(KEY, { on: true, vol: 0.35 });
  let step = 0, started = false;

  // 8 小节循环：C - G/B - Am - F - C - Em - F - G，比 4 个和弦更长，不容易听腻
  const BARS = [
    [261.63, 329.63, 392.00, 523.25],
    [246.94, 293.66, 392.00, 493.88],
    [220.00, 261.63, 329.63, 440.00],
    [174.61, 220.00, 261.63, 349.23],
    [261.63, 329.63, 392.00, 523.25],
    [164.81, 196.00, 246.94, 329.63],
    [174.61, 220.00, 261.63, 349.23],
    [196.00, 246.94, 293.66, 392.00],
  ];
  // 两个声部交替：琶音（密）+ 旋律（疏），旋律留白避免机械重复
  const ARP = [0, 1, 2, 3, 2, 1, 2, 3];
  const MELODY = [null, 3, null, 2, null, null, 1, null];
  const STEP_MS = 400;

  function note(bus, freq, dur, peak, type, delay) {
    const ctx = AudioCore.ctx;
    if (!ctx || !bus) return;
    const t = ctx.currentTime + (delay || 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || 'triangle';
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  function tick() {
    if (!cfg.on) return;
    const bus = AudioCore.bgm;
    if (!bus) return;
    const barIdx = Math.floor(step / 8) % BARS.length;
    const chord = BARS[barIdx];
    const s = step % 8;

    // 小节开头：低音 + 长音铺垫（每两小节才铺一次，留出空气感）
    if (s === 0) {
      note(bus, chord[0] / 2, 2.6, 0.09, 'sine');
      if (barIdx % 2 === 0) {
        note(bus, chord[1], 3.0, 0.035, 'sine');
        note(bus, chord[2], 3.0, 0.035, 'sine');
      }
    }
    // 琶音
    note(bus, chord[ARP[s]], 0.9, 0.055, 'triangle');
    // 旋律：高八度、只在部分拍子出现
    const m = MELODY[s];
    if (m !== null) note(bus, chord[m] * 2, 1.1, 0.05, 'sine');
    // 第 4 拍加一个轻盈的高音点缀，打破均匀感
    if (s === 4 && barIdx % 2 === 1) note(bus, chord[3] * 4, 0.5, 0.03, 'sine', 0.001);
    step++;
  }

  function applyGain() {
    const ctx = AudioCore.ctx, bus = AudioCore.bgm;
    if (!ctx || !bus) return;
    const target = cfg.on ? cfg.vol * 0.45 : 0;
    bus.gain.cancelScheduledValues(ctx.currentTime);
    bus.gain.setTargetAtTime(target, ctx.currentTime, 0.15);
  }

  function start() {
    if (!AudioCore.ensure()) return;
    AudioCore.resume();
    applyGain();
    if (started) return;
    started = true;
    tick();
    setInterval(tick, STEP_MS);
  }

  return {
    config: () => cfg,
    start,
    applyGain,
    setOn(v) {
      cfg.on = !!v; saveCfg(KEY, cfg);
      start();            // 用户在设置里操作也算一次交互，可以解锁播放
      applyGain();
    },
    setVolume(v) {
      cfg.vol = Math.max(0, Math.min(1, v)); saveCfg(KEY, cfg);
      applyGain();
    },
  };
})();

// ===== 音效 =====
const SFX = (() => {
  const KEY = 'uno_sfx';
  const cfg = loadCfg(KEY, { on: true, vol: 0.6 });
  let noiseBuf = null;

  function applyGain() {
    const ctx = AudioCore.ctx, bus = AudioCore.sfx;
    if (!ctx || !bus) return;
    bus.gain.setTargetAtTime(cfg.on ? cfg.vol : 0, ctx.currentTime, 0.05);
  }
  applyGain();

  // 噪声源：一次生成、反复复用
  function getNoise(ctx) {
    if (noiseBuf) return noiseBuf;
    const len = Math.floor(ctx.sampleRate * 0.5);
    noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return noiseBuf;
  }

  // 噪声冲击：可指定滤波类型与（可选的）频率滑动，用来做"啪"和"抽屉滑动"
  function noiseHit(dur, f0, q, peak, opts) {
    const ctx = AudioCore.ctx, bus = AudioCore.sfx;
    if (!ctx || !bus) return;
    const o = opts || {};
    const t = ctx.currentTime + (o.when || 0);
    const src = ctx.createBufferSource();
    src.buffer = getNoise(ctx);
    const flt = ctx.createBiquadFilter();
    flt.type = o.type || 'bandpass';
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t);
    if (o.to) flt.frequency.exponentialRampToValueAtTime(o.to, t + dur * (o.sweepEnd || 1));
    const g = ctx.createGain();
    // 起音很短才像"实体撞击"，长起音会变成"呼"
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + (o.attack || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt); flt.connect(g); g.connect(bus);
    src.start(t, 0, Math.min(dur + 0.05, 0.49));
  }

  // 兼容旧调用：固定频率的噪声
  function noiseBurst(dur, freq, q, peak) {
    noiseHit(dur, freq, q, peak);
  }

  function tone(freq, dur, peak, type, when, slideTo) {
    const ctx = AudioCore.ctx, bus = AudioCore.sfx;
    if (!ctx || !bus) return;
    const t = ctx.currentTime + (when || 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type || 'triangle';
    osc.frequency.setValueAtTime(freq, t);
    if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(bus);
    osc.start(t);
    osc.stop(t + dur + 0.03);
  }

  return {
    config: () => cfg,
    applyGain,
    setOn(v) {
      cfg.on = !!v; saveCfg(KEY, cfg);
      AudioCore.ensure(); AudioCore.resume();
      applyGain();
      if (cfg.on) this.click();
    },
    setVolume(v) {
      cfg.vol = Math.max(0, Math.min(1, v)); saveCfg(KEY, cfg);
      applyGain();
    },
    play(name) {
      if (!cfg.on || !AudioCore.ensure()) return;
      AudioCore.resume();
      applyGain();   // 首次创建音频上下文时总线音量还是 0，这里补上
      switch (name) {
        case 'card': {
          // 出牌：牌在手里划过空气 → 拍上桌面。三层叠加才像"真牌"
          const hit = 0.07;
          noiseHit(0.09, 900, 1.0, 0.11, { to: 2600, attack: 0.02 });                 // 划过来的风声
          noiseHit(0.028, 6200, 0.6, 0.5, { type: 'highpass', attack: 0.002, when: hit }); // 撞击脆点
          noiseHit(0.115, 1150, 0.75, 0.45, { when: hit });                            // 牌面拍击的"啪"
          noiseHit(0.05, 2400, 1.4, 0.18, { when: hit + 0.012 });                      // 纸边回弹的细响
          tone(175, 0.09, 0.26, 'sine', hit, 95);                                      // 桌面闷响
          tone(330, 0.045, 0.1, 'triangle', hit, 220);                                 // 硬一点的"嗒"
          break;
        }
        case 'draw': {
          // 摸牌："唰"——用低通扫频，去掉高频沙粒，留下纸面滑动的"气"
          noiseHit(0.30, 620, 0.8, 0.26, { type: 'lowpass', to: 2400, sweepEnd: 0.55, attack: 0.045 });
          noiseHit(0.26, 2100, 0.9, 0.10, { type: 'lowpass', to: 1200, attack: 0.05, when: 0.03 }); // 圆润的中频，抽离的"呼"
          tone(150, 0.05, 0.05, 'sine', 0.28, 105);   // 尾巴上轻轻一收
          break;
        }
        case 'skip':      // 跳过：两个下行短音
          tone(440, 0.1, 0.16, 'triangle', 0);
          tone(330, 0.14, 0.16, 'triangle', 0.1);
          break;
        case 'reverse':   // 反转：上行三连音
          tone(392, 0.08, 0.15, 'triangle', 0);
          tone(523, 0.08, 0.15, 'triangle', 0.07);
          tone(659, 0.12, 0.15, 'triangle', 0.14);
          break;
        case 'grab': {     // 抢牌：拍一下牌 + 清脆的"叮"，比普通出牌更抢耳
          noiseHit(0.028, 6200, 0.6, 0.42, { type: 'highpass', attack: 0.002 });
          noiseHit(0.11, 1150, 0.75, 0.4);
          tone(175, 0.09, 0.2, 'sine', 0, 95);
          tone(880, 0.1, 0.16, 'square', 0.015, 1320);
          break;
        }
        case 'uno':       // 喊 UNO：明亮的和弦
          tone(523, 0.12, 0.16, 'triangle', 0);
          tone(659, 0.12, 0.16, 'triangle', 0.06);
          tone(784, 0.22, 0.16, 'triangle', 0.12);
          break;
        case 'penalty':   // 罚摸：低沉一下
          tone(220, 0.2, 0.18, 'sawtooth', 0, 140);
          break;
        case 'win':       // 胜利：上扬四音
          [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 0.16, 'triangle', i * 0.12));
          break;
        case 'click':     // 界面点击
          tone(660, 0.05, 0.08, 'sine', 0);
          break;
        default: break;
      }
    },
    click() { this.play('click'); },
  };
})();

// BGM 在用户第一次交互后开始（避免浏览器拦截自动播放）
['pointerdown', 'keydown'].forEach(ev =>
  window.addEventListener(ev, () => BGM.start(), { once: true, passive: true }));

// 根据新出现的日志行播放音效：一次动作可能写多条日志（抢牌常伴随跳过/反转），
// 所以要扫描所有新行并按优先级挑一个，而不是只看最后一行
let sfxLastLine = null;
function playStateSounds(state) {
  if (!state || !Array.isArray(state.log) || !state.log.length) return;
  const log = state.log;
  if (sfxLastLine === null) { sfxLastLine = log[log.length - 1]; return; }   // 首次渲染不补音
  const idx = log.lastIndexOf(sfxLastLine);
  if (idx < 0) {   // 找不到上一行（重开/换局日志被清空），当作重新开始，不补音
    sfxLastLine = log[log.length - 1];
    return;
  }
  const fresh = log.slice(idx + 1);
  sfxLastLine = log[log.length - 1];
  if (!fresh.length) return;

  const text = fresh.join(' | ');
  if (/获胜|游戏结束/.test(text)) { SFX.play('win'); return; }
  if (/抢/.test(text)) { SFX.play('grab'); return; }          // 抢牌优先：常带跳过/反转，不能被覆盖
  if (/UNO|有岁/.test(text)) { SFX.play('uno'); return; }
  if (/方向反转/.test(text)) { SFX.play('reverse'); return; }
  if (/跳过/.test(text)) { SFX.play('skip'); return; }
  if (/罚|摸/.test(text)) { SFX.play('draw'); return; }
  SFX.play('card');
}

// ===== 设置面板（规则 + 音乐 + 音效）=====
function openSettings() {
  const b = BGM.config(), s = SFX.config();
  $('toggle-bgm').checked = b.on;
  $('bgm-volume').value = Math.round(b.vol * 100);
  $('bgm-volume').disabled = !b.on;
  $('bgm-volume-value').textContent = Math.round(b.vol * 100) + '%';
  $('toggle-sfx').checked = s.on;
  $('sfx-volume').value = Math.round(s.vol * 100);
  $('sfx-volume').disabled = !s.on;
  $('sfx-volume-value').textContent = Math.round(s.vol * 100) + '%';
  $('settings-modal').classList.remove('hidden');
  $('settings-modal').querySelector('.settings-body').scrollTop = 0;
}
function closeSettings() { $('settings-modal').classList.add('hidden'); }

$('btn-settings').onclick = () => {
  $('menu-dropdown').classList.add('hidden');
  openSettings();
};
$('btn-settings-close').onclick = closeSettings;
// 点遮罩空白处也能关闭
$('settings-modal').onclick = (e) => {
  if (e.target === $('settings-modal')) closeSettings();
};
$('toggle-bgm').onchange = (e) => {
  BGM.setOn(e.target.checked);
  $('bgm-volume').disabled = !e.target.checked;
};
$('bgm-volume').oninput = (e) => {
  const pct = Number(e.target.value);
  BGM.setVolume(pct / 100);
  $('bgm-volume-value').textContent = pct + '%';
};
$('toggle-sfx').onchange = (e) => {
  SFX.setOn(e.target.checked);
  $('sfx-volume').disabled = !e.target.checked;
};
$('sfx-volume').oninput = (e) => {
  const pct = Number(e.target.value);
  SFX.setVolume(pct / 100);
  $('sfx-volume-value').textContent = pct + '%';
  SFX.play('click');   // 拖动时顺便试听音量
};

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
socket.on('roomCreated', ({ code, playerId, seatToken }) => {
  myPlayerId = playerId;
  myRoomCode = code;
  saveSeat(playerId, code, seatToken);
  $('lobby-code').textContent = code;
  showScreen('lobby');
});

socket.on('roomJoined', ({ code, playerId, seatToken }) => {
  myPlayerId = playerId;
  myRoomCode = code;
  saveSeat(playerId, code, seatToken);
  $('lobby-code').textContent = code;
  showScreen('lobby');
});

socket.on('reconnected', (state) => {
  saveSeat(null, null, state.seatToken);   // 旧会话重连成功后补存令牌
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
  localStorage.removeItem('uno_seatToken');
  myPlayerId = null;
  myRoomCode = null;
  mySeatToken = '';
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

// ===== 卡面风格：正常版用官方 UNO 卡面，有岁版保留原简洁样式 =====
const isOfficialUI = () => roomMode === 'normal';
const unoWord = () => (isOfficialUI() ? 'UNO' : '有岁');

// 官方卡牌面上的符号（跳/转用图形，文字牌用数字；日志与状态栏仍用中文 T_LABEL）
const FACE_SYM = { 1: '⊘', 2: '⇄' };
// 当前颜色对应的提示色（万能牌线框用）
const COLOR_HEX = { red: '#ff5a52', yellow: '#ffd93d', green: '#57d76e', blue: '#54a6ff' };

// 官方卡面：白色椭圆 + 两角小标；万能牌为四色椭圆，+4 为四张小牌
function faceHtml(card) {
  if (card.type === 4) {
    return '<span class="cf"><span class="cf-oval cf-rainbow"></span></span>';
  }
  if (card.type === 5) {
    return '<span class="cf"><span class="cf-four">' +
      '<i class="ca r"></i><i class="ca y"></i><i class="ca g"></i><i class="ca b"></i>' +
      '</span><span class="cf-tl">+4</span><span class="cf-br">+4</span></span>';
  }
  // +2：官方牌面是两张叠放的同色小牌
  if (card.type === 3) {
    return '<span class="cf"><span class="cf-two"><i></i><i></i></span>' +
      '<span class="cf-tl">+2</span><span class="cf-br">+2</span></span>';
  }
  const sym = card.type === 0 ? card.value : (FACE_SYM[card.type] || T_LABEL[card.type]);
  return `<span class="cf"><span class="cf-oval">${sym}</span>` +
    `<span class="cf-tl">${sym}</span><span class="cf-br">${sym}</span></span>`;
}

// 顶牌绘制：两种风格共用。官方模式下不用 #top-label，避免 innerHTML 覆盖后取不到元素
function paintTopCard(el, card, currentColor) {
  const official = isOfficialUI();
  if (!card) {
    el.className = 'card' + (official ? ' official' : '');
    el.style.boxShadow = 'none';
    el.innerHTML = '<span id="top-label">?</span>';
    return;
  }
  el.className = 'card ' + (card.color === 'none' ? 'wild' : card.color) + (official ? ' official' : '');
  el.style.boxShadow = (!official && card.color === 'none' && currentColor)
    ? `0 0 0 4px var(--color-${currentColor})` : 'none';
  if (official) { el.innerHTML = faceHtml(card); return; }
  el.innerHTML = '<span id="top-label"></span>';
  $('top-label').textContent = cardText(card);
}

// ===== 有岁商店渲染 =====
// 服务端每格是 { card, priceColor, sold }，这里统一取出来；兼容直接给牌对象的旧结构
function shopSlotOf(shop, i) {
  const s = shop[i];
  if (!s) return { card: null, priceColor: null, sold: true };
  if (s.card) return { card: s.card, priceColor: s.priceColor || (s.card.color !== 'none' ? s.card.color : null), sold: !!s.sold };
  return { card: s, priceColor: s.color, sold: false };
}

// 当前能不能买：自己回合、没在选色/罚牌、对局进行中
function canBuyShop(state) {
  const me = state.players.find(p => p.isYou);
  if (!me || !me.isCurrent) return false;
  return state.status === 'playing' && !state.paused && !state.wildPending && !(state.pendingDraw > 0);
}

function renderShop(state) {
  const panel = $('shop-panel');
  const itemsEl = $('shop-items');
  const shop = Array.isArray(state.shop) && state.shop.length > 0 ? state.shop : null;
  const on = !!state.shopEnabled && !!shop;
  panel.classList.toggle('hidden', !on);
  if (!on) { shopPick = null; shopPayIndex = null; $('btn-shop-buy').classList.add('hidden'); return; }

  const isSpectator = !state.players.some(p => p.isYou);
  const canBuy = !isSpectator && canBuyShop(state);
  if (!canBuy) { shopPick = null; shopPayIndex = null; }

  if (shopPick !== null) {
    const slot = shopSlotOf(shop, shopPick);
    if (!slot.card || slot.sold) shopPick = null;
  }
  const hand = state.yourHand || [];
  if (shopPayIndex !== null && !hand[shopPayIndex]) shopPayIndex = null;

  itemsEl.innerHTML = '';
  shop.forEach((raw, i) => {
    const slot = shopSlotOf(shop, i);
    const el = document.createElement('div');

    // 已售罄：留空格子，写斜着的"已售罄"
    if (slot.sold || !slot.card) {
      el.className = 'card shop-card sold';
      el.innerHTML = '<span class="sold-tag">已售罄</span>';
      itemsEl.appendChild(el);
      return;
    }

    const color = slot.card.color === 'none' ? 'none' : slot.card.color;
    el.className = 'card shop-card ' + (isOfficialUI() ? 'official ' : '') + color;
    if (shopPick === i) el.classList.add('selected');
    const havePay = hand.some(c => c.color === slot.priceColor);
    if (isSpectator || !canBuy || !havePay) el.classList.add('dim');
    if (isOfficialUI()) el.innerHTML = faceHtml(slot.card);
    else el.textContent = cardText(slot.card);
    // 价签颜色：万能牌本身没颜色，用底部色条标出"要用什么颜色买"
    const tag = document.createElement('i');
    tag.className = 'price-tag';
    tag.style.background = { red: '#e04040', yellow: '#e8d020', green: '#30b050', blue: '#3070d0' }[slot.priceColor] || '#888';
    el.appendChild(tag);

    if (!isSpectator) {
      el.onclick = () => {
        if (!canBuy) return;
        shopPick = (shopPick === i) ? null : i;
        // 换了商品后，付款牌颜色如果对不上就清掉
        if (shopPick !== null && shopPayIndex !== null) {
          const s2 = shopSlotOf(shop, shopPick);
          if ((hand[shopPayIndex] || {}).color !== s2.priceColor) shopPayIndex = null;
        }
        // 手牌也要跟着重绘，才能把可付款的牌标出来
        renderGame(currentGameState || state);
      };
    }
    itemsEl.appendChild(el);
  });

  // 购买按钮：商店商品 + 付款手牌都选好了才出现
  const btn = $('btn-shop-buy');
  let selectedSlot = shopPick !== null ? shopSlotOf(shop, shopPick) : null;
  const payCard = shopPayIndex !== null ? hand[shopPayIndex] : null;
  const ready = canBuy && selectedSlot && selectedSlot.card && payCard && payCard.color === selectedSlot.priceColor;
  btn.classList.toggle('hidden', !ready);
  if (ready) btn.textContent = '确认购买';

  const hint = $('shop-hint');
  if (!canBuy) {
    hint.textContent = isSpectator ? '观战中' : '轮到你时才能买';
  } else if (selectedSlot && selectedSlot.card && payCard && payCard.color === selectedSlot.priceColor) {
    hint.textContent = '点下面按钮确认购买';
  } else if (selectedSlot && selectedSlot.card) {
    hint.textContent = `再选一张${COLOR_NAME[selectedSlot.priceColor] || ''}色手牌`;
  } else if (payCard) {
    hint.textContent = `已选 ${cardText(payCard)}，再点一件${COLOR_NAME[payCard.color] || ''}色商品`;
  } else {
    hint.textContent = '先点商品，再点同色手牌';
  }
}

function renderGame(state) {
  currentGameState = state;
  // 游戏开始后收起模式选择器，并把模式显示在牌桌顶部
  closeModePicker();
  roomMode = state.mode || null;
  $('game-mode-chip').textContent = modeName(roomMode);
  $('game-mode-chip').classList.toggle('hidden', !roomMode);
  // 摸牌堆牌背跟随模式切换风格
  $('draw-pile').classList.toggle('official', isOfficialUI());
  $('game-board').classList.toggle('official-ui', isOfficialUI());

  // 顶牌
  paintTopCard($('top-card'), state.topCard, state.currentColor);

  // 万能牌/加四牌：用当前颜色的动态线框围住顶牌，避免看不出选了什么颜色
  const topIsWild = !!state.topCard && (state.topCard.type === 4 || state.topCard.type === 5);
  const showRing = isOfficialUI() && topIsWild && !!state.currentColor && !state.wildPending;
  $('top-card-wrap').classList.toggle('show-ring', showRing);
  if (showRing) {
    $('top-card-wrap').style.setProperty('--ring-color', COLOR_HEX[state.currentColor] || '#fff');
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
    const unoLabel = p.unoAnnounced ? `<div class="uno-called">📢 ${unoWord()}！</div>` : '';
    const reportBtn = (state.pendingReport && state.pendingReport.playerId === p.id && !p.isYou && !isSpectator)
      ? `<button class="report-btn" onclick="socket.emit('reportUno')">举报</button>` : '';
    let cardsHtml = '';
    // 最多显示 11 张牌背，叠放间距由 CSS 控制（居中、不撑出面板）
    // 只有超过 11 张（数不清了）才在最上面那张牌背写总数；没超过就数牌背，
    // 想精确看数量再开"显示手牌数"开关
    const maxStack = 11;
    const shown = Math.min(p.handCount, maxStack);
    const backCls = isOfficialUI() ? 'opp-card-back official' : 'opp-card-back';
    for (let j = 0; j < shown; j++) {
      const showNum = j === shown - 1 && p.handCount > maxStack;
      cardsHtml += '<div class="' + backCls + '">' +
        (showNum ? '<span class="back-count">' + p.handCount + '</span>' : '') + '</div>';
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
    $('status-text').textContent = `抢"${unoWord()}"先手！点下面按钮！`;
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

  // 打牌顺序提示：方向 + 接下来轮到谁，反转/跳过后不用猜
  const dir = state.direction >= 0 ? 1 : -1;
  const curIdx = players.findIndex(p => p.isCurrent);
  let nextPlayer = null;
  if (curIdx >= 0 && state.status !== 'grabbing') {
    // 从当前玩家的下一位开始找，才是"接下来"；跳过已出完牌的人
    const active = players.filter(p => !p.finished).length;
    for (let k = 1; k <= active; k++) {
      const cand = players[((curIdx + dir * k) % players.length + players.length) % players.length];
      if (cand && !cand.finished) { nextPlayer = cand; break; }
    }
  }
  $('turn-order').classList.toggle('hidden', !nextPlayer);
  if (nextPlayer) {
    $('dir-icon').textContent = dir === 1 ? '↺' : '↻';
    $('dir-text').textContent = dir === 1 ? '逆时针' : '顺时针';
    $('next-player').textContent = `接下来：${nextPlayer.isYou ? '你' : escapeHtml(nextPlayer.name)}`;
  }

  playStateSounds(state);

  // 喊 UNO / 有岁：手上正好 2 张时才有按钮，且只在自己回合显示（抢牌候选同理）
  const myHandCount = state.yourHand.length;
  const grabCall = !!state.grabAvailable && myHandCount === 2;
  const canCallUno = myHandCount === 2 && state.status === 'playing' && !state.paused
    && (!!myTurn || grabCall);
  $('btn-uno').classList.toggle('hidden', !canCallUno);
  if (state.myUnoCalled) {
    $('btn-uno').textContent = `✓ ${unoWord()}（再点取消）`;
    $('btn-uno').classList.add('called');
  } else {
    $('btn-uno').textContent = `喊"${unoWord()}"`;
    $('btn-uno').classList.remove('called');
  }

  // 我的名次
  const me = state.players.find(p => p.isYou);
  // 左上角显示自己的名字（观战者不显示）
  const myNameEl = $('game-my-name');
  if (me && !isSpectator) {
    myNameEl.textContent = '👤 ' + me.name;
    myNameEl.classList.remove('hidden');
  } else {
    myNameEl.classList.add('hidden');
  }
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
  // 本地还没出牌时可以点 × 反悔；服务端已经收下这张万能牌（wildPending）时必须选色，不给取消
  $('color-cancel').classList.toggle('hidden', !!state.wildPending);
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
  // 弃牌堆（商店付掉的牌）单独显示张数，和打牌堆分开
  $('discard-count').textContent = state.discardCount || 0;
  $('discard-pile').classList.toggle('official', isOfficialUI());
  $('discard-pile').classList.toggle('empty', !(state.discardCount > 0));
  // 没有商店的模式不会产生弃牌，弃牌堆直接藏起来，别占位置
  $('discard-pile').parentElement.classList.toggle('hidden', !state.shopEnabled);

  // 暂停遮罩
  const pauseOverlay = $('pause-overlay');
  if (state.paused) {
    pauseOverlay.classList.remove('hidden');
    const pauseText = pauseOverlay.querySelector('.pause-text');
    if (state.isPausedByYou) {
      pauseText.textContent = '你暂停了游戏';
    } else {
      pauseText.textContent = '游戏暂停';
    }
    // 暂停发起者离开/被踢后，房主也能恢复，避免全场卡死
    $('btn-resume').classList.toggle('hidden', !(state.isPausedByYou || state.isOwner));
    $('pause-by').textContent = `${escapeHtml(state.pausedBy || '')} 暂停了游戏`;
  } else {
    pauseOverlay.classList.add('hidden');
  }

  // 日志（log 来自服务器也需 escape）
  $('game-log').innerHTML = state.log.map(l => `<div>${escapeHtml(l)}</div>`).join('');
  $('game-log').scrollTop = $('game-log').scrollHeight;

  // 有岁商店（不管是不是观战都渲染，观战只读）
  renderShop(state);

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
      // 与服务端叠加规则保持一致：罚牌为 +4 时只能用 +4 反击，+2 也变暗
      playable = state.pendingDrawType === 5 ? card.type === 5 : (card.type === 3 || card.type === 5);
    }
    // wildPending 时整手牌禁用（必须通过颜色弹窗选色，防止乱点把 currentColor 置 null）
    // 可抢牌：手上有和刚打出的牌完全一样的牌（包括自己刚打出的，可连出）
    const canGrabCard = !myTurn && state.status === 'playing' && !state.wildPending && state.grabAvailable &&
      card.color === state.grabAvailable.card.color &&
      card.type === state.grabAvailable.card.type &&
      card.value === state.grabAvailable.card.value;
    div.className = 'hand-card ' + (card.color || 'none') + (isOfficialUI() ? ' official' : '');
    if (isOfficialUI()) div.innerHTML = faceHtml(card);
    else div.textContent = cardText(card);

    // 商店：选好商品后，这张手牌就是候选付款牌。选中后等"购买"按钮确认
    if (shopPick !== null && currentGameState && Array.isArray(currentGameState.shop)) {
      const slot = shopSlotOf(currentGameState.shop, shopPick);
      const sameColor = !!slot.card && card.color === slot.priceColor;
      div.classList.add(sameColor ? 'payable' : 'unpayable');
      if (sameColor && shopPayIndex === originalIndex) div.classList.add('selected');
      div.onclick = () => {
        if (!sameColor) {
          $('shop-hint').textContent = `这张不行，商店要${COLOR_NAME[slot.priceColor] || ''}色`;
          return;
        }
        shopPayIndex = (shopPayIndex === originalIndex) ? null : originalIndex;
        renderGame(currentGameState);
      };
      handEl.appendChild(div);
      return;
    }

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
    handEl.scrollLeft = handScrollLeft;
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

// 反悔：还没把万能牌发给服务端时，点 × 直接放弃这次出牌
$('color-cancel').onclick = () => {
  $('color-modal').classList.add('hidden');
  window._pendingCardIndex = undefined;
  document.querySelectorAll('.hand-card.selected').forEach(d => d.classList.remove('selected'));
};

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
