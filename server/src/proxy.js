/**
 * 反向代理：把局域网请求转给 DSH 宿主（loopback），并完成三件事：
 *  1. 设备 cookie 鉴权（未配对只给配对页）；
 *  2. 注入上游 DSH 的签名 cookie，改写 Host/Origin；
 *  3. HTML 注入 + WebSocket 透传。
 */
import http from 'node:http';
import net from 'node:net';
import { deviceCookie } from './auth.js';
import { injectHtml, pairPageHtml, serveMobileAsset } from './inject.js';

const PAIR_API_PATH = '/__dshremote/pair';
const HEALTH_PATH = '/__dshremote/health';

export function createProxy({ upstream, devices, log }) {
  const upstreamUrl = new URL(upstream.origin);
  const failures = new Map();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      log(`[proxy] 处理失败 ${req.method} ${req.url}: ${error.stack ?? error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('dshremote: 代理失败');
      } else {
        res.destroy();
      }
    });
  });
  server.on('upgrade', handleUpgrade);
  return server;

  async function handleRequest(req, res) {
    const url = new URL(req.url ?? '/', 'http://dshremote.local');
    const pathname = url.pathname;

    if (pathname === HEALTH_PATH) {
      return sendJson(res, 200, { ok: true, upstream: upstream.origin, pid: process.pid });
    }
    if (pathname === PAIR_API_PATH && req.method === 'POST') {
      return handlePairApi(req, res);
    }
    if (pathname.startsWith('/__dshremote/')) {
      return serveMobileAsset(pathname, res);
    }
    if (pathname === '/pair') {
      return handlePairPage(req, res, url);
    }

    const device = devices.verifyCookie(req.headers.cookie);
    if (!device) {
      if (wantsHtml(req)) {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(pairPageHtml());
        return;
      }
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    return forward(req, res);
  }

  async function handlePairPage(req, res, url) {
    const code = url.searchParams.get('code');
    if (code) {
      if (devices.pairingCodeValid(code)) {
        const device = await devices.issueDevice('手机');
        log(`[auth] 新设备配对: ${device.id} (${device.name})`);
        res.writeHead(302, {
          'set-cookie': deviceCookie(device.token, isSecure(req)),
          location: '/',
          'cache-control': 'no-store',
        });
        res.end();
        return;
      }
      const key = clientKey(req);
      const count = (failures.get(key) ?? 0) + 1;
      failures.set(key, count);
      if (count > 20) {
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(pairPageHtml({ error: '尝试次数过多，请稍后再试' }));
        return;
      }
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(pairPageHtml({ error: code ? '配对码不正确或已过期' : null }));
  }

  async function handlePairApi(req, res) {
    const body = await readBody(req, 64 * 1024);
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      return sendJson(res, 400, { ok: false, error: 'invalid-json' });
    }
    if (!devices.pairingCodeValid(payload.code)) {
      return sendJson(res, 403, { ok: false, error: 'invalid-code' });
    }
    const device = await devices.issueDevice(payload.deviceName || 'Android');
    log(`[auth] 新设备配对（API）: ${device.id} (${device.name})`);
    return sendJson(res, 200, {
      ok: true,
      token: device.token,
      device: { id: device.id, name: device.name },
    });
  }

  function forward(req, res) {
    const targetPath = req.url ?? '/';
    const headers = { ...req.headers };
    headers.host = upstream.host;
    headers.cookie = upstream.cookie;
    headers.origin = upstream.origin;
    headers['sec-fetch-site'] = 'same-origin';
    delete headers['x-forwarded-for'];
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
    if (wantsHtml(req)) headers['accept-encoding'] = 'identity';

    const proxyReq = http.request({
      host: upstreamUrl.hostname,
      port: upstreamUrl.port,
      method: req.method,
      path: targetPath,
      headers,
    }, (proxyRes) => {
      const contentType = String(proxyRes.headers['content-type'] ?? '');
      const isHtml = proxyRes.statusCode === 200 && contentType.includes('text/html');
      if (!isHtml) {
        res.writeHead(proxyRes.statusCode ?? 502, cleanResponseHeaders(proxyRes.headers));
        proxyRes.pipe(res);
        return;
      }
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const html = injectHtml(Buffer.concat(chunks).toString('utf8'));
        const responseHeaders = cleanResponseHeaders(proxyRes.headers);
        delete responseHeaders['content-encoding'];
        responseHeaders['content-length'] = Buffer.byteLength(html);
        responseHeaders['cache-control'] = 'no-store';
        res.writeHead(proxyRes.statusCode ?? 200, responseHeaders);
        res.end(html);
      });
      proxyRes.on('error', () => res.destroy());
    });
    proxyReq.on('error', (error) => {
      log(`[proxy] 上游请求失败 ${req.method} ${req.url}: ${error.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('dshremote: DSH 宿主不可用');
      } else {
        res.destroy();
      }
    });
    req.pipe(proxyReq);
  }

  function handleUpgrade(req, socket, head) {
    const device = devices.verifyCookie(req.headers.cookie);
    if (!device) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstreamSocket = net.connect(Number(upstreamUrl.port), upstreamUrl.hostname, () => {
      const lines = [
        `GET ${req.url} HTTP/1.1`,
        `Host: ${upstream.host}`,
        `Cookie: ${upstream.cookie}`,
        `Origin: ${upstream.origin}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        `Sec-WebSocket-Key: ${req.headers['sec-websocket-key'] ?? ''}`,
      ];
      if (req.headers['sec-websocket-protocol']) {
        lines.push(`Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol']}`);
      }
      if (req.headers['sec-websocket-extensions']) {
        lines.push(`Sec-WebSocket-Extensions: ${req.headers['sec-websocket-extensions']}`);
      }
      upstreamSocket.write(lines.join('\r\n') + '\r\n\r\n');
      if (head?.length) upstreamSocket.write(head);
      socket.pipe(upstreamSocket);
      upstreamSocket.pipe(socket);
    });
    upstreamSocket.on('error', (error) => {
      log(`[proxy] WebSocket 上游错误: ${error.message}`);
      socket.destroy();
    });
    socket.on('error', () => upstreamSocket.destroy());
  }
}

function wantsHtml(req) {
  const accept = String(req.headers.accept ?? '');
  return accept.includes('text/html');
}

function isSecure(req) {
  return Boolean(req.socket.encrypted) || String(req.headers['x-forwarded-proto'] ?? '') === 'https';
}

function clientKey(req) {
  return req.socket.remoteAddress ?? 'unknown';
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function cleanResponseHeaders(headers) {
  const copy = { ...headers };
  delete copy['set-cookie'];
  delete copy['transfer-encoding'];
  delete copy['connection'];
  return copy;
}
