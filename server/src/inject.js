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

export function injectHtml(html) {
  if (typeof html !== 'string' || !html.includes('</head>')) return html;
  if (html.includes('id="dshremote-meta"')) return html;
  return html.replace('</head>', `${INJECTION}  </head>`);
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

/** 配对页（浏览器）。 */
export function pairPageHtml({ error = null, code = null } = {}) {
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
    <p>在电脑上启动 dshremote 后，控制台会打印 6 位配对码。输入即可让这台设备访问 DSH。</p>
    <form method="get" action="/pair">
      <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" placeholder="000000" value="${code ? escapeHtml(code) : ''}" autofocus />
      <button type="submit">连接</button>
    </form>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
    <p class="hint">配对成功后，本设备会获得一个长期令牌。电脑上的 <code>.data/devices.json</code> 可查看/撤销。</p>
  </main>
</body>
</html>`;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/gu, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
