/**
 * AlfaProxi · Liquid Glass 动态层（Web 侧实现）
 *
 * 背景：系统级 Liquid Glass 的 API 是给原生视图的（SwiftUI `glassEffect` /
 * UIKit `UIGlassEffect`），HTML 元素拿不到那个材质。但官方那套「动态」是可以
 * 按行为对等复刻的，本文件就干这件事：
 *
 *   SwiftUI / UIKit                        这里的对应实现
 *   ─────────────────────────────────────────────────────────────
 *   glassEffect(.regular.interactive())    按住缩放 + 松手回弹 + 指针高光跟随
 *   GlassEffectContainer(spacing:)         导航内所有玻璃共用一个容器（.glass-stage）
 *   glassEffectID(_:in:) + matchedGeometry 单个选取胶囊在标签之间形变位移
 *   glassEffectTransition(.materialize)    首次出现 / 形态切换时的淡入放大
 *   .spring(response:dampingFraction:)     位置与尺寸各一条弹簧积分
 *
 * 只作用于「导航层」（nav.tabs、浮动写入条），内容层保持不动 —— 这是 HIG 的
 * 明确要求：玻璃是控制层材质，不该铺在主内容后面。
 *
 * 无 JS 时不会加 .glass-live，mobile.css 里旧的 .tab.active 样式仍然生效。
 */
(function () {
  'use strict';

  var body = document.body;
  if (!body || !body.classList.contains('mobile')) return;

  var reduceMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: function () {} };

  /* Apple 默认交互弹簧大致相当于 response 0.35s / 阻尼 0.78；
     位移比尺寸略软一点，形变才有「先流过去、再撑开」的手感。 */
  var SPRING_POS = { response: 0.34, damping: 0.80 };
  var SPRING_SIZE = { response: 0.40, damping: 0.86 };

  function springOf(p) {
    var w = (2 * Math.PI) / p.response;
    return { k: w * w, c: 2 * p.damping * w };
  }
  var POS = springOf(SPRING_POS);
  var SIZE = springOf(SPRING_SIZE);

  function Axis(v) { return { x: v, v: 0 }; }
  function stepAxis(a, target, sp, dt) {
    var acc = -sp.k * (a.x - target) - sp.c * a.v;
    a.v += acc * dt;
    a.x += a.v * dt;
  }
  function settled(a, target) {
    return Math.abs(a.x - target) < 0.35 && Math.abs(a.v) < 4;
  }

  /* ---------------- 选取胶囊（glassEffectID + matchedGeometry） ---------------- */

  function mountNav(nav) {
    if (!nav || nav.dataset.glassMounted === '1') return null;
    var tabs = [].slice.call(nav.querySelectorAll('.tab'));
    if (!tabs.length) return null;

    nav.dataset.glassMounted = '1';
    body.classList.add('glass-live');
    nav.classList.add('glass-stage');

    var pill = document.createElement('span');
    pill.className = 'glass-pill';
    pill.setAttribute('aria-hidden', 'true');
    nav.insertBefore(pill, nav.firstChild);

    var st = {
      x: Axis(0), y: Axis(0), w: Axis(0), h: Axis(0),
      shown: false, raf: 0, last: 0, stretch: 0,
    };

    function metrics() {
      var active = nav.querySelector('.tab.active') || tabs[0];
      // offset* 是布局值，不受按压时 transform: scale() 影响，胶囊不会跟着抖
      return {
        x: active.offsetLeft,
        y: active.offsetTop,
        w: active.offsetWidth,
        h: active.offsetHeight,
        tab: active,
      };
    }

    function place(instant) {
      var m = metrics();
      if (!m.w || !m.h) return;
      if (instant || reduceMotion.matches) {
        st.x.x = m.x; st.y.x = m.y; st.w.x = m.w; st.h.x = m.h;
        st.x.v = st.y.v = st.w.v = st.h.v = 0;
        render();
        return;
      }
      if (!st.shown) {           // materialize：首次出现从 0.86 放大淡入
        st.x.x = m.x; st.y.x = m.y;
        st.w.x = m.w * 0.86; st.h.x = m.h * 0.86;
      }
      run();
    }

    function render() {
      pill.style.width = st.w.x + 'px';
      pill.style.height = st.h.x + 'px';
      // 位移过程中沿运动方向轻微拉伸 —— 液态的「先流、后聚」
      var s = 1 + Math.min(0.10, st.stretch);
      pill.style.transform = 'translate3d(' + st.x.x + 'px,' + st.y.x + 'px,0) scaleX(' + s.toFixed(4) + ')';
      pill.style.opacity = st.shown ? '1' : '0';
    }

    function run() {
      if (st.raf) return;
      st.last = 0;
      st.raf = requestAnimationFrame(tick);
    }

    function tick(now) {
      var dt = st.last ? Math.min(0.032, (now - st.last) / 1000) : 0.016;
      st.last = now;
      var m = metrics();

      var vx0 = st.x.v;
      stepAxis(st.x, m.x, POS, dt);
      stepAxis(st.y, m.y, POS, dt);
      stepAxis(st.w, m.w, SIZE, dt);
      stepAxis(st.h, m.h, SIZE, dt);

      // 拉伸量跟随横向速度，停下自然归零
      var target = Math.min(0.10, Math.abs(st.x.v) * 0.0009);
      st.stretch += (target - st.stretch) * Math.min(1, dt * 14);
      if (Math.abs(vx0) < 2) st.stretch *= 0.86;

      st.shown = true;
      render();

      if (settled(st.x, m.x) && settled(st.y, m.y) && settled(st.w, m.w) && settled(st.h, m.h) && st.stretch < 0.004) {
        st.x.x = m.x; st.y.x = m.y; st.w.x = m.w; st.h.x = m.h;
        st.stretch = 0;
        render();
        st.raf = 0;
        return;
      }
      st.raf = requestAnimationFrame(tick);
    }

    /* 选中变化：class 变动、点击、键盘/程序触发的 click 都覆盖到 */
    var mo = new MutationObserver(function (recs) {
      for (var i = 0; i < recs.length; i++) {
        if (recs[i].attributeName === 'class') { place(false); return; }
      }
    });
    tabs.forEach(function (t) { mo.observe(t, { attributes: true, attributeFilter: ['class'] }); });
    nav.addEventListener('click', function () { setTimeout(function () { place(false); }, 0); });

    if (window.ResizeObserver) new ResizeObserver(function () { place(false); }).observe(nav);
    window.addEventListener('resize', function () { place(false); });
    window.addEventListener('orientationchange', function () { place(false); });
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { place(true); });

    /* 胶囊上的高光跟着手指（`interactive()` 那层实时反光）。
       位置写像素，因为胶囊会随选中项移动，百分比对不上。 */
    function pillLight(e, strength) {
      var r = pill.getBoundingClientRect();
      if (!r.width || !r.height) return;
      pill.style.setProperty('--px', (e.clientX - r.left) + 'px');
      pill.style.setProperty('--py', (e.clientY - r.top) + 'px');
      pill.style.setProperty('--spec', strength);
    }
    nav.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.closest && e.target.closest('.tab')) pillLight(e, '1');
    });
    nav.addEventListener('pointermove', function (e) {
      if (nav.querySelector('.tab.pressing')) pillLight(e, '1');
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      nav.addEventListener(ev, function () { pill.style.setProperty('--spec', '0'); });
    });

    place(true);
    requestAnimationFrame(function () { place(false); });

    return { nav: nav, pill: pill, place: place, state: st };
  }

  /* ---------------- 指针交互（interactive） ---------------- */

  /* 高光位置写进 --gx/--gy（相对元素百分比），--spec 控制强度 */
  function trackPointer(el) {
    function setFrom(e, strength) {
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      el.style.setProperty('--gx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
      el.style.setProperty('--gy', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
      el.style.setProperty('--spec', strength);
    }
    el.addEventListener('pointerdown', function (e) {
      el.classList.add('pressing');
      setFrom(e, '1');
    });
    el.addEventListener('pointermove', function (e) {
      if (el.classList.contains('pressing')) setFrom(e, '1');
      else if (e.pointerType === 'mouse') setFrom(e, '0.35');
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(function (ev) {
      el.addEventListener(ev, function () {
        el.classList.remove('pressing');
        el.style.setProperty('--spec', '0');
      });
    });
    if (window.matchMedia && window.matchMedia('(hover: hover)').matches) {
      el.addEventListener('pointerenter', function (e) { setFrom(e, '0.35'); });
      el.addEventListener('pointerleave', function () { el.style.setProperty('--spec', '0'); });
    }
  }

  /* ---------------- 初始化 ---------------- */

  var navState = null;

  function init() {
    var nav = document.querySelector('nav.tabs');
    if (nav) {
      navState = mountNav(nav);
      if (navState) {
        /* 每个标签自己也要有按压反馈（Apple 的 interactive 是控件级的） */
        [].forEach.call(nav.querySelectorAll('.tab'), trackPointer);
      }
    }
    /* 浮动写入条：同样是「浮在内容之上」的控制层，给同一套指针响应 */
    var fw = document.getElementById('floatWriteBar');
    if (fw) trackPointer(fw);

    /* dock / rail 切换后重新量一次（尺寸与排布都变了） */
    if (window.ResizeObserver) {
      var lastMode = '';
      setInterval(function () {
        var mode = body.classList.contains('nav-rail') ? 'rail' : 'dock';
        if (mode !== lastMode) {
          lastMode = mode;
          if (navState) navState.place(false);
        }
      }, 300);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* 供冒烟脚本 / 调试读取 */
  window.ApxGlass = {
    refresh: function () { if (navState) navState.place(false); },
    /** 当前胶囊矩形（用于断言与视觉回归） */
    pillRect: function () {
      if (!navState) return null;
      var r = navState.pill.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    },
    mounted: function () { return !!navState; },
  };
})();
