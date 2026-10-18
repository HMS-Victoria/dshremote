/**
 * 移动端注入层：改写 DSH 的 index.html，注入我们的 PWA / 样式 / 脚本；
 * 同时提供 /__dshremote/* 静态资源与配对页。
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MOBILE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'mobile');

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.html': 'text/html; charset=utf-8',
};

/** 注入到 DSH index.html </head> 之前的内容。 */
const INJECTION = `
    <meta id="dshremote-meta" name="dshremote" content="1">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#0e1116" />
    <link rel="manifest" href="/__dshremote/manifest.webmanifest" />
    <link rel="stylesheet" href="/__dshremote/mobile.css" />
    <script type="module" src="/__dshremote/mobile.js"></script>
`;

/**
 * 必须在内核/DSH 客户端启动前执行的引导脚本（插到 <head> 最前）：
 *  - 注入真实视口高度变量 --dshremote-vh（规避部分 WebView 的 100vh=0）；
 *  - 包装 WebSocket，把连接关闭（code/reason/帧数/存活时间）上报到 daemon；
 *  - 上报未捕获 JS 异常，便于诊断手机端问题。
 */
const BOOT_INLINE = `
<script>
(function () {
  // ===== 旧内核 polyfill（华为 ArkWeb / 老 Chromium 缺少的 API）=====
  if (typeof Promise.withResolvers !== 'function') {
    Promise.withResolvers = function () {
      var resolve;
      var reject;
      var promise = new Promise(function (res, rej) { resolve = res; reject = rej; });
      return { promise: promise, resolve: resolve, reject: reject };
    };
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
    AbortSignal.any = function (signals) {
      var controller = new AbortController();
      var list = Array.prototype.slice.call(signals || []);
      var aborted = null;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].aborted) { aborted = list[i]; break; }
      }
      if (aborted) { controller.abort(aborted.reason); return controller.signal; }
      var entries = [];
      function cleanup() {
        entries.forEach(function (entry) {
          try { entry[0].removeEventListener('abort', entry[1]); } catch (error) { /* ignore */ }
        });
        entries = [];
      }
      list.forEach(function (signal) {
        if (!signal) return;
        var handler = function () { cleanup(); controller.abort(signal.reason); };
        entries.push([signal, handler]);
        signal.addEventListener('abort', handler, { once: true });
      });
      return controller.signal;
    };
  }
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.prototype.throwIfAborted !== 'function') {
    AbortSignal.prototype.throwIfAborted = function () {
      if (!this.aborted) return;
      throw this.reason === undefined ? new DOMException('This operation was aborted', 'AbortError') : this.reason;
    };
  }
  if (typeof window.structuredClone !== 'function') {
    window.structuredClone = function (value) {
      if (value === null || typeof value !== 'object') return value;
      try { return JSON.parse(JSON.stringify(value)); } catch (error) { return value; }
    };
  }
  if (!Array.prototype.toSorted) {
    Object.defineProperty(Array.prototype, 'toSorted', {
      configurable: true,
      writable: true,
      value: function (compare) { return Array.prototype.slice.call(this).sort(compare); }
    });
  }
  if (!Array.prototype.findLastIndex) {
    Object.defineProperty(Array.prototype, 'findLastIndex', {
      configurable: true,
      writable: true,
      value: function (predicate) {
        for (var index = this.length - 1; index >= 0; index -= 1) {
          if (predicate(this[index], index, this)) return index;
        }
        return -1;
      }
    });
  }
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID !== 'function') {
    try {
      Object.defineProperty(crypto, 'randomUUID', {
        configurable: true,
        value: function () {
          var bytes = new Uint8Array(16);
          crypto.getRandomValues(bytes);
          bytes[6] = (bytes[6] & 15) | 64;
          bytes[8] = (bytes[8] & 63) | 128;
          var hex = Array.prototype.map.call(bytes, function (byte) {
            return ('0' + byte.toString(16)).slice(-2);
          }).join('');
          return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
        }
      });
    } catch (error) { /* ignore */ }
  }
  if (typeof navigator !== 'undefined' && navigator && typeof navigator.clipboard === 'undefined') {
    try {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: function (text) {
            return new Promise(function (resolve, reject) {
              try {
                var area = document.createElement('textarea');
                area.value = String(text);
                area.style.position = 'fixed';
                area.style.opacity = '0';
                document.body.appendChild(area);
                area.focus();
                area.select();
                var ok = document.execCommand('copy');
                document.body.removeChild(area);
                if (ok) resolve(); else reject(new Error('copy unavailable'));
              } catch (error) { reject(error); }
            });
          },
          readText: function () { return Promise.reject(new Error('clipboard read unavailable')); }
        }
      });
    } catch (error) { /* ignore */ }
  }

  var root = document.documentElement;
  function applyViewport() {
    var height = window.innerHeight || root.clientHeight || 0;
    if (height > 0) root.style.setProperty('--dshremote-vh', height + 'px');
  }
  applyViewport();
  window.addEventListener('resize', applyViewport);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', applyViewport);

  var reported = 0;
  function report(payload) {
    try {
      if (reported > 20) return;
      reported += 1;
      fetch('/__dshremote/client-log', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function () {});
    } catch (error) { /* ignore */ }
  }
  window.__dshremoteReport = report;

  // 把 console.error 也上报，便于发现模块初始化失败之类的问题
  try {
    var nativeConsoleError = console.error.bind(console);
    console.error = function () {
      try {
        var message = Array.prototype.map.call(arguments, function (arg) {
          try {
            return typeof arg === 'string' ? arg : (arg && arg.message) ? arg.message : String(arg);
          } catch (error) { return ''; }
        }).join(' ');
        report({ event: 'console-error', message: message.slice(0, 300) });
      } catch (error) { /* ignore */ }
      nativeConsoleError.apply(null, arguments);
    };
  } catch (error) { /* ignore */ }

  var NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket === 'function') {
    // 供移动壳显示“连接断开”横幅：统计当前打开的 WebSocket 数量并广播变化。
    var wsState = { open: 0, total: 0 };
    window.__dshremoteWsState = wsState;
    function notifyWsChange() {
      try {
        window.dispatchEvent(new CustomEvent('dshremote-ws-change', { detail: { open: wsState.open } }));
      } catch (error) { /* ignore */ }
    }
    function DshremoteWebSocket(url, protocols) {
      var socket = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
      var info = { url: String(url), openedAt: 0, frames: 0 };
      socket.addEventListener('open', function () {
        info.openedAt = Date.now();
        wsState.open += 1;
        wsState.total += 1;
        notifyWsChange();
      });
      socket.addEventListener('message', function () { info.frames += 1; });
      socket.addEventListener('close', function (event) {
        wsState.open = Math.max(0, wsState.open - 1);
        notifyWsChange();
        report({
          event: 'ws-close',
          url: info.url,
          code: event.code,
          reason: (event.reason || '').slice(0, 120),
          frames: info.frames,
          durationMs: info.openedAt ? Date.now() - info.openedAt : 0
        });
      });
      return socket;
    }
    DshremoteWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    DshremoteWebSocket.OPEN = NativeWebSocket.OPEN;
    DshremoteWebSocket.CLOSING = NativeWebSocket.CLOSING;
    DshremoteWebSocket.CLOSED = NativeWebSocket.CLOSED;
    DshremoteWebSocket.prototype = NativeWebSocket.prototype;
    window.WebSocket = DshremoteWebSocket;
  }

  window.addEventListener('error', function (event) {
    report({
      event: 'js-error',
      message: String((event.message || '') + ' @' + (event.filename || '') + ':' + (event.lineno || 0)).slice(0, 300)
    });
  });
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason;
    report({
      event: 'unhandled-rejection',
      message: String(reason && reason.message ? reason.message : reason).slice(0, 300)
    });
  });

  // 真机排查：记录关键按钮点击，以及点击后菜单是否出现（含位置）
  function describeTarget(target) {
    try {
      if (!target || !target.closest) return null;
      var el = target.closest('[aria-label], button, [role="menuitem"]');
      if (!el) return null;
      var box = el.getBoundingClientRect();
      return {
        aria: el.getAttribute('aria-label'),
        cls: String(el.className).slice(0, 48),
        text: (el.textContent || '').trim().slice(0, 16),
        rect: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
        drawerOpen: document.documentElement.classList.contains('dsh-mobile-drawer-open')
      };
    } catch (error) { return null; }
  }
  function snapshotMenus() {
    try {
      return Array.prototype.map.call(document.querySelectorAll('[class*="_surface_ri079"]'), function (el) {
        var box = el.getBoundingClientRect();
        var style = getComputedStyle(el);
        var firstItem = el.querySelector('button');
        var itemBox = firstItem ? firstItem.getBoundingClientRect() : null;
        return {
          rect: [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)],
          text: (el.textContent || '').trim().slice(0, 26),
          style: {
            height: style.height,
            maxHeight: style.maxHeight,
            display: style.display,
            visibility: style.visibility,
            opacity: style.opacity,
            position: style.position,
            overflow: style.overflow,
            transform: style.transform,
            csHeight: el.clientHeight,
            scrollHeight: el.scrollHeight
          },
          firstItemRect: itemBox
            ? [Math.round(itemBox.x), Math.round(itemBox.y), Math.round(itemBox.width), Math.round(itemBox.height)]
            : null
        };
      });
    } catch (error) { return []; }
  }
  document.addEventListener('click', function (event) {
    try {
      var info = describeTarget(event.target);
      if (info === null) return;
      var interesting = /账号菜单|选择模型|访问模式|添加文件|设置/.test(info.aria || '');
      if (!interesting && !info.drawerOpen) return;
      report({ event: 'tap', message: JSON.stringify(info) });
      setTimeout(function () {
        report({ event: 'tap-menu', message: JSON.stringify({ aria: info.aria, menus: snapshotMenus() }) });
      }, 420);
    } catch (error) { /* ignore */ }
  }, true);

  // 上报视口尺寸，方便定位“底部被裁掉/滚动条错位”这类真机问题
  function probeHeight(unit) {
    try {
      var probe = document.createElement('div');
      probe.style.cssText = 'position:absolute;left:-9999px;top:0;width:1px;height:' + unit + ';visibility:hidden;pointer-events:none;';
      (document.body || document.documentElement).appendChild(probe);
      var value = probe.getBoundingClientRect().height;
      probe.remove();
      return Math.round(value);
    } catch (error) { return null; }
  }

  function reportViewport() {
    try {
      var viewport = window.visualViewport;
      report({
        event: 'viewport',
        message: JSON.stringify({
          shell: root.dataset.dshremoteVersion || null,
          url: location.href,
          innerW: window.innerWidth,
          innerH: window.innerHeight,
          vvW: viewport ? Math.round(viewport.width) : null,
          vvH: viewport ? Math.round(viewport.height) : null,
          docH: document.documentElement.clientHeight,
          bodyH: document.body ? document.body.clientHeight : null,
          dpr: window.devicePixelRatio,
          screenW: window.screen ? window.screen.width : null,
          screenH: window.screen ? window.screen.height : null,
          vh100: probeHeight('100vh'),
          dvh100: probeHeight('100dvh'),
          vhVar: getComputedStyle(root).getPropertyValue('--dshremote-vh').trim()
        })
      });
    } catch (error) { /* ignore */ }
  }
  window.addEventListener('load', function () {
    setTimeout(reportViewport, 900);
  });
  window.addEventListener('orientationchange', function () {
    setTimeout(reportViewport, 500);
  });
})();
</script>
<!-- dshremote-boot -->
`;

export function injectHtml(html) {
  if (typeof html !== 'string' || !html.includes('</head>')) return html;
  if (html.includes('id="dshremote-meta"')) return html;
  let output = html;
  if (!output.includes('<!-- dshremote-boot -->') && output.includes('<head>')) {
    output = output.replace('<head>', `<head>${BOOT_INLINE}`);
  }
  return output.replace('</head>', `${INJECTION}  </head>`);
}

/** 服务 /__dshremote/ 下的静态文件。 */
export async function serveMobileAsset(pathname, res) {
  const relative = pathname.slice('/__dshremote/'.length);
  const normalized = path.normalize(relative).replace(/^([/\\])+/u, '');
  if (!normalized || normalized.includes('..')) {
    res.writeHead(400).end('bad path');
    return;
  }
  const filePath = path.join(MOBILE_DIR, normalized);
  if (!filePath.startsWith(MOBILE_DIR) || !existsSync(filePath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
    return;
  }
  const body = await readFile(filePath);
  const type = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-store',
    'content-length': body.length,
  });
  res.end(body);
}

/** 配对页（浏览器）。pairUrl 存在时显示扫码二维码。 */
export function pairPageHtml({ error = null, code = null, pairUrl = null } = {}) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>DSH Remote · 配对</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: grid; place-items: center;
    background: #0e1116; color: #e6edf3; padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .card { width: min(420px, 100%); background: #161b22; border: 1px solid #30363d; border-radius: 16px; padding: 28px 24px; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  p { color: #8b949e; font-size: 14px; line-height: 1.6; margin: 0 0 16px; }
  .qr-wrap { display: grid; place-items: center; gap: 10px; margin: 4px 0 18px; }
  #qr { background: #fff; padding: 10px; border-radius: 12px; line-height: 0; }
  #qr svg { display: block; width: 200px; height: 200px; }
  .qr-hint { color: #6e7681; font-size: 12px; margin: 0; text-align: center; }
  .or { display: flex; align-items: center; gap: 10px; color: #6e7681; font-size: 12px; margin: 4px 0 14px; }
  .or::before, .or::after { content: ""; flex: 1; height: 1px; background: #30363d; }
  input {
    width: 100%; padding: 14px 16px; font-size: 22px; letter-spacing: 6px; text-align: center;
    background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 12px; outline: none;
  }
  input:focus { border-color: #4f8cff; }
  button {
    width: 100%; margin-top: 14px; padding: 14px 16px; font-size: 16px; font-weight: 600;
    background: #4f8cff; color: #fff; border: 0; border-radius: 12px;
  }
  button:active { opacity: .85; }
  .error { color: #ff7b72; font-size: 14px; margin: 12px 0 0; }
  .hint { color: #6e7681; font-size: 12px; margin-top: 18px; line-height: 1.6; }
  code { background: #0d1117; padding: 2px 6px; border-radius: 6px; }
</style>
</head>
<body>
  <main class="card">
    <h1>连接 DeepSeek Harness</h1>
    <p>${pairUrl ? '用手机 App 扫码即可配对；也可以手动输入配对码（一次性，配对后自动轮换）。' : '在电脑上启动 dshremote 后，控制台会打印 6 位配对码。输入即可让这台设备访问 DSH。'}</p>
    ${pairUrl ? `
    <div class="qr-wrap">
      <div id="qr" data-url="${escapeHtml(pairUrl)}" aria-label="配对二维码"></div>
      <p class="qr-hint">手机 App → 切换服务器 → 扫码配对</p>
    </div>
    <div class="or">或手动输入配对码</div>` : ''}
    <form method="get" action="/pair">
      <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" value="${code ? escapeHtml(code) : ''}" ${pairUrl ? '' : 'autofocus'} />
      <button type="submit">连接</button>
    </form>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <p class="hint">配对成功后，本设备会获得一个长期令牌。电脑上运行 <code>.\\tools\\devices.ps1</code> 可查看/吊销设备。</p>
  </main>
  <script src="/__dshremote/qr.js"></script>
  <script>
    (function () {
      try {
        var holder = document.getElementById('qr');
        if (!holder || typeof qrcode !== 'function') return;
        var url = holder.getAttribute('data-url');
        if (!url) return;
        var qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        holder.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, alt: '配对二维码' });
      } catch (error) { /* QR 渲染失败时仍可手动输入配对码 */ }
    })();
  </script>
</body>
</html>`;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
