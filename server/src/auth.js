/**
 * 设备配对与令牌管理。
 *
 * - 配对码：daemon 每次启动生成，打印给用户（或显示二维码）。
 * - 设备令牌：配对成功后随机生成，App 侧保存；HTTP 请求用 Cookie 携带。
 * - 持久化：.data/devices.json（仅本机可读；Phase 1 会加权限收紧与哈希存储）。
 */
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

const COOKIE_NAME = 'dshremote_device';

export class DeviceStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.codeTtlMs = options.codeTtlMs ?? null;
    this.devices = [];
    this.pairing = null;
  }

  async load() {
    if (!existsSync(this.filePath)) return this;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (Array.isArray(parsed.devices)) this.devices = parsed.devices;
    } catch (error) {
      console.warn(`[auth] 设备文件损坏，已忽略: ${error.message}`);
    }
    return this;
  }

  async save() {
    const payload = JSON.stringify({ version: 1, devices: this.devices }, null, 2) + '\n';
    await writeFile(this.filePath, payload, { encoding: 'utf8', mode: 0o600 });
  }

  /** 生成配对码（6 位数字），只在内存中保存。 */
  newPairingCode() {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.pairing = {
      code,
      createdAt: Date.now(),
      expiresAt: this.codeTtlMs === null ? null : Date.now() + this.codeTtlMs,
    };
    return this.pairing;
  }

  pairingCodeValid(code) {
    if (this.pairing === null) return false;
    if (this.pairing.expiresAt !== null && Date.now() > this.pairing.expiresAt) return false;
    return String(code) === this.pairing.code;
  }

  /** 配对成功：生成设备令牌并落盘。 */
  async issueDevice(name = 'Android') {
    const token = randomBytes(24).toString('base64url');
    const device = {
      id: randomBytes(6).toString('hex'),
      name: String(name || 'Android').slice(0, 40),
      token,
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
    };
    this.devices.push(device);
    await this.save();
    return device;
  }

  /** 从 Cookie 头解析设备；lastSeen 写入做过节流。 */
  verifyCookie(cookieHeader) {
    const token = parseCookie(cookieHeader)?.[COOKIE_NAME];
    if (!token) return null;
    const device = this.devices.find((entry) => entry.token === token) ?? null;
    if (device && (device.lastSeenAt === null || Date.now() - Date.parse(device.lastSeenAt) > 60_000)) {
      device.lastSeenAt = new Date().toISOString();
      this.save().catch(() => {});
    }
    return device;
  }

  async revoke(deviceId) {
    const before = this.devices.length;
    this.devices = this.devices.filter((entry) => entry.id !== deviceId);
    await this.save();
    return before !== this.devices.length;
  }
}

export function parseCookie(header) {
  if (typeof header !== 'string' || header.length === 0) return null;
  const result = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) result[name] = value;
  }
  return result;
}

export function deviceCookie(token, secure) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=31536000',
  ];
  if (secure) attrs.push('Secure');
  return attrs.join('; ');
}

export { COOKIE_NAME };
