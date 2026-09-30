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

  // 引入样式（桌面 index.html 不带；这里动态注入避免桌面多一次请求）
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = './mobile.css';
  document.head.appendChild(link);

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

    chip.addEventListener('click', () => {
      // 只展开/收起，不滚动页面（真机反馈：自动下滑很烦）
      conn.classList.toggle('mobile-open');
    });
  }

  /* ---------- 2) alert → toast ---------- */
  function toast(msg, ms) {
    document.querySelectorAll('.apx-toast').forEach((n) => n.remove());
    const t = document.createElement('div');
    t.className = 'apx-toast';
    t.textContent = String(msg);
    document.body.appendChild(t);
    setTimeout(() => t.remove(), ms || 4200);
    t.addEventListener('click', () => t.remove());
  }
  window.alert = (msg) => toast(msg);
  window.__apxToast = toast;   // 供 confirm 替代层复用

  /* ---------- 3) title tooltip → ⓘ 说明 ----------
   * 只处理非交互元素（卡片标题/统计块等）。按钮/下拉/输入框的 title 绝不拦截——
   * 否则点按钮弹的是说明而不是执行动作（2026-09-30 真机实测踩过：写入按钮被劫持）。 */
  const INTERACTIVE = 'button, select, input, textarea, a, label, .opt';   // 注：.help-btn 本身是触发器，不在其列
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
      // 进后台：若有实时轮询在跑，点既有停止按钮（零耦合，不触碰 app.js 内部状态）
      const stop = document.getElementById('btnLiveStop');
      if (stop && !stop.disabled) {
        try { stop.click(); window.__apxToast && window.__apxToast('已切到后台，实时数据自动停止'); } catch {}
      }
    });
    // TODO(真机): PROXI 对齐长流程进行中切后台时给出强警示（需要 app.js 暴露流程状态）
  }

  // DOM 就绪后装配（app.js 的 load() 会重建部分节点，用 MutationObserver 补挂 tooltip）
  function boot() {
    initConnSheet();
    initTooltips();
    initKeepAwake();
    initBackgroundGuard();
    // 动态渲染的节点（卡片/对齐行）也会带 title → 定时补扫
    setInterval(initTooltips, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
