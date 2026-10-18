/**
 * 设备配对与令牌管理。
 *
 * 安全要点：
 * - 配对码：默认一次性、10 分钟过期；配对成功立即作废并轮换。
 * - 设备令牌：客户端保存原始令牌；服务端只保存 sha256 哈希（devices.json 泄漏也拿不到令牌）。
 * - 设备令牌默认 30 天过期，最多 5 台设备。
 * - 公网配对窗口：通过公网域名访问时，必须先在本机运行 tools/pair-open.ps1 打开 5 分钟窗口。
 * - 所有配对/吊销/过期事件写审计日志。
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

const COOKIE_NAME = 'dshremote_device';

export function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

export class DeviceStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.codeTtlMs = options.codeTtlMs ?? 10 * 60 * 1000;
    this.oneTime = options.oneTime ?? true;
    this.deviceTtlMs = options.deviceTtlMs ?? 30 * 24 * 60 * 60 * 1000;
    this.maxDevices = options.maxDevices ?? 5;
    this.onAudit = typeof options.onAudit === 'function' ? options.onAudit : null;
    this.devices = [];
    this.pairing = null;
    /** 公网配对窗口截止时间戳（0 = 未开启）。 */
    this.publicPairWindowUntil = 0;
  }

  audit(event, detail = {}) {
    try {
      this.onAudit?.(event, detail);
    } catch {
      // 审计失败不影响主流程
    }
  }

  async load() {
    if (!existsSync(this.filePath)) return this;
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (Array.isArray(parsed.devices)) this.devices = parsed.devices;
    } catch (error) {
      console.warn(`[auth] 设备文件损坏，已忽略: ${error.message}`);
    }
    // 老版本把令牌明文存进 devices.json，加载时迁移成哈希
    let migrated = false;
    for (const device of this.devices) {
      if (typeof device.token === 'string' && device.token !== '') {
        device.tokenHash = hashToken(device.token);
        delete device.token;
        migrated = true;
      }
      if (!device.expiresAt) {
        const created = Date.parse(device.createdAt ?? '') || Date.now();
        device.expiresAt = new Date(created + this.deviceTtlMs).toISOString();
        migrated = true;
      }
    }
    if (migrated) await this.save().catch(() => {});
    return this;
  }

  async save() {
    const payload = JSON.stringify({ version: 2, devices: this.devices }, null, 2) + '\n';
    await writeFile(this.filePath, payload, { encoding: 'utf8', mode: 0o600 });
  }

  /** 生成配对码（6 位数字），只在内存中保存。 */
  newPairingCode() {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.pairing = {
      code,
      createdAt: Date.now(),
      expiresAt: this.codeTtlMs === null ? null : Date.now() + this.codeTtlMs,
      usedAt: null,
    };
    return this.pairing;
  }

  pairingCodeValid(code) {
    if (this.pairing === null) return false;
    if (this.pairing.usedAt !== null) return false;
    if (this.pairing.expiresAt !== null && Date.now() > this.pairing.expiresAt) return false;
    return String(code) === this.pairing.code;
  }

  /**
   * 配对码被使用后调用：一次性模式下作废并轮换出新码。
   * @returns {{ rotated: object | null }} 轮换后的新配对码（复用模式返回 null）。
   */
  consumePairingCode() {
    if (this.pairing === null) return { rotated: null };
    this.pairing.usedAt = Date.now();
    if (!this.oneTime) return { rotated: null };
    return { rotated: this.newPairingCode() };
  }

  /** 开启公网配对窗口（同时轮换配对码），返回新配对码。 */
  openPublicPairWindow(durationMs = 5 * 60 * 1000) {
    this.publicPairWindowUntil = Date.now() + durationMs;
    const pairing = this.newPairingCode();
    return { pairing, windowUntil: this.publicPairWindowUntil };
  }

  /** 公网配对窗口是否有效。 */
  publicPairAllowed() {
    return Date.now() < this.publicPairWindowUntil;
  }

  /** 关闭公网配对窗口（配对成功后立即关闭）。 */
  closePublicPairWindow() {
    this.publicPairWindowUntil = 0;
  }

  /** 设备列表（不含令牌/哈希）。 */
  listDevices() {
    return this.devices.map((device) => ({
      id: device.id,
      name: device.name,
      createdAt: device.createdAt ?? null,
      lastSeenAt: device.lastSeenAt ?? null,
      expiresAt: device.expiresAt ?? null,
    }));
  }

  /**
   * 配对成功：生成设备令牌并落盘。只保存哈希，原始令牌返回给调用方。
   * @returns {Promise<{ device: object, token: string } | null>} 设备数超限时返回 null。
   */
  async issueDevice(name = 'Android') {
    if (this.devices.length >= this.maxDevices) {
      this.audit('device.limit-reached', { maxDevices: this.maxDevices });
      return null;
    }
    const token = randomBytes(24).toString('base64url');
    const device = {
      id: randomBytes(6).toString('hex'),
      name: String(name || 'Android').slice(0, 40),
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
      lastSeenAt: null,
      expiresAt: new Date(Date.now() + this.deviceTtlMs).toISOString(),
    };
    this.devices.push(device);
    await this.save();
    this.audit('device.paired', { deviceId: device.id, name: device.name, expiresAt: device.expiresAt });
    return { device, token };
  }

  /** 从 Cookie 头解析设备；lastSeen 写入做过节流。 */
  verifyCookie(cookieHeader) {
    const token = parseCookie(cookieHeader)?.[COOKIE_NAME];
    if (!token) return null;
    const tokenHash = hashToken(token);
    const device = this.devices.find((entry) => entry.tokenHash === tokenHash) ?? null;
    if (device === null) return null;
    if (device.expiresAt && Date.parse(device.expiresAt) < Date.now()) {
      this.devices = this.devices.filter((entry) => entry !== device);
      this.save().catch(() => {});
      this.audit('device.expired', { deviceId: device.id, name: device.name });
      return null;
    }
    if (device.lastSeenAt === null || Date.now() - Date.parse(device.lastSeenAt) > 60_000) {
      device.lastSeenAt = new Date().toISOString();
      this.save().catch(() => {});
    }
    return device;
  }

  async revoke(deviceId) {
    const target = this.devices.find((entry) => entry.id === deviceId) ?? null;
    const before = this.devices.length;
    this.devices = this.devices.filter((entry) => entry.id !== deviceId);
    await this.save();
    const removed = before !== this.devices.length;
    if (removed) this.audit('device.revoked', { deviceId, name: target?.name ?? null });
    return removed;
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
