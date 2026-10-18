/**
 * 反向代理：把局域网请求转给 DSH 宿主（loopback），并完成三件事：
 *  1. 设备 cookie 鉴权（未配对只给配对页）；
 *  2. 注入上游 DSH 的签名 cookie，改写 Host/Origin；
 *  3. HTML 注入 + WebSocket 透传。
 */
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { deviceCookie } from './auth.js';
import { injectHtml, pairPageHtml, serveMobileAsset } from './inject.js';

const PAIR_API_PATH = '/__dshremote/pair';
const HEALTH_PATH = '/__dshremote/health';
const DIAG_PATH = '/__dshremote/diag';
const CLIENT_LOG_PATH = '/__dshremote/client-log';
const EVENTS_PATH = '/__dshremote/events';
const EVENTS_RECENT_PATH = '/__dshremote/events/recent';
const DIAG_LIMIT = 1200;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * @param {object} options
 * @param {() => { origin: string, host: string, cookie: string }} options.getUpstream
 *   每次请求时读取当前上游（宿主可能被插件重新导出/重启，由 daemon 热切换）。
 * @param {{ getRecent: (limit?: number) => object[], subscribe: (fn: (event: object) => void) => () => void }} [options.eventBus]
 *   宿主事件总线（审批/轮次等），用于 `/__dshremote/events` 推送。
 */
export function createProxy({ getUpstream, devices, log, eventBus }) {
  const failures = new Map();
  const events = [];

  /** 诊断环形缓冲：记录 WS 握手/关闭、客户端上报与 API 请求，供 /__dshremote/diag 查看。 */
  const record = (event) => {
    const entry = { at: new Date().toISOString(), ...event };
    events.push(entry);
    if (events.length > DIAG_LIMIT) {
      // 缓冲满时优先丢弃最旧的普通 API 记录，保留客户端上报/连接事件
      const apiIndex = events.findIndex((item) => item.kind === 'api');
      events.splice(apiIndex >= 0 ? apiIndex : 0, 1);
    }
    if (event.kind !== 'api') log(`[diag] ${JSON.stringify(entry)}`);
    return entry;
  };

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
      return sendJson(res, 200, { ok: true, upstream: getUpstream().origin, pid: process.pid });
    }
    if (pathname === DIAG_PATH) {
      const ip = req.socket.remoteAddress ?? '';
      if (!isLoopback(ip)) return sendJson(res, 403, { ok: false, error: 'loopback-only' });
      return sendJson(res, 200, { ok: true, now: new Date().toISOString(), upstream: getUpstream().origin, events });
    }
    if (pathname === PAIR_API_PATH && req.method === 'POST') {
      return handlePairApi(req, res);
    }
    if (pathname === CLIENT_LOG_PATH && req.method === 'POST') {
      return handleClientLog(req, res);
    }
    if (pathname === EVENTS_RECENT_PATH && req.method === 'GET') {
      const device = devices.verifyCookie(req.headers.cookie);
      if (!device) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      const requested = Number(url.searchParams.get('limit') ?? '20');
      const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.floor(requested))) : 20;
      return sendJson(res, 200, { ok: true, events: eventBus?.getRecent(limit) ?? [] });
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
        record({ kind: 'unauthorized', path: pathname, ip: clientKey(req) });
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(pairPageHtml());
        return;
      }
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    return forward(req, res, device);
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

  /** 页面内注入脚本上报的客户端诊断（WebSocket 关闭、JS 异常）。 */
  async function handleClientLog(req, res) {
    const body = await readBody(req, 32 * 1024).catch(() => '');
    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain' }).end('bad json');
      return;
    }
    const device = devices.verifyCookie(req.headers.cookie);
    record({
      kind: 'client-log',
      ip: clientKey(req),
      device: device?.id ?? null,
      event: String(payload.event ?? 'unknown').slice(0, 24),
      url: String(payload.url ?? '').slice(0, 160),
      code: Number.isFinite(payload.code) ? payload.code : null,
      reason: String(payload.reason ?? '').slice(0, 140),
      frames: Number.isFinite(payload.frames) ? payload.frames : null,
      durationMs: Number.isFinite(payload.durationMs) ? payload.durationMs : null,
      message: String(payload.message ?? '').slice(0, 300),
      ua: String(req.headers['user-agent'] ?? '').slice(0, 70),
    });
    res.writeHead(204, { 'cache-control': 'no-store' });
    res.end();
  }

  function forward(req, res, device) {
    const upstream = getUpstream();
    const upstreamUrl = new URL(upstream.origin);
    const targetPath = req.url ?? '/';
    const isApi = targetPath.startsWith('/api');
    const startedAt = Date.now();
    if (isApi) {
      res.on('finish', () => record({
        kind: 'api',
        device: device.id,
        ip: clientKey(req),
        method: req.method,
        path: targetPath.slice(0, 100),
        status: res.statusCode,
        ms: Date.now() - startedAt,
      }));
    }
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

  /**
   * 手机 App 的宿主事件通道（`/__dshremote/events`）。
   * 握手完成后先发一条 hello（含最近事件），之后把总线上的新事件逐条推过去；
   * 每 25s 发一次文本 ping 让 App 能判断连接是否还活着。
   */
  function handleDeviceEventsWs(req, socket, device, ip) {
    if (!device) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string' || key === '') {
      socket.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
    ].join('\r\n') + '\r\n\r\n');

    let closed = false;
    const send = (payload) => {
      if (closed) return;
      try {
        writeWsText(socket, JSON.stringify(payload));
      } catch {
        cleanup();
      }
    };
    const unsubscribe = eventBus === undefined
      ? () => {}
      : eventBus.subscribe((event) => send({ type: 'event', event }));
    const heartbeat = setInterval(() => send({ type: 'ping', at: new Date().toISOString() }), 25_000);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    function cleanup() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      try { unsubscribe(); } catch { /* ignore */ }
      try { socket.end(); } catch { /* ignore */ }
    }

    socket.on('close', cleanup);
    socket.on('error', cleanup);
    socket.on('data', (chunk) => {
      // 只关心客户端的 close 帧（opcode 0x8）；其余帧忽略（本通道是单向推送）。
      const opcode = chunk.length > 0 ? (chunk[0] & 0x0f) : -1;
      if (opcode === 0x8) cleanup();
    });

    record({ kind: 'events-ws', device: device.id, ip, recent: eventBus?.getRecent(1).length ?? 0 });
    send({ type: 'hello', now: new Date().toISOString(), events: eventBus?.getRecent(20) ?? [] });
  }

  function handleUpgrade(req, socket, head) {
    const device = devices.verifyCookie(req.headers.cookie);
    const ip = socket.remoteAddress ?? 'unknown';
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 60);
    const origin = String(req.headers.origin ?? '').slice(0, 80);
    const startedAt = Date.now();
    // 手机 App 的事件通道：由 daemon 自己实现 WebSocket，不转发给上游宿主。
    if ((req.url ?? '').split('?')[0] === EVENTS_PATH) {
      handleDeviceEventsWs(req, socket, device, ip);
      return;
    }
    record({
      kind: 'ws-upgrade',
      ip,
      authenticated: device !== null,
      device: device?.id ?? null,
      path: (req.url ?? '').slice(0, 80),
      origin,
      ua,
      cookiePresent: typeof req.headers.cookie === 'string' && req.headers.cookie.length > 0,
    });
    if (!device) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const upstream = getUpstream();
    const upstreamUrl = new URL(upstream.origin);
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
    // 记录上游握手响应首行（101 / 401 / 403 ...）
    upstreamSocket.once('data', (chunk) => {
      const statusLine = chunk.toString('latin1').split('\r\n')[0].slice(0, 90);
      record({ kind: 'ws-upstream', ip, statusLine });
    });
    // 双向字节计数（排查“握手成功但没有帧”的问题）
    let clientBytes = 0;
    let upstreamBytes = 0;
    let firstClientChunk = '';
    socket.on('data', (chunk) => {
      clientBytes += chunk.length;
      if (clientBytes <= 64) firstClientChunk += chunk.toString('latin1');
    });
    upstreamSocket.on('data', (chunk) => {
      upstreamBytes += chunk.length;
    });
    upstreamSocket.on('error', (error) => {
      record({ kind: 'ws-error', ip, error: error.message, ms: Date.now() - startedAt });
      socket.destroy();
    });
    upstreamSocket.on('close', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
    socket.on('close', () => {
      upstreamSocket.destroy();
      record({
        kind: 'ws-close',
        ip,
        device: device.id,
        ms: Date.now() - startedAt,
        clientBytes,
        upstreamBytes,
        firstClientChunk: firstClientChunk.slice(0, 40),
      });
    });
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

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/**
 * 写一个 unmasked 的服务端 WebSocket 文本帧（本 daemon 只做服务端推送）。
 * @param {import('node:net').Socket} socket
 * @param {string} text
 */
function writeWsText(socket, text) {
  const payload = Buffer.from(text, 'utf8');
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x81, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
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
