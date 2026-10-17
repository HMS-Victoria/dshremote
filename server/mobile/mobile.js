/**
 * dshremote 移动端注入脚本。
 *
 * Phase 0：只做无侵入的标记与调试信息，证明注入链路可用。
 * 后续在这里：
 *  - 移动端布局类名切换 / 侧栏抽屉化
 *  - 与 Android 原生外壳的 JS 桥（window.DshRemoteNative）通信
 *  - 审批 / 完成状态的上报钩子
 */
const VERSION = '0.1.0';
const root = document.documentElement;

root.classList.add('dsh-mobile');
root.dataset.dshremoteVersion = VERSION;

function log(...args) {
  console.log('[dshremote]', ...args);
}

function installViewportClass() {
  const query = window.matchMedia('(max-width: 820px)');
  const sync = () => root.classList.toggle('dsh-mobile-narrow', query.matches);
  sync();
  query.addEventListener?.('change', sync);
}

/** 原生外壳（Android WebView）会注入 window.DshRemoteNative。 */
function installNativeBridge() {
  const native = window.DshRemoteNative;
  if (!native) return;
  log('native bridge detected');
  native.onReady?.(VERSION);
}

function main() {
  installViewportClass();
  installNativeBridge();
  log(`mobile injection v${VERSION} loaded, ${window.innerWidth}x${window.innerHeight}`);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main, { once: true });
} else {
  main();
}
