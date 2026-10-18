/**
 * dshremote 移动端注入脚本。
 *
 * 设计原则：不改 DSH 源码，只做"移动端外壳"：
 *  - 隐藏原本常驻的窄导航条，改为左上角悬浮菜单按钮；
 *  - 复用 DSH 自己的侧边栏展开/收起逻辑（点击它自己的 toggle 按钮），
 *    把展开后的侧边栏变成覆盖式抽屉（定位样式在 mobile.css）；
 *  - 抽屉打开时显示遮罩；点遮罩或会话项自动收起；
 *  - 通过 MutationObserver 同步 DSH 自己切换的状态。
 */
const VERSION = '0.4.1';
const root = document.documentElement;

const SIDEBAR_SELECTOR = '[class*="BynINW_sidebarCol"]';
const FRAME_SELECTOR = '[class*="BynINW_frame"]';
const COLLAPSED_SELECTOR = '[class*="_collapsed"]';

root.classList.add('dsh-mobile');
root.dataset.dshremoteVersion = VERSION;

/**
 * 兜底：部分 WebView（旧内核/模拟器）里 100vh / 100dvh / 100% 会算成 0，
 * 导致整个 DSH 布局高度为 0、页面全黑。这里把真实视口高度写成 CSS 变量，
 * mobile.css 里用它兜底撑开 html/body/#root。
 */
function installViewportHeight() {
  const apply = () => {
    const height = window.innerHeight || document.documentElement.clientHeight || 0;
    if (height > 0) root.style.setProperty('--dshremote-vh', `${height}px`);
  };
  apply();
  window.addEventListener('resize', apply);
  window.visualViewport?.addEventListener('resize', apply);
}

installViewportHeight();

function log(...args) {
  console.log('[dshremote]', ...args);
}

let fab = null;
let backdrop = null;
let sidebarObserver = null;
let frameObserver = null;
let bodyObserver = null;
let syncScheduled = false;

function sidebar() {
  return document.querySelector(SIDEBAR_SELECTOR);
}

function frame() {
  return document.querySelector(FRAME_SELECTOR);
}

/** 右侧栏打开时 DSH 会给面板挂 data-sidebar-right-open（窄视口下自动全屏）。 */
function isRightOpen() {
  return document.querySelector('[data-sidebar-right-open]') !== null;
}

/** 设置等模态覆盖层（wCInkW_overlay）。 */
function isModalOpen() {
  return document.querySelector('[class*="wCInkW_overlay"]') !== null;
}

/** 侧栏展开状态：优先读 frame 的 data-sidebar-collapsed，旧版本回退到 class。 */
function isDrawerOpen() {
  const el = frame();
  if (el !== null && el.hasAttribute('data-sidebar-collapsed')) {
    return el.getAttribute('data-sidebar-collapsed') !== 'true';
  }
  const side = sidebar();
  return Boolean(side) && side.querySelector(COLLAPSED_SELECTOR) === null;
}

function scheduleSync() {
  if (syncScheduled) return;
  syncScheduled = true;
  requestAnimationFrame(() => {
    syncScheduled = false;
    syncDrawer();
  });
}

function syncDrawer() {
  const drawerOpen = isDrawerOpen();
  const rightPanelOpen = isRightOpen();
  const modalOpen = isModalOpen();
  root.classList.toggle('dsh-mobile-drawer-open', drawerOpen);
  root.classList.toggle('dsh-mobile-right-open', rightPanelOpen);
  root.classList.toggle('dsh-mobile-modal-open', modalOpen);
  if (fab !== null) fab.setAttribute('aria-expanded', String(drawerOpen));
  // 打开设置等模态框时，顺手收起移动端抽屉，避免背后残留
  if (modalOpen && drawerOpen) toggleDrawer();
}

function buildFab() {
  if (fab !== null) return;
  fab = document.createElement('button');
  fab.className = 'dshremote-fab';
  fab.type = 'button';
  fab.setAttribute('aria-label', '打开菜单');
  fab.setAttribute('aria-expanded', 'false');
  fab.innerHTML = `
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" aria-hidden="true">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>`;
  fab.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleDrawer();
  });
  document.body.appendChild(fab);

  backdrop = document.createElement('div');
  backdrop.className = 'dshremote-backdrop';
  backdrop.addEventListener('click', () => {
    if (isDrawerOpen()) toggleDrawer();
    else closeRightBar();
  });
  document.body.appendChild(backdrop);
}

function toggleDrawer() {
  const el = sidebar();
  if (el === null) return;
  const toggle = el.querySelector('[aria-label="打开侧边栏"], [aria-label="收起侧边栏"], [class*="_toggle"]');
  if (toggle === null) {
    log('找不到侧边栏 toggle 按钮');
    return;
  }
  toggle.click();
  // DSH 更新是异步的，稍后再同步状态
  setTimeout(scheduleSync, 80);
  setTimeout(scheduleSync, 260);
}

/** 右侧边栏（文件预览等）在移动端覆盖全屏；关闭时点遮罩。 */
function closeRightBar() {
  if (!isRightOpen()) return;
  const button = document.querySelector('[aria-label="收起右侧边栏"]')
    ?? document.querySelector('[class*="BynINW_rightbarCol"] [aria-label*="收起"]');
  if (button !== null) button.click();
  setTimeout(scheduleSync, 80);
  setTimeout(scheduleSync, 260);
}

function installSidebarObserver() {
  const el = sidebar();
  if (el === null || sidebarObserver !== null) return;
  sidebarObserver = new MutationObserver(scheduleSync);
  sidebarObserver.observe(el, { subtree: true, attributes: true, attributeFilter: ['class'] });
  log('sidebar observer installed');
  scheduleSync();
}

/** DSH 打开右侧栏时会挂 data-sidebar-right-open；窄视口下自动全屏。
 *  设置等模态框出现/消失通过 childList 侦测。 */
function installBodyObserver() {
  if (bodyObserver !== null) return;
  bodyObserver = new MutationObserver(scheduleSync);
  bodyObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-sidebar-right-open', 'data-sidebar-collapsed', 'data-rightbar-collapsed', 'data-rightbar-fullscreen'],
  });
  log('body observer installed');
}

/** frame 上的内联 grid/flex 与 data-* 属性变化都同步一次状态。 */
function installFrameObserver() {
  const el = frame();
  if (el === null || frameObserver !== null) return;
  frameObserver = new MutationObserver(scheduleSync);
  frameObserver.observe(el, {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-sidebar-collapsed', 'data-rightbar-collapsed', 'data-rightbar-fullscreen'],
  });
  scheduleSync();
}

function installViewportClass() {
  const query = window.matchMedia('(max-width: 820px)');
  const sync = () => root.classList.toggle('dsh-mobile-narrow', query.matches);
  sync();
  query.addEventListener?.('change', sync);

  // 用 JS 判定“矮横屏”，而不是依赖 CSS 的 orientation 媒体查询：
  // 部分 WebView（华为 ArkWeb）旋转后不会重新求值 orientation，导致横屏样式
  // 被带进竖屏（抽屉变窄、文字被裁）。这里在 resize/orientationchange 时重新计算。
  const syncLandscape = () => {
    const short = window.innerHeight < 520 && window.innerWidth > window.innerHeight;
    root.classList.toggle('dsh-mobile-landscape', short);
  };
  syncLandscape();
  window.addEventListener('resize', syncLandscape);
  window.addEventListener('orientationchange', () => setTimeout(syncLandscape, 300));
  window.visualViewport?.addEventListener('resize', syncLandscape);
  setInterval(syncLandscape, 2000);
}

/** 点击会话项 / 新建会话 / 插件 / 自动化任务后自动收起抽屉（这些会在主区域打开面板）。 */
function installAutoClose() {
  document.addEventListener('click', (event) => {
    if (!isDrawerOpen()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    const inSidebar = target.closest(SIDEBAR_SELECTOR);
    if (inSidebar === null) return;
    // 会话行右侧的「归档 / 置顶」按钮不打开会话，不要自动收起抽屉
    if (target.closest('[class*="rowActions"]') !== null) return;
    const clickedSession = target.closest(
      '[class*="sessionRow"], [class*="_newSession"], [class*="_panelRow"], [class*="_brand"]',
    );
    if (clickedSession === null) return;
    setTimeout(() => {
      if (isDrawerOpen()) toggleDrawer();
    }, 60);
  }, true);
}

/**
 * 断线提示：页面内 WebSocket 全部断开（或手机网络断开）时显示顶部横幅，
 * 恢复后自动隐藏。用于 daemon/电脑端断开、手机切换网络等场景。
 */
function installConnectionBanner() {
  if (document.querySelector('.dshremote-conn-banner') !== null) return;
  const banner = document.createElement('div');
  banner.className = 'dshremote-conn-banner';
  banner.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.className = 'dshremote-conn-text';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'dshremote-conn-retry';
  retry.textContent = '重试';
  retry.addEventListener('click', () => {
    location.reload();
  });
  banner.append(text, retry);
  document.body.appendChild(banner);

  const loadedAt = Date.now();
  let connectedOnce = false;
  const update = () => {
    const state = window.__dshremoteWsState ?? { open: 0 };
    const open = Number(state.open) || 0;
    if (open > 0) {
      connectedOnce = true;
      banner.dataset.visible = 'false';
      return;
    }
    const offline = navigator.onLine === false;
    const waitedLong = Date.now() - loadedAt > 8000;
    const hasNativeMenu = typeof window.DshRemoteNative?.showMenu === 'function';
    let message = null;
    if (offline) message = '手机网络已断开';
    else if (connectedOnce || waitedLong) {
      message = hasNativeMenu
        ? '与电脑的连接已断开，正在重新连接…（按返回键可打开连接菜单）'
        : '与电脑的连接已断开，正在重新连接…';
    }
    if (message === null) {
      banner.dataset.visible = 'false';
      return;
    }
    text.textContent = message;
    banner.dataset.visible = 'true';
  };

  window.addEventListener('dshremote-ws-change', update);
  window.addEventListener('online', () => { setTimeout(update, 400); });
  window.addEventListener('offline', update);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') update();
  });
  setInterval(update, 3000);
  update();

  // 调试钩子：window.dshremoteDebugConnection(true/false)
  window.dshremoteDebugConnection = (visible) => {
    if (visible && text.textContent === '') {
      text.textContent = '与电脑的连接已断开，正在重新连接…';
    }
    banner.dataset.visible = visible ? 'true' : 'false';
    if (!visible) connectedOnce = true;
  };
}

/**
 * 抽屉底部的连接状态行：显示已连接/已断开，点按重连或打开原生连接菜单。
 */
function installStatusRow() {
  if (document.querySelector('.dshremote-status-row') !== null) return;
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'dshremote-status-row';
  row.innerHTML = '<span class="dshremote-status-dot"></span><span class="dshremote-status-text">连接中…</span>';
  document.body.appendChild(row);

  const label = row.querySelector('.dshremote-status-text');
  row.addEventListener('click', () => {
    const open = Number(window.__dshremoteWsState?.open) || 0;
    if (open > 0 && typeof window.DshRemoteNative?.showMenu === 'function') {
      window.DshRemoteNative.showMenu();
    } else {
      location.reload();
    }
  });

  const update = () => {
    const open = Number(window.__dshremoteWsState?.open) || 0;
    row.dataset.state = open > 0 ? 'on' : 'off';
    label.textContent = open > 0 ? '已连接 · 点按打开连接菜单' : '连接已断开 · 点按重连';
  };
  window.addEventListener('dshremote-ws-change', update);
  setInterval(update, 3000);
  update();
}

/**
 * 会话行的「归档 / 置顶」按钮在触屏上常显（CSS 里强制 display），
 * 但 DSH 行本身绑定了整行的 onClick（打开会话），点击按钮会冒泡到行 → 直接跳进对话。
 * 这里在捕获阶段拦住这类点击，并直接调用按钮自己的 React onClick，避免触发整行跳转。
 */
function installRowActionClicks() {
  const findReactProps = (el) => {
    const key = Object.keys(el).find((name) => name.startsWith('__reactProps$'));
    return key ? el[key] : null;
  };
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    if (target.closest('[class*="rowActions"]') === null) return;
    const button = target.closest('button');
    if (button === null) return;
    // 只处理会话行的操作按钮（编辑弹窗等其它 rowActions 保持原行为）
    const row = button.closest('[class*="sessionRow"]');
    if (row === null) return;
    const props = findReactProps(button);
    if (!props || typeof props.onClick !== 'function') return;
    event.stopPropagation();
    event.preventDefault();
    try {
      props.onClick(event);
    } catch (error) {
      /* 交回默认行为（会冒泡到行），至少不会卡死 */
    }
  }, true);
}

/** 底部轻提示。 */
function showToast(message, duration = 2800) {
  let toast = document.querySelector('.dshremote-toast');
  if (toast === null) {
    toast = document.createElement('div');
    toast.className = 'dshremote-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.dataset.visible = 'true';
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.dataset.visible = 'false';
  }, duration);
}

/** 调用宿主 API（与网页界面相同的 /api/<namespace>/<method> RPC 信封）。 */
async function hostRpc(method, args) {
  const response = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method,
      payload: { args },
    }),
  });
  const envelope = await response.json().catch(() => null);
  const result = envelope?.result;
  if (result?.ok !== true) {
    throw new Error(result?.error?.message || `请求失败（HTTP ${response.status}）`);
  }
  return result.value;
}

/**
 * 手机端「添加工作区」。
 *
 * DSH 桌面端的“添加工作区”会调用主机原生目录选择器（只会在电脑上弹窗，手机上没反应）。
 * 这里拦截该按钮，改用 daemon 的目录浏览接口（/__dshremote/fs）在手机上选目录，
 * 选好后调用宿主的 workspace/create 注册工作区（宿主会推送更新，侧边栏自动刷新）。
 */
function installWorkspacePicker() {
  let overlay = null;
  let listing = null;
  let busy = false;
  let showHidden = false;

  const close = () => {
    if (overlay !== null) overlay.remove();
    overlay = null;
    listing = null;
    busy = false;
  };

  const setStatus = (state, message) => {
    if (overlay === null) return;
    const confirmButton = overlay.querySelector('.dshremote-ws-confirm');
    const cancelButton = overlay.querySelector('.dshremote-ws-cancel');
    const errorBox = overlay.querySelector('.dshremote-ws-error');
    confirmButton.disabled = state === 'loading' || state === 'error' || listing === null;
    cancelButton.disabled = state === 'loading';
    confirmButton.textContent = state === 'loading' ? '加载中…' : state === 'saving' ? '添加中…' : '选择此文件夹';
    confirmButton.disabled = confirmButton.disabled || state === 'saving';
    if (state === 'saving') {
      confirmButton.textContent = '添加中…';
      confirmButton.disabled = true;
    }
    errorBox.hidden = state !== 'error';
    if (state === 'error') errorBox.textContent = message || '操作失败';
  };

  const renderList = () => {
    if (overlay === null || listing === null) return;
    overlay.querySelector('.dshremote-ws-path').textContent = listing.path;
    overlay.querySelector('.dshremote-ws-path').dataset.path = listing.path;
    const list = overlay.querySelector('.dshremote-ws-list');
    list.textContent = '';

    const addRow = (icon, label, onClick, className) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `dshremote-ws-row ${className ?? ''}`.trim();
      row.innerHTML = `<span class="dshremote-ws-icon">${icon}</span><span class="dshremote-ws-name"></span>`;
      row.querySelector('.dshremote-ws-name').textContent = label;
      row.addEventListener('click', onClick);
      list.appendChild(row);
    };

    if (listing.parent !== null) {
      addRow('↑', '上一级', () => { void load(listing.parent); }, 'dshremote-ws-row-parent');
    }
    if (listing.drives.length > 1) {
      const drives = document.createElement('div');
      drives.className = 'dshremote-ws-drives';
      for (const drive of listing.drives) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'dshremote-ws-drive';
        chip.textContent = drive.replace(/\\$/u, '');
        chip.addEventListener('click', () => { void load(drive); });
        drives.appendChild(chip);
      }
      list.appendChild(drives);
    }
    const visibleEntries = showHidden ? listing.entries : listing.entries.filter((entry) => !entry.hidden);
    if (visibleEntries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dshremote-ws-empty';
      empty.textContent = showHidden ? '这个文件夹里没有子文件夹' : '没有可显示的文件夹（可点下方「显示隐藏文件夹」）';
      list.appendChild(empty);
    }
    const folderIcon = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M1.5 4.5c0-.55.45-1 1-1h3.2l1.2 1.5h6.1c.55 0 1 .45 1 1v6c0 .55-.45 1-1 1h-10.5c-.55 0-1-.45-1-1v-7.5Z" stroke="currentColor" stroke-width="1.2"/></svg>';
    for (const entry of visibleEntries) {
      addRow(folderIcon, entry.name, () => { void load(entry.path); });
    }
    const hiddenCount = listing.entries.length - visibleEntries.length;
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'dshremote-ws-toggle';
    toggle.textContent = showHidden ? '隐藏隐藏文件夹' : `显示隐藏文件夹${hiddenCount > 0 ? `（${hiddenCount}）` : ''}`;
    toggle.addEventListener('click', () => {
      showHidden = !showHidden;
      renderList();
    });
    list.appendChild(toggle);
    setStatus(visibleEntries.length === 0 ? 'empty' : 'ready');
  };

  async function load(pathValue) {
    if (overlay === null) return;
    busy = true;
    setStatus('loading');
    try {
      const params = new URLSearchParams();
      if (typeof pathValue === 'string' && pathValue !== '') params.set('path', pathValue);
      const response = await fetch(`/__dshremote/fs?${params.toString()}`, { headers: { accept: 'application/json' } });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error || `无法读取目录（HTTP ${response.status}）`);
      }
      listing = payload;
      busy = false;
      renderList();
    } catch (error) {
      busy = false;
      listing = null;
      setStatus('error', error instanceof Error ? error.message : String(error));
    }
  }

  async function confirm() {
    if (busy || listing === null) return;
    busy = true;
    const targetPath = listing.path;
    setStatus('saving');
    try {
      const value = await hostRpc('workspace/create', { request: { path: targetPath } });
      const title = value?.workspace?.title || targetPath;
      const created = value?.created !== false;
      close();
      showToast(created ? `已添加工作区：${title}` : `工作区已存在：${title}`);
    } catch (error) {
      busy = false;
      setStatus('error', error instanceof Error ? error.message : String(error));
    }
  }

  function open() {
    if (overlay !== null) return;
    const element = document.createElement('div');
    element.className = 'dshremote-ws-overlay';
    element.innerHTML = `
      <div class="dshremote-ws-sheet" role="dialog" aria-label="添加工作区">
        <div class="dshremote-ws-head">
          <span class="dshremote-ws-title">添加工作区</span>
          <button type="button" class="dshremote-ws-close" aria-label="关闭">✕</button>
        </div>
        <div class="dshremote-ws-path"></div>
        <div class="dshremote-ws-list"></div>
        <div class="dshremote-ws-error" hidden></div>
        <div class="dshremote-ws-actions">
          <button type="button" class="dshremote-ws-cancel">取消</button>
          <button type="button" class="dshremote-ws-confirm">选择此文件夹</button>
        </div>
      </div>`;
    element.addEventListener('click', (event) => {
      if (event.target === element) close();
    });
    element.querySelector('.dshremote-ws-close').addEventListener('click', close);
    element.querySelector('.dshremote-ws-cancel').addEventListener('click', close);
    element.querySelector('.dshremote-ws-confirm').addEventListener('click', () => { void confirm(); });
    document.body.appendChild(element);
    overlay = element;
    setStatus('loading');
    void load('');
  }

  // 拦截 DSH 自己的“添加工作区”按钮（它会打开电脑上的原生选择器）
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    const button = target.closest('button, [role="button"]');
    if (button === null) return;
    const label = button.getAttribute('aria-label') || '';
    if (!label.includes('添加工作区')) return;
    event.preventDefault();
    event.stopPropagation();
    open();
  }, true);
}

function init() {
  buildFab();
  installSidebarObserver();
  installFrameObserver();
  installBodyObserver();
  installAutoClose();
  installViewportClass();
  installConnectionBanner();
  installStatusRow();
  installRowActionClicks();
  installWorkspacePicker();
  scheduleSync();

  // 原生外壳（Android）返回键：优先关闭抽屉/右栏，返回 true 表示已消费
  window.dshremoteGoBack = () => {
    if (isDrawerOpen()) {
      toggleDrawer();
      return true;
    }
    if (isRightOpen()) {
      closeRightBar();
      return true;
    }
    return false;
  };

  // 原生菜单“设置”入口：打开抽屉 → 点头像 → 点“设置”
  window.dshremoteOpenSettings = () => {
    try {
      if (!isDrawerOpen()) toggleDrawer();
      setTimeout(() => {
        const account = document.querySelector('[aria-label="账号菜单"]');
        if (account === null) return;
        account.click();
        setTimeout(() => {
          const menu = document.querySelector('[class*="_surface_ri079"]');
          const item = menu === null
            ? null
            : [...menu.querySelectorAll('button')].find((button) => (button.textContent || '').trim().startsWith('设置'));
          item?.click();
        }, 260);
      }, 260);
    } catch (error) {
      log(`打开设置失败: ${error}`);
    }
  };

  // 通知点击：打开指定会话。会话行带 data-row-key="session:<id>"，
  // 抽屉未展开时先展开（会话行可能还没渲染，原生侧会重试）。
  window.dshremoteOpenSession = (sessionId) => {
    try {
      const selector = `[data-row-key="session:${String(sessionId)}"]`;
      let row = document.querySelector(selector);
      if (row === null && !isDrawerOpen()) {
        toggleDrawer();
        row = document.querySelector(selector);
      }
      if (row === null) return false;
      row.scrollIntoView({ block: 'center' });
      row.click();
      return true;
    } catch (error) {
      log(`打开会话失败: ${error}`);
      return false;
    }
  };

  if (location.hash.includes('dshremote-debug')) root.classList.add('dsh-mobile-debug');
  log(`mobile shell v${VERSION} ready (${window.innerWidth}x${window.innerHeight})`);
  window.__dshremoteReport?.({
    event: 'boot',
    message: JSON.stringify({
      version: VERSION,
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
      ua: navigator.userAgent.slice(0, 90),
    }),
  });
}

function waitForSidebar(attempt = 0) {
  if (sidebar() !== null) {
    init();
    return;
  }
  if (attempt > 300) {
    log('等待侧边栏超时');
    return;
  }
  setTimeout(() => waitForSidebar(attempt + 1), 100);
}

function main() {
  if (document.querySelector('.dshremote-fab') === null) waitForSidebar();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main, { once: true });
} else {
  main();
}
