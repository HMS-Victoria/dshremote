/**
 * 调试工具：订阅 dshremote 的宿主事件通道，打印审批/轮次事件。
 *
 * 用法（在项目根目录）：
 *   node tools/watch-events.mjs               # WebSocket 实时订阅
 *   node tools/watch-events.mjs --poll        # 只拉一次最近事件（/events/recent）
 *   node tools/watch-events.mjs --poll 50     # 拉最近 50 条
 *
 * 设备令牌取自 .data/devices.json 里最近的一台已配对设备；daemon 端口默认 7801
 * （可用 DSHREMOTE_PORT 覆盖）。
 */
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSHREMOTE_PORT ?? 7801);
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const args = process.argv.slice(2);
const pollIndex = args.indexOf('--poll');
const pollOnly = pollIndex >= 0;
const pollLimit = pollOnly ? Number(args[pollIndex + 1] ?? 20) : 20;

async function loadDeviceToken() {
  const file = path.join(ROOT, '.data', 'devices.json');
  const data = JSON.parse(await readFile(file, 'utf8'));
  const devices = Array.isArray(data.devices) ? data.devices : [];
  const device = devices.at(-1);
  if (device === undefined || typeof device.token !== 'string') {
    throw new Error(`没有已配对设备：${file}`);
  }
  return { token: device.token, name: device.name ?? device.id };
}

async function pollRecent(token) {
  const response = await fetch(`http://127.0.0.1:${PORT}/__dshremote/events/recent?limit=${pollLimit}`, {
    headers: { cookie: `dshremote_device=${token}` },
  });
  const body = await response.json();
  console.log(JSON.stringify(body, null, 2));
}

/** 极简 WS 客户端：只解析服务端 unmasked 文本/close 帧。 */
async function watch(token) {
  const key = randomBytes(16).toString('base64');
  const socket = net.connect(PORT, '127.0.0.1', () => {
    socket.write([
      'GET /__dshremote/events HTTP/1.1',
      `Host: 127.0.0.1:${PORT}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${key}`,
      `Cookie: dshremote_device=${token}`,
      '',
      '',
    ].join('\r\n'));
  });

  let handshaken = false;
  let buffer = Buffer.alloc(0);
  const expectedAccept = createHash('sha1').update(`${key}${GUID}`).digest('base64');

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshaken) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const head = buffer.subarray(0, headerEnd).toString('latin1');
      if (!head.startsWith('HTTP/1.1 101') || !head.includes(expectedAccept)) {
        console.error(`[watch] 握手失败:\n${head}`);
        socket.destroy();
        return;
      }
      handshaken = true;
      buffer = buffer.subarray(headerEnd + 4);
      console.log(`[watch] 已连接 daemon:${PORT}/__dshremote/events`);
    }
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (masked) offset += 4;
      if (buffer.length < offset + length) return;
      const payload = buffer.subarray(offset, offset + length);
      buffer = buffer.subarray(offset + length);
      if (opcode === 0x8) {
        console.log('[watch] 服务端关闭连接');
        socket.end();
        return;
      }
      if (opcode !== 0x1) continue; // 只打印文本帧
      try {
        const message = JSON.parse(payload.toString('utf8'));
        const at = new Date().toLocaleTimeString();
        if (message.type === 'event') console.log(`[${at}]`, JSON.stringify(message.event));
        else console.log(`[${at}] ${message.type}`, message.type === 'hello' ? `${message.events.length} 条历史` : '');
      } catch {
        console.log(`[watch] 非 JSON 帧: ${payload.toString('utf8').slice(0, 200)}`);
      }
    }
  });
  socket.on('error', (error) => console.error(`[watch] 连接错误: ${error.message}`));
  socket.on('close', () => process.exit(0));

  process.on('SIGINT', () => {
    socket.destroy();
    process.exit(0);
  });
}

async function main() {
  const { token, name } = await loadDeviceToken();
  console.log(`[watch] 设备: ${name}`);
  if (pollOnly) await pollRecent(token);
  else await watch(token);
}

main().catch((error) => {
  console.error(`[watch] 失败: ${error.message}`);
  process.exit(1);
});
