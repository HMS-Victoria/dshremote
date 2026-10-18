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
const VERSION = '0.2.0';
const root = document.documentElement;

const SIDEBAR_SELECTOR = '[class*="BynINW_sidebarCol"]';
const FRAME_SELECTOR = '[class*="BynINW_frame"]';
const COLLAPSED_SELECTOR = '[class*="_collapsed"]';

root.classList.add('dsh-mobile');
root.dataset.dshremoteVersion = VERSION;

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
}

/** 点击会话项 / 新建会话后自动收起抽屉。 */
function installAutoClose() {
  document.addEventListener('click', (event) => {
    if (!isDrawerOpen()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    const inSidebar = target.closest(SIDEBAR_SELECTOR);
    if (inSidebar === null) return;
    const clickedSession = target.closest('[class*="sessionRow"], [class*="_newSession"]');
    if (clickedSession === null) return;
    setTimeout(() => {
      if (isDrawerOpen()) toggleDrawer();
    }, 60);
  }, true);
}

function init() {
  buildFab();
  installSidebarObserver();
  installFrameObserver();
  installBodyObserver();
  installAutoClose();
  installViewportClass();
  scheduleSync();
  if (location.hash.includes('dshremote-debug')) root.classList.add('dsh-mobile-debug');
  log(`mobile shell v${VERSION} ready (${window.innerWidth}x${window.innerHeight})`);
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
