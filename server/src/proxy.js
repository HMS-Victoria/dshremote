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
import { isPrivateHostname, lanUrls } from './net.js';
import { listDirectory } from './browse.js';

const PAIR_API_PATH = '/__dshremote/pair';
const PAIR_OPEN_WINDOW_PATH = '/__dshremote/pairing/open-window';
const HEALTH_PATH = '/__dshremote/health';
const DIAG_PATH = '/__dshremote/diag';
const CLIENT_LOG_PATH = '/__dshremote/client-log';
const FS_PATH = '/__dshremote/fs';
const EVENTS_PATH = '/__dshremote/events';
const EVENTS_RECENT_PATH = '/__dshremote/events/recent';
const DEVICES_PATH = '/__dshremote/devices';
const DEVICES_REVOKE_PATH = '/__dshremote/devices/revoke';
const PAIRING_PATH = '/__dshremote/pairing';
const PAIRING_ROTATE_PATH = '/__dshremote/pairing/rotate';
const DIAG_LIMIT = 1200;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * @param {object} options
 * @param {() => { origin: string, host: string, cookie: string }} options.getUpstream
 *   每次请求时读取当前上游（宿主可能被插件重新导出/重启，由 daemon 热切换）。
 * @param {{ getRecent: (limit?: number) => object[], subscribe: (fn: (event: object) => void) => () => void }} [options.eventBus]
 *   宿主事件总线（审批/轮次等），用于 `/__dshremote/events` 推送。
 * @param {(pairing: object) => void} [options.onPairingChanged]
 *   配对码轮换（一次性码被使用 / 手动轮换）后的回调，daemon 用它更新配对信息文件。
 */
export function createProxy({ getUpstream, devices, log, eventBus, onPairingChanged, preferPairBase, publicUrl = null }) {
  const events = [];
  /**
   * 公网配对地址信息（来自 publicUrl）。
   * 只有“公网域名”才需要公网配对窗口；EasyTier/Tailscale/局域网等私有地址不算公网。
   */
  const publicHostInfo = (() => {
    if (typeof publicUrl !== 'string' || publicUrl === '') return null;
    try {
      const hostname = new URL(publicUrl).hostname.toLowerCase();
      return { hostname, isPrivate: isPrivateHostname(hostname) };
    } catch {
      return null;
    }
  })();
  const publicHost = publicHostInfo === null || publicHostInfo.isPrivate ? null : publicHostInfo.hostname;
  /** 配对尝试限速（全局 + 按 IP，滑动 60 秒窗口）。 */
  const pairRate = { global: [], perIp: new Map() };

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
      // 公网不暴露上游/进程信息，只回一个存活标记
      const ip = req.socket.remoteAddress ?? '';
      if (!isLoopback(ip)) return sendJson(res, 200, { ok: true });
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
    // ── 本机管理接口（仅 loopback）：设备列表/吊销、配对码查询/轮换 ─────────
    if (pathname === DEVICES_PATH && req.method === 'GET') {
      if (!isLoopback(req.socket.remoteAddress ?? '')) return sendJson(res, 403, { ok: false, error: 'loopback-only' });
      return sendJson(res, 200, { ok: true, devices: devices.listDevices() });
    }
    if (pathname === DEVICES_REVOKE_PATH && req.method === 'POST') {
      if (!isLoopback(req.socket.remoteAddress ?? '')) return sendJson(res, 403, { ok: false, error: 'loopback-only' });
      const body = await readBody(req, 16 * 1024);
      let payload;
      try {
        payload = JSON.parse(body || '{}');
      } catch {
        return sendJson(res, 400, { ok: false, error: 'invalid-json' });
      }
      const removed = await devices.revoke(String(payload.id ?? ''));
      if (removed) log(`[auth] 已吊销设备: ${String(payload.id ?? '')}`);
      return sendJson(res, 200, { ok: true, removed });
    }
    if (pathname === PAIRING_PATH && req.method === 'GET') {
      if (!isLoopback(req.socket.remoteAddress ?? '')) return sendJson(res, 403, { ok: false, error: 'loopback-only' });
      const pairing = devices.pairing;
      return sendJson(res, 200, {
        ok: true,
        code: pairing?.code ?? null,
        createdAt: pairing?.createdAt ?? null,
        expiresAt: pairing?.expiresAt ?? null,
        used: pairing?.usedAt !== null && pairing?.usedAt !== undefined,
        oneTime: devices.oneTime,
        publicUrl: publicUrl ?? null,
        publicPairAllowed: devices.publicPairAllowed(),
        publicPairWindowUntil: devices.publicPairWindowUntil > 0 ? new Date(devices.publicPairWindowUntil).toISOString() : null,
        deviceCount: devices.listDevices().length,
        maxDevices: devices.maxDevices,
      });
    }
    if (pathname === PAIR_OPEN_WINDOW_PATH && req.method === 'POST') {
      if (!isLoopback(req.socket.remoteAddress ?? '')) return sendJson(res, 403, { ok: false, error: 'loopback-only' });
      const body = await readBody(req, 16 * 1024).catch(() => '');
      let minutes = 5;
      try {
        const payload = JSON.parse(body || '{}');
        if (Number.isFinite(Number(payload.minutes))) {
          minutes = Math.max(1, Math.min(30, Math.round(Number(payload.minutes))));
        }
      } catch {
        // 用默认 5 分钟
      }
      const { pairing, windowUntil } = devices.openPublicPairWindow(minutes * 60 * 1000);
      log(`[auth] 已开启公网配对窗口（到 ${new Date(windowUntil).toLocaleTimeString()}，${minutes} 分钟），新配对码: ${pairing.code}`);
      onPairingChanged?.(pairing);
      return sendJson(res, 200, {
        ok: true,
        code: pairing.code,
        expiresAt: pairing.expiresAt,
        windowUntil: new Date(windowUntil).toISOString(),
        minutes,
        publicUrl: publicUrl ?? null,
      });
    }
    if (pathname === PAIRING_ROTATE_PATH && req.method === 'POST') {
      if (!isLoopback(req.socket.remoteAddress ?? '')) return sendJson(res, 403, { ok: false, error: 'loopback-only' });
      const pairing = devices.newPairingCode();
      log(`[auth] 配对码已手动轮换: ${pairing.code}`);
      onPairingChanged?.(pairing);
      return sendJson(res, 200, { ok: true, code: pairing.code, expiresAt: pairing.expiresAt });
    }
    // 手机端「添加工作区」：浏览电脑上的目录（设备 cookie 鉴权）
    if (pathname === FS_PATH && req.method === 'GET') {
      const device = devices.verifyCookie(req.headers.cookie);
      if (!device) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      try {
        const listing = await listDirectory(url.searchParams.get('path') ?? '');
        return sendJson(res, 200, { ok: true, ...listing });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : '无法读取目录' });
      }
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
        const pairing = currentPairingForPage();
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(pairPageHtml({ pairUrl: `${pairBaseUrl(req)}/pair?code=${pairing.code}` }));
        return;
      }
      return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    }
    return forward(req, res, device);
  }

  /** 配对页展示用：确保当前有一个未使用、未过期的配对码（过期则自动轮换）。 */
  function currentPairingForPage() {
    const current = devices.pairing;
    const expired = current !== null && current.expiresAt !== null && Date.now() > current.expiresAt;
    if (current !== null && current.usedAt == null && !expired) return current;
    const next = devices.newPairingCode();
    log(`[auth] 配对页访问，生成新配对码: ${next.code}`);
    onPairingChanged?.(next);
    return next;
  }

  /**
   * 二维码里要编码的访问地址：优先用请求 Host（手机浏览器访问时就是局域网地址；
   * 电脑浏览器访问 127.0.0.1 时改用本机第一个局域网网卡地址）。
   * @param {import('node:http').IncomingMessage} req
   */
  function pairBaseUrl(req) {
    // 优先用外网/Tailscale 地址（daemon 检测或配置提供），手机在外网扫码也能连
    const preferred = typeof preferPairBase === 'function' ? preferPairBase(req) : null;
    if (typeof preferred === 'string' && preferred !== '') return preferred;
    const host = String(req.headers.host ?? '');
    const hostValid = /^[A-Za-z0-9.\-]+(:\d+)?$/u.test(host);
    const isLoopbackHost = /^(127\.0\.0\.1|localhost)(:\d+)?$/iu.test(host);
    if (hostValid && !isLoopbackHost) return `http://${host}`;
    const lan = lanUrls(req.socket.localPort ?? 0)[0];
    if (lan !== undefined) return lan.url;
    return `http://${hostValid ? host : '127.0.0.1'}`;
  }

  /** 配对成功后：一次性配对码立即作废并轮换，并通知 daemon 更新配对信息文件。 */
  function rotatePairingCode() {
    try {
      const { rotated } = devices.consumePairingCode();
      if (rotated !== null) {
        log(`[auth] 配对码已作废并轮换，新配对码: ${rotated.code}`);
        onPairingChanged?.(rotated);
      }
    } catch (error) {
      log(`[auth] 轮换配对码失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 是否是经公网域名（publicUrl）到达的配对请求。 */
  function isPublicPairRequest(req) {
    if (publicHost === null) return false;
    const host = String(req.headers.host ?? '').split(':')[0].toLowerCase();
    if (host === publicHost) return true;
    const forwarded = String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim().split(':')[0].toLowerCase();
    return forwarded === publicHost;
  }

  /** 公网配对窗口没开时拒绝（页面/接口分别返回 HTML/JSON）。 */
  function denyPublicPairing(req, res, asJson) {
    devices.audit('pair.public-denied', { ip: clientKey(req), host: String(req.headers.host ?? '').slice(0, 120) });
    const message = '公网配对未开启：请在电脑上运行 .\\tools\\pair-open.ps1（5 分钟内有效）后再试';
    if (asJson) return sendJson(res, 403, { ok: false, error: 'public-pairing-disabled', message });
    res.writeHead(403, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(pairPageHtml({ error: message }));
    return undefined;
  }

  /** 配对尝试限速：每 IP 5 次/分钟，全局 10 次/分钟。 */
  function pairRateLimited(req) {
    const windowMs = 60_000;
    const now = Date.now();
    const prune = (list) => {
      while (list.length > 0 && now - list[0] > windowMs) list.shift();
    };
    prune(pairRate.global);
    const ip = clientKey(req);
    const list = pairRate.perIp.get(ip) ?? [];
    prune(list);
    if (pairRate.global.length >= 10 || list.length >= 5) return true;
    pairRate.global.push(now);
    pairRate.perIp.set(ip, list);
    list.push(now);
    return false;
  }

  /** 公网 https 域名下给 Cookie 加 Secure。 */
  function shouldSecureCookie(req) {
    if (isSecure(req)) return true;
    return publicHost !== null && /^https:/iu.test(String(publicUrl ?? '')) && isPublicPairRequest(req);
  }

  /** 配对成功后：关闭公网窗口、轮换配对码，返回是否成功。 */
  function finishPairing() {
    devices.closePublicPairWindow();
    rotatePairingCode();
  }

  async function handlePairPage(req, res, url) {
    const code = url.searchParams.get('code');
    if (isPublicPairRequest(req) && !devices.publicPairAllowed()) {
      return denyPublicPairing(req, res, false);
    }
    if (code) {
      if (pairRateLimited(req)) {
        devices.audit('pair.rate-limited', { ip: clientKey(req), host: String(req.headers.host ?? '').slice(0, 120) });
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(pairPageHtml({ error: '尝试次数过多，请稍后再试' }));
        return;
      }
      if (devices.pairingCodeValid(code)) {
        const issued = await devices.issueDevice('手机');
        if (issued === null) {
          res.writeHead(409, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(pairPageHtml({ error: `设备数量已达上限（最多 ${devices.maxDevices} 台），请先在电脑上运行 tools\\devices.ps1 -Revoke <id> 吊销旧设备` }));
          return;
        }
        log(`[auth] 新设备配对: ${issued.device.id} (${issued.device.name})`);
        finishPairing();
        res.writeHead(302, {
          'set-cookie': deviceCookie(issued.token, shouldSecureCookie(req)),
          location: '/',
          'cache-control': 'no-store',
        });
        res.end();
        return;
      }
    }
    const current = currentPairingForPage();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(pairPageHtml({
      error: code ? '配对码不正确或已过期' : null,
      pairUrl: `${pairBaseUrl(req)}/pair?code=${current.code}`,
    }));
  }

  async function handlePairApi(req, res) {
    if (isPublicPairRequest(req) && !devices.publicPairAllowed()) {
      return denyPublicPairing(req, res, true);
    }
    if (pairRateLimited(req)) {
      devices.audit('pair.rate-limited', { ip: clientKey(req), host: String(req.headers.host ?? '').slice(0, 120) });
      return sendJson(res, 429, { ok: false, error: 'rate-limited', message: '尝试次数过多，请稍后再试' });
    }
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
    const issued = await devices.issueDevice(payload.deviceName || 'Android');
    if (issued === null) {
      return sendJson(res, 409, { ok: false, error: 'device-limit', message: `设备数量已达上限（最多 ${devices.maxDevices} 台）` });
    }
    log(`[auth] 新设备配对（API）: ${issued.device.id} (${issued.device.name})`);
    finishPairing();
    return sendJson(res, 200, {
      ok: true,
      token: issued.token,
      device: { id: issued.device.id, name: issued.device.name },
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
    // 客户端（OkHttp）会发 WebSocket ping 帧并要求 pong；必须回应，否则客户端会判定
    // 连接超时并反复重连（表现为约每分钟断一次）。这里解析客户端帧，只处理 ping/close。
    let wsBuffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      try {
        wsBuffer = Buffer.concat([wsBuffer, chunk]);
        while (wsBuffer.length >= 2) {
          const opcode = wsBuffer[0] & 0x0f;
          const masked = (wsBuffer[1] & 0x80) !== 0;
          let length = wsBuffer[1] & 0x7f;
          let offset = 2;
          if (length === 126) {
            if (wsBuffer.length < 4) return;
            length = wsBuffer.readUInt16BE(2);
            offset = 4;
          } else if (length === 127) {
            if (wsBuffer.length < 10) return;
            length = Number(wsBuffer.readBigUInt64BE(2));
            offset = 10;
          }
          const maskOffset = offset;
          if (masked) offset += 4;
          if (wsBuffer.length < offset + length) return;
          const payload = Buffer.from(wsBuffer.subarray(offset, offset + length));
          if (masked) {
            const mask = wsBuffer.subarray(maskOffset, maskOffset + 4);
            for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
          }
          wsBuffer = wsBuffer.subarray(offset + length);
          if (opcode === 0x8) {
            cleanup();
            return;
          }
          if (opcode === 0x9) writeWsFrame(socket, 0xA, payload);
        }
      } catch {
        cleanup();
      }
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
 * 写一个 unmasked 的服务端 WebSocket 帧。
 * @param {import('node:net').Socket} socket
 * @param {number} opcode - 1=文本，0xA=pong，0x8=close
 * @param {Buffer} payload
 */
function writeWsFrame(socket, opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  socket.write(Buffer.concat([header, payload]));
}

/**
 * 写一个 unmasked 的服务端 WebSocket 文本帧（本 daemon 只做服务端推送）。
 * @param {import('node:net').Socket} socket
 * @param {string} text
 */
function writeWsText(socket, text) {
  writeWsFrame(socket, 0x1, Buffer.from(text, 'utf8'));
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
