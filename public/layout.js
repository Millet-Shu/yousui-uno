// 中间区（商店 + 弃牌堆/打牌堆/牌堆）自适应排版
//
// 以前用固定的 translate(-50%, -66%) 百分比挪位置，只能适配某一种屏幕：
// 屏幕一矮，中间区就压住顶部对手面板；再矮一点就压住"购买"按钮、状态条和手牌。
//
// 现在按真实可用空间摆放：量出上方挡路的对手面板底边、下方底部控件
// （购买按钮 / 状态条 / 手牌 / 名次）的顶边，把整块放进这段区间并垂直居中；
// 放不下时整块等比缩小，最多缩到 0.7。缩放走整块 transform 而不是逐张牌改尺寸，
// 商店、牌堆、间距才会保持同一比例（只缩牌堆的话，固定高度的商店照样会顶出去）。
//
// 两个容易踩的坑：
//   1. 手机上左右两个对手面板本来就会和中间区擦到十几像素，这是旧版就有、
//      观感可以接受的，不能当成"挡路"，否则会算出中间毫无空间、把中间区推到
//      对手面板下面去（这正是之前压住按钮/手牌的原因）。
//   2. 判定用的宽度要取"缩到最小后的宽度"，否则会出现"缩小→不再擦边→放大→
//      又擦边"的来回震荡。
(function () {
  var MIN_SCALE = 0.7;   // 缩到 0.7 就停，再小就看不清牌面了
  var GAP = 6;           // 与其它控件的呼吸空间
  var GRAZE_H = 14;      // 上下判定时容忍的擦边宽度（只挡真正位于上方的对手，左右竖排不算）
  var BOTTOM_IDS = ['action-bar', 'status-bar', 'hand-debuff', 'hand-area', 'my-rank'];

  function visible(el) {
    return !!el && el.offsetParent !== null && el.getBoundingClientRect().height > 0;
  }

  function ovLen(a0, a1, b0, b1) {
    return Math.min(a1, b1) - Math.max(a0, b0);
  }

  function fitCenterArea() {
    var board = document.getElementById('game-board');
    var center = document.getElementById('center-area');
    if (!board || !center || !visible(center)) return;

    // 先还原成"满尺寸、贴顶"量一次理想大小（offsetWidth/Height 不受 transform 影响）
    center.style.transform = 'translate(-50%, 0)';
    center.style.top = '0px';
    var br = board.getBoundingClientRect();
    var w = center.offsetWidth;
    var h = center.offsetHeight;
    if (!w || !h || !br.width) return;

    // 上方：房间号，以及真正位于中间区上方的对手面板（顶部那张）才往下让。
    // 左右两侧竖排的对手虽然也可能和中间区擦到几像素，但它们不在上方，
    // 不能当成顶部障碍，否则会把整块中间区一路推到屏幕底部。
    var judgeW = w;
    var jx0 = br.left + (br.width - judgeW) / 2;
    var jx1 = jx0 + judgeW;
    var topBand = br.top + br.height * 0.3;
    var topLimit = br.top + GAP;
    var code = document.getElementById('game-room-code');
    if (visible(code)) topLimit = Math.max(topLimit, code.getBoundingClientRect().bottom + GAP);
    var opps = document.querySelectorAll('#opponents .opponent');
    for (var i = 0; i < opps.length; i++) {
      var r = opps[i].getBoundingClientRect();
      if (r.height > 0 && r.top < topBand && ovLen(jx0, jx1, r.left, r.right) > GRAZE_H) {
        topLimit = Math.max(topLimit, r.bottom + GAP);
      }
    }

    // 下方：购买按钮 / 状态条 / 手牌 / 名次，谁最靠上就以谁为准
    var bottomLimit = br.bottom - GAP;
    BOTTOM_IDS.forEach(function (id) {
      var el = document.getElementById(id);
      if (visible(el)) bottomLimit = Math.min(bottomLimit, el.getBoundingClientRect().top - GAP);
    });

    var availH = Math.max(0, bottomLimit - topLimit);
    var scale = availH > 0 && h > availH ? Math.max(MIN_SCALE, availH / h) : 1;
    var top = topLimit + Math.max(0, (availH - h * scale) / 2);

    // 第一轮只用"理想宽度"判断顶部障碍，允许十几像素的擦边，避免左右竖排的
    // 对手把中间区一路推下去。但擦边在窄屏上可能变成真的压住（601~900px 的
    // 四人局，顶部两张对手和中间商店会横竖都重叠）。这里再用缩放后的真实
    // 矩形校验一次，真压住就把中间区让到对手下方并重算缩放。
    for (var pass = 0; pass < 3; pass++) {
      var sx0 = br.left + (br.width - w * scale) / 2;
      var sx1 = sx0 + w * scale;
      var sy0 = top;
      var sy1 = top + h * scale;
      var blocker = null;
      for (var j = 0; j < opps.length; j++) {
        var rj = opps[j].getBoundingClientRect();
        if (rj.height > 0 && rj.top < topBand &&
            ovLen(sx0, sx1, rj.left, rj.right) > 2 &&
            ovLen(sy0, sy1, rj.top, rj.bottom) > 2) {
          blocker = rj;
          break;
        }
      }
      if (!blocker) break;
      topLimit = Math.max(topLimit, blocker.bottom + GAP);
      availH = Math.max(0, bottomLimit - topLimit);
      scale = availH > 0 && h > availH ? Math.max(MIN_SCALE, availH / h) : 1;
      top = topLimit + Math.max(0, (availH - h * scale) / 2);
    }

    // 整块缩放。transform-origin 在 style.css 里设成 top center，
    // 所以下沿和水平中心都不动，直接按可用区间把顶边算出来就行
    center.style.transform = scale < 1
      ? 'translate(-50%, 0) scale(' + scale.toFixed(3) + ')'
      : 'translate(-50%, 0)';
    center.style.top = Math.round(top - br.top) + 'px';
  }

  // 底部控件的安全距离。
  // 手机浏览器和微信内置浏览器对 innerHeight 的定义不一样：有的把底部工具栏
  // 算进去（手牌需要多留一截），有的已经扣掉（再按固定值留白，手牌就会飘到
  // 屏幕中间、下面空一大片）。这里用 visualViewport 实测被遮挡的高度，写进
  // --vv-bottom 供 CSS 统一引用，两种内核都能贴住底部又不被工具栏挡住。
  var lastInset = -1;
  function updateViewportInset() {
    var vv = window.visualViewport;
    var inset = 0;
    if (vv) inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    inset = Math.round(inset);
    if (inset === lastInset) return;
    lastInset = inset;
    document.documentElement.style.setProperty('--vv-bottom', inset + 'px');
    fitCenterArea();
  }

  function bindViewportInset() {
    updateViewportInset();
    window.addEventListener('resize', updateViewportInset);
    window.addEventListener('orientationchange', function () {
      setTimeout(updateViewportInset, 150);
    });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', updateViewportInset);
      window.visualViewport.addEventListener('scroll', updateViewportInset);
    }
  }

  window.fitCenterArea = fitCenterArea;
  bindViewportInset();
})();
