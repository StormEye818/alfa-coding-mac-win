/**
 * AlfaProxi 移动端 UI 行为垫片。
 * 激活条件：Capacitor 原生壳 / ?mobile=1 / 小屏+粗指针。桌面端零影响。
 *
 * 职责：
 *   1) 连接区收成状态 chip + 底部动作单
 *   2) alert → toast（返回值无用的 38 处调用零改动受益）
 *   3) title tooltip → ⓘ 点按弹说明（触屏 hover 失效的 13 处）
 *   4) 防熄屏（连接期间）+ 进后台停实时轮询（点既有停止按钮，零耦合）
 */
(function () {
  const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  const smallTouch = window.matchMedia('(max-width: 720px), (pointer: coarse)').matches;
  const forced = /[?&]mobile=1/.test(location.search);
  if (!isNative && !forced && !smallTouch) return;

  document.body.classList.add('mobile');

  // 引入样式（带版本号防 WebView 跨启动缓存旧样式——真机踩过改了不生效）
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = './mobile.css?v=' + Date.now();
  document.head.appendChild(link);

  /* ---------- 0) 三态导航：dock / rail ----------
     判定只看「可用尺寸」，不看设备名：
       · 宽 ≥720 且 高 ≥560 → 右侧 Rail（duo 展开 1080×720、iPad 竖 820×1180）
       · 其余               → 底部 Dock（手机竖屏；手机横屏 852×393 因高度不足仍是底栏）
     桌面端不加 .mobile，走顶部标签，不受影响。
     Rail 的位置全部由 CSS 变量算（含 safe-area），这里只管加类。 */
  const RAIL_MIN_W = 720;
  const RAIL_MIN_H = 560;
  function applyNavMode() {
    if (!document.body.classList.contains('mobile')) {
      document.body.classList.remove('nav-dock', 'nav-rail');
      return;
    }
    const rail = window.innerWidth >= RAIL_MIN_W && window.innerHeight >= RAIL_MIN_H;
    document.body.classList.toggle('nav-rail', rail);
    document.body.classList.toggle('nav-dock', !rail);
  }
  applyNavMode();

  /* ---------- 0b) 双屏铰链（Surface Duo 类展开设备） ----------
     支持 viewport segments 的浏览器会命中 (horizontal-viewport-segments: 2)，
     此时 CSS 用 env(viewport-segment-*) 拿到每块屏的宽度与中缝；
     无头浏览器模拟不了，用 ?hinge=34 把两个变量写死来回归。 */
  const segMq = window.matchMedia('(horizontal-viewport-segments: 2)');
  const hingeArg = /[?&]hinge=([\d.]+)/.exec(location.search);
  function applyHinge() {
    const forced = hingeArg ? parseFloat(hingeArg[1]) : 0;
    const two = forced > 0 || segMq.matches;
    document.body.classList.toggle('hinge-2', two);
    const st = document.documentElement.style;
    if (forced > 0) {
      const seg = Math.max(200, Math.round((window.innerWidth - forced) / 2));
      st.setProperty('--seg-w', seg + 'px');
      st.setProperty('--hinge-w', forced + 'px');
    } else {
      st.removeProperty('--seg-w');
      st.removeProperty('--hinge-w');
    }
  }
  applyHinge();
  if (segMq.addEventListener) segMq.addEventListener('change', applyHinge);

  /* 调试用：?safe=59,34,47,47 覆盖安全区（无头浏览器无法模拟刘海，靠它做遮挡回归） */
  (function overrideSafeArea() {
    const m = /[?&]safe=([\d.]+),([\d.]+),([\d.]+),([\d.]+)/.exec(location.search);
    if (!m) return;
    const st = document.documentElement.style;
    st.setProperty('--safe-t', m[1] + 'px');
    st.setProperty('--safe-r', m[2] + 'px');
    st.setProperty('--safe-b', m[3] + 'px');
    st.setProperty('--safe-l', m[4] + 'px');
  })();

  /* 顶栏实际高度 → --header-h。
     右侧 Rail 必须从顶栏下方开始：顶栏自己吃 --safe-t（iOS 状态栏/刘海），
     这样无论 WebView 报不报 safe-area，Rail 都不会贴到右上角的电量/WiFi 上。
     顶栏内容会随「连接 chip / 车 ping」变化而换行，所以用 ResizeObserver 持续量。 */
  const headerEl = document.querySelector('header.top');
  function measureHeader() {
    if (!headerEl) return;
    const h = Math.round(headerEl.getBoundingClientRect().height);
    if (h > 0) document.documentElement.style.setProperty('--header-h', h + 'px');
  }
  measureHeader();
  requestAnimationFrame(measureHeader);          // 样式表刚注入时高度还会变，等一帧再量一次
  setTimeout(measureHeader, 150);
  if (headerEl && window.ResizeObserver) {
    new ResizeObserver(measureHeader).observe(headerEl);
  }

  /* ---------- 0c) 原生玻璃侧栏（iOS 26 Liquid Glass 适配层） ----------
     侧栏不由网页画，交给原生 UIGlassEffect（真正的系统玻璃 + 交互反馈）。
     这里只做三件事：把标签清单交给原生、切换时同步高亮、点按后回到网页切页。
     插件不存在（老安装包 / Android / 浏览器）时整段静默退出，网页侧栏照旧。 */
  function initNativeRail() {
    const cap = window.Capacitor;
    const headers = cap && cap.PluginHeaders;
    const has = !!(cap && typeof cap.nativePromise === 'function'
      && Array.isArray(headers) && headers.some((h) => h.name === 'GlassRail'));
    if (!has) return;

    const SYMBOL = {
      features: 'slider.horizontal.3',
      editor: 'square.grid.2x2',
      align: 'scope',
      live: 'waveform.path.ecg',
      funcs: 'bolt.fill',
      diag: 'square.stack.3d.up',
      pending: 'clock',
    };
    const nav = document.querySelector('nav.tabs');
    if (!nav) return;

    let shown = false;
    const listItems = () => [].slice.call(nav.querySelectorAll('.tab'))
      .filter((t) => !t.classList.contains('hidden'))
      .map((t) => ({
        id: t.dataset.tab,
        label: ((t.querySelector('.tab-label') || t).textContent || '').trim(),
        symbol: SYMBOL[t.dataset.tab] || 'circle',
      }));
    const activeId = () => {
      const a = nav.querySelector('.tab.active');
      return a ? a.dataset.tab : null;
    };

    function sync() {
      const want = document.body.classList.contains('nav-rail');
      if (want && !shown) {
        cap.nativePromise('GlassRail', 'show', { items: listItems(), activeId: activeId() })
          .then(() => { shown = true; document.body.classList.add('native-rail'); })
          .catch(() => {});
      } else if (!want && shown) {
        cap.nativePromise('GlassRail', 'hide', {}).catch(() => {});
        shown = false;
        document.body.classList.remove('native-rail');
      } else if (want && shown) {
        cap.nativePromise('GlassRail', 'setActive', { id: activeId() }).catch(() => {});
      }
    }
    window.__apxRailSync = sync;

    /* 原生点按 → 点一下对应标签，复用现成的切页逻辑 */
    window.APXRail = {
      select(id) {
        const t = nav.querySelector('.tab[data-tab="' + id + '"]');
        if (t) t.click();
      },
    };

    /* 网页自己切页（按钮/快捷键）时，把高亮同步回原生 */
    const mo = new MutationObserver(() => {
      if (shown) cap.nativePromise('GlassRail', 'setActive', { id: activeId() }).catch(() => {});
    });
    [].forEach.call(nav.querySelectorAll('.tab'), (t) => {
      mo.observe(t, { attributes: true, attributeFilter: ['class'] });
    });

    sync();
    setTimeout(sync, 120);
  }
  initNativeRail();

  let navTimer = 0;
  const onViewportChange = () => {
    measureHeader();
    clearTimeout(navTimer);
    navTimer = setTimeout(() => {
      applyNavMode();
      if (typeof window.__apxRailSync === 'function') window.__apxRailSync();
    }, 120);   // 旋转/折叠时防抖，避免来回抖
  };
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('orientationchange', onViewportChange);

  /* 键盘弹出：visualViewport 高度骤减 → 收起 Dock（iOS WebView 键盘是覆盖式的）。
     Android 走 adjustResize 时 WebView 自身变矮，fixed 底栏天然在键盘上方，不会触发。 */
  (function watchKeyboard() {
    const vv = window.visualViewport;
    if (!vv) return;
    const check = () => {
      const covered = window.innerHeight - vv.height;
      document.body.classList.toggle('kb-open', covered > 140);
    };
    vv.addEventListener('resize', check);
    vv.addEventListener('scroll', check);
  })();

  /* ---------- 1) 连接 chip + 底部动作单 ---------- */
  function initConnSheet() {
    const conn = document.querySelector('.conn');
    const top = document.querySelector('header.top');
    if (!conn || !top) return;

    const chip = document.createElement('button');
    chip.className = 'conn-chip';
    chip.innerHTML = '<span class="dot"></span><span class="txt">连接车辆</span>';
    top.appendChild(chip);

    const syncChip = () => {
      const st = document.getElementById('connState');
      const on = st && /已连接/.test(st.textContent || '');
      chip.classList.toggle('on', !!on);
      chip.querySelector('.txt').textContent = on
        ? ((st.textContent || '').replace(/^已连接：?/, '') || '已连接') + ' · 点此断开或重连'
        : '连接车辆 · 点此展开设置';
    };
    // 状态 pill 变化驱动 chip
    const st = document.getElementById('connState');
    if (st && window.MutationObserver) new MutationObserver(syncChip).observe(st, { childList: true, characterData: true, subtree: true });
    syncChip();

    chip.addEventListener('click', async () => {
      // 已连接 → 断开（复位状态）；未连接 → 展开设置面板
      const st = document.getElementById('connState');
      const on = st && /已连接/.test(st.textContent || '');
      if (on && window.__apxDisconnect) {
        await window.__apxDisconnect();
        syncChip();
        conn.classList.remove('mobile-open');
      } else {
        conn.classList.toggle('mobile-open');
      }
    });
  }

  /* ---------- 2) alert → toast ---------- */
  function toast(msg, ms) {
    document.querySelectorAll('.apx-toast').forEach((n) => n.remove());
    const t = document.createElement('div');
    t.className = 'apx-toast';
    t.textContent = String(msg);
    document.body.appendChild(t);
    // 长文本（测试结果等）驻留更久，点按即关
    const len = String(msg).length;
    const dur = ms || (len > 120 ? 12000 : len > 60 ? 8000 : 4500);
    setTimeout(() => t.remove(), dur);
    t.addEventListener('click', () => t.remove());
  }
  window.alert = (msg) => toast(msg);
  window.__apxToast = toast;   // 供 confirm 替代层复用

  /* ---------- 3) title tooltip → ⓘ 说明 ----------
   * 只处理非交互元素（卡片标题/统计块等）。按钮/下拉/输入框的 title 绝不拦截——
   * 否则点按钮弹的是说明而不是执行动作（2026-09-30 真机实测踩过：写入按钮被劫持）。
   * .hbyte/.bit-cell 也必须算交互元素：它们是可点的 div，被此系统处理后点击会被
   * 捕获阶段 stopPropagation 劫持成弹说明（2026-10-15 踩过：字节编辑器只能点开一次）。 */
  const INTERACTIVE = 'button, select, input, textarea, a, label, .opt, .hbyte, .bit-cell';   // 注：.help-btn 本身是触发器，不在其列
  function initTooltips() {
    document.querySelectorAll('[title]').forEach((n) => {
      const text = n.getAttribute('title');
      if (!text) return;
      n.removeAttribute('title');          // 触屏不触发 hover
      if (n.matches(INTERACTIVE) || n.closest(INTERACTIVE)) return;   // 交互元素：只去 title，不劫持点击
      n.setAttribute('data-help', text);
      if (!n.querySelector(':scope > .help-btn')) {
        const b = document.createElement('span');
        b.className = 'help-btn';
        b.textContent = '?';
        b.setAttribute('data-help', text);
        n.appendChild(b);
      }
    });

    if (!initTooltips._bound) {            // 只绑一次（此前每 3s 重复叠加监听）
      initTooltips._bound = true;
      document.addEventListener('click', (e) => {
        if (e.target.closest(INTERACTIVE)) return;   // 点在交互元素上绝不拦截
        const t = e.target.closest('[data-help]');
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        showHelp(t.getAttribute('data-help'));
      }, true);
    }
  }

  let helpSheet = null;
  function showHelp(text) {
    if (helpSheet) helpSheet.remove();
    helpSheet = document.createElement('div');
    helpSheet.className = 'help-sheet';
    helpSheet.textContent = text;
    const close = document.createElement('div');
    close.style.cssText = 'margin-top:12px;text-align:right';
    const btn = document.createElement('button');
    btn.textContent = '知道了';
    btn.style.cssText = 'min-width:120px;min-height:44px';
    const dismiss = () => { if (helpSheet) { helpSheet.remove(); helpSheet = null; } };
    btn.addEventListener('click', dismiss);
    close.appendChild(btn);
    helpSheet.appendChild(close);
    helpSheet.addEventListener('click', dismiss);   // 点说明层任意处也可关闭
    document.body.appendChild(helpSheet);
  }

  /* ---------- 3.5) 串口/蓝牙设备选择单 ----------
   * iOS WKWebView 对 <datalist> 下拉支持差（点了没反应）——移动端一律走底部选择单。
   * WiFi 型（placeholder 含 IP）保留文本输入。 */
  function initPortPicker() {
    const input = document.getElementById('ifacePort');
    const dl = document.getElementById('ifacePortList');
    if (!input || !dl) return;

    let sheet = null;
    const closeSheet = () => { if (sheet) { sheet.remove(); sheet = null; } };

    const renderSheet = (busy) => {
      if (!sheet) return;
      const list = sheet.querySelector('.pp-list');
      const opts = [...dl.querySelectorAll('option')].map((o) => ({ v: o.value, t: o.textContent }));
      list.innerHTML = opts.length
        ? opts.map((o) => `<button class="pp-item" data-v="${o.v}">${o.t} <small>${o.v.slice(0, 18)}</small></button>`).join('')
        : '<div class="dim" style="padding:12px">' + (busy ? '扫描中，请稍候…' : '未发现设备。点「重新扫描」或确认适配器已开机配对。') + '</div>';
      const rescan = sheet.querySelector('.pp-rescan');
      if (rescan) rescan.textContent = busy ? '扫描中…' : '重新扫描设备';
      // 诊断行（真机排障：扫描看到多少广播 / 失败原因）
      const diag = sheet.querySelector('.pp-diag');
      const s = window.__apxLastScan;
      if (diag) {
        if (!s) diag.textContent = busy ? '正在扫描…' : '';
        else {
          let t = '';
          if (s.mfi) {
            t += s.mfi.error ? 'MFi 枚举失败：' + s.mfi.error
              : `MFi 配件 ${s.mfi.count} 个${s.mfi.names.length ? '（' + s.mfi.names.join('；') + '）' : ''}`;
          }
          if (s.ok) t += (t ? ' · ' : '') + `BLE 广播 ${s.raw} 个 → 显示 ${s.shown} 个`;
          else if (!s.mfi) t = '⚠ 扫描失败：' + s.error + '（检查 设置→隐私→蓝牙 是否允许 AlfaProxi）';
          diag.textContent = t;
        }
      }
    };

    const openSheet = () => {
      closeSheet();
      sheet = document.createElement('div');
      sheet.className = 'help-sheet pp-sheet';
      sheet.innerHTML = '<div style="font-size:14px;font-weight:600;margin-bottom:8px">选择设备</div>' +
        '<div class="pp-list"></div>' +
        '<div class="pp-diag dim" style="margin-top:8px;font-size:11.5px"></div>' +
        '<div style="margin-top:12px;display:flex;gap:10px;justify-content:flex-end">' +
        '<button class="ghost small pp-rescan">重新扫描设备</button>' +
        '<button class="small pp-close" style="min-width:96px;min-height:44px">关闭</button></div>';
      document.body.appendChild(sheet);
      renderSheet(false);

      sheet.addEventListener('click', (e) => {
        const item = e.target.closest('.pp-item');
        if (item) {
          input.value = item.getAttribute('data-v');
          input.dispatchEvent(new Event('change', { bubbles: true }));
          closeSheet();
          return;
        }
        if (e.target.closest('.pp-rescan')) {
          renderSheet(true);
          // 触发既有刷新链路（ifaceType change → refreshPorts → 填充 datalist）
          document.getElementById('ifaceType').dispatchEvent(new Event('change', { bubbles: true }));
          setTimeout(() => renderSheet(false), 5500);
          return;
        }
        if (e.target.closest('.pp-close')) closeSheet();
      });
    };

    // 非 WiFi 型：输入框改为只读 + 点按弹选择单（不弹键盘）
    const syncMode = () => {
      const isWifi = /IP/.test(input.placeholder || '');
      if (isWifi) {
        input.removeAttribute('readonly');
        input.onfocus = null;
        input.onclick = null;       // 关键：切到 WiFi 后必须解除选择单拦截，否则无法输入 IP
      } else {
        input.setAttribute('readonly', 'readonly');
        input.onfocus = openSheet;
        input.onclick = openSheet;  // 用 onclick 覆盖，而非重复 addEventListener（否则切回 WiFi 仍有残留监听）
      }
    };
    syncMode();
    // 接口类型切换会重置 placeholder → 重新适配模式
    document.getElementById('ifaceType')?.addEventListener('change', () => setTimeout(syncMode, 50));
  }

  /* ---------- 4) 防熄屏 + 后台保护 ---------- */
  function initKeepAwake() {
    const Cap = window.Capacitor;
    const st = document.getElementById('connState');
    if (!st || !Cap || !Cap.Plugins || !Cap.Plugins.KeepAwake) return;
    const apply = () => {
      const on = /已连接/.test(st.textContent || '');
      try {
        if (on) Cap.Plugins.KeepAwake.keepAwake();
        else Cap.Plugins.KeepAwake.allowSleep();
      } catch {}
    };
    if (window.MutationObserver) new MutationObserver(apply).observe(st, { childList: true, characterData: true, subtree: true });
    apply();
  }

  function initBackgroundGuard() {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      // 进后台：停掉实时轮询（app.js 暴露的 __apxStopLive；此前找的 #btnLiveStop 元素不存在，
      // 这段一直是空操作，2026-10-18 审查 M8）
      try {
        if (window.__apxStopLive && window.__apxStopLive()) {
          window.__apxToast && window.__apxToast('已切到后台，实时数据自动停止');
        }
      } catch {}
    });
    // TODO(真机): PROXI 对齐长流程进行中切后台时给出强警示（需要 app.js 暴露流程状态）
  }

  // DOM 就绪后装配（app.js 的 load() 会重建部分节点，用 MutationObserver 补挂 tooltip）
  function boot() {
    initConnSheet();
    initPortPicker();
    initTooltips();
    initKeepAwake();
    initBackgroundGuard();
    // 动态渲染的节点（卡片/对齐行）也会带 title → 定时补扫
    setInterval(initTooltips, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
