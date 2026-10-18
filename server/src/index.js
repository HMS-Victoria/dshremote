#!/usr/bin/env node
/**
 * dshremote daemon 入口。
 *
 * 宿主接入有两种模式（见 config.hostMode）：
 *   - 自启模式（spawn）：自己拉起一个 `dsh web` 宿主再代理给手机；
 *   - 接管模式（plugin）：读取 dsh-remote-host 插件导出的 host.json，直接接管
 *     已经在运行的宿主（例如桌面 App 自己的 Host），避免两个 Host 争抢会话。
 *
 * daemon 启动后始终监视 host.json：桌面 DSH 后启动/重启时自动切换到接管模式。
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { DATA_DIR, loadConfig } from './config.js';
import { DeviceStore } from './auth.js';
import { DshHost, ExportedHost, dshHomeDir, exportedHostPath } from './dsh-host.js';
import { HostEventBus } from './host-events.js';
import { createProxy } from './proxy.js';
import { lanUrls, tailscaleUrls } from './net.js';

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

/** 审计日志：把配对/吊销等安全相关事件追加到 .data/audit.log（JSONL）。 */
function createAuditLogger() {
  const file = path.join(DATA_DIR, 'audit.log');
  return (event, detail = {}) => {
    const line = `${JSON.stringify({ at: new Date().toISOString(), event, ...detail })}\n`;
    appendFile(file, line, 'utf8').catch(() => {});
  };
}

/**
 * 按配置选择宿主：优先接管插件导出的宿主，失败时按模式回退。
 * @param {object} config - 已加载的配置。
 * @returns {Promise<{ host: object, upstream: object }>}
 */
async function connectHost(config) {
  const mode = String(config.hostMode ?? 'auto').toLowerCase();
  if (mode === 'spawn') {
    const host = new DshHost(config.dsh, log);
    return { host, upstream: await host.start() };
  }
  const file = config.hostFile || exportedHostPath(config.hostProfile || 'desktop');
  if (existsSync(file)) {
    const host = new ExportedHost(file, log);
    try {
      return { host, upstream: await host.start() };
    } catch (error) {
      if (mode === 'plugin') throw error;
      log(`[host] 接管失败，回退到自启模式：${error.message}`);
    }
  } else if (mode === 'plugin') {
    throw new Error(
      `接管模式找不到 ${file}：请先在桌面 DSH 安装并启用 dsh-remote-host 插件，然后重启 DSH`,
    );
  } else {
    log(`[host] 未发现 ${file}，使用自启模式`);
  }
  const host = new DshHost(config.dsh, log);
  return { host, upstream: await host.start() };
}

/**
 * 监视插件导出的 host.json：桌面 DSH 启动/重启后（pid/端口/更新时间变化）
 * 自动重新换取 cookie 并热切换上游；从自启模式切换到接管模式时会停掉自启宿主。
 * @param {{ file: string, hostRef: { host: object, upstream: object }, log: (message: string) => void, onSwitched?: (upstream: object) => void }} options
 */
function startHostWatcher({ file, hostRef, log, onSwitched }) {
  let initialized = false;
  let lastSignature = '';
  const poll = async () => {
    try {
      const raw = await readFile(file, 'utf8');
      const data = JSON.parse(raw);
      const signature = `${String(data.pid)}:${String(data.port)}:${String(data.updatedAt)}`;
      if (!initialized) {
        initialized = true;
        lastSignature = signature;
        return;
      }
      if (signature === lastSignature) return;
      const candidate = new ExportedHost(file, log);
      const next = await candidate.start();
      const previous = hostRef.upstream;
      if (previous?.mode === 'spawn') {
        log('[host] 检测到桌面宿主，停止自启宿主并切换为接管模式');
        try {
          await hostRef.host.stop();
        } catch {
          // 停不掉也不影响接管
        }
      }
      hostRef.host = candidate;
      hostRef.upstream = next;
      lastSignature = signature;
      log(`[host] 已热切换上游: ${next.origin}（profile=${next.profile}）`);
      onSwitched?.(next);
    } catch {
      // 宿主正在重启 / 文件暂不可读：保持现状，下一轮再试
    }
  };
  const timer = setInterval(poll, 5_000);
  if (typeof timer.unref === 'function') timer.unref();
}

async function main() {
  const config = await loadConfig();
  await mkdir(DATA_DIR, { recursive: true });

  const audit = createAuditLogger();
  const devices = new DeviceStore(path.join(DATA_DIR, 'devices.json'), {
    codeTtlMs: config.pairing.codeTtlMs,
    oneTime: config.pairing.oneTime !== false,
    deviceTtlMs: config.pairing.deviceTtlMs,
    maxDevices: config.pairing.maxDevices,
    onAudit: audit,
  });
  await devices.load();
  const pairing = devices.newPairingCode();

  const { host, upstream } = await connectHost(config);
  // 宿主可能被插件重新导出（桌面 DSH 重启），代理层每次请求都从这里取最新上游。
  const hostRef = { host, upstream };

  // 宿主事件（审批 / 轮次 / 错误）：插件写 JSONL，daemon 跟随并推给手机 App。
  // 宿主切换（例如从自启切到桌面接管）时事件文件也会随 profile 变化。
  const eventBusRef = { current: null };
  const eventBus = {
    getRecent: (limit) => eventBusRef.current?.getRecent(limit) ?? [],
    subscribe: (listener) => eventBusRef.current?.subscribe(listener) ?? (() => {}),
  };
  const eventsFileFor = (profile) => config.hostEventsFile
    || path.join(dshHomeDir(), 'remote', `events-${profile ?? config.dsh.profile ?? 'desktop'}.jsonl`);
  const startEventBus = (profile) => {
    eventBusRef.current?.stop();
    eventBusRef.current = new HostEventBus(eventsFileFor(profile), log);
    eventBusRef.current.start();
  };
  startEventBus(upstream.profile);

  const runtimeFile = path.join(DATA_DIR, 'runtime.json');
  const pairingFile = path.join(DATA_DIR, 'pairing.json');
  let port = 0;
  let urls = [];
  let tailscale = [];
  /** 二维码/配对信息里优先使用的外网基地址（publicUrl 配置 > Tailscale > 局域网）。 */
  let preferredPairBase = null;

  const writePairingInfo = async (current, reason) => {
    await writeFile(pairingFile, JSON.stringify({
      code: current.code,
      expiresAt: current.expiresAt === null ? null : new Date(current.expiresAt).toISOString(),
      localUrl: `http://127.0.0.1:${port}/pair?code=${current.code}`,
      publicUrl: preferredPairBase,
      publicPairUrl: preferredPairBase === null ? null : `${preferredPairBase}/pair?code=${current.code}`,
      tailscaleUrls: tailscale.map((entry) => `${entry.url}/pair?code=${current.code}`),
      urls: urls.map((entry) => `${entry.url}/pair?code=${current.code}`),
      oneTime: devices.oneTime,
      reason,
      updatedAt: new Date().toISOString(),
    }, null, 2) + '\n');
  };
  const writeRuntimeInfo = async (current) => {
    await writeFile(runtimeFile, JSON.stringify({
      pid: process.pid,
      hostMode: current.mode,
      upstream: current.origin,
      upstreamProfile: current.profile ?? null,
      listen: { host: config.listen.host, port },
      startedAt: new Date().toISOString(),
    }, null, 2) + '\n');
  };

  const proxy = createProxy({
    getUpstream: () => hostRef.upstream,
    devices,
    log,
    eventBus,
    preferPairBase: () => preferredPairBase,
    publicUrl: config.publicUrl ?? null,
    onPairingChanged: (nextPairing) => {
      void writePairingInfo(nextPairing, 'rotated');
    },
  });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(config.listen.port, config.listen.host, resolve);
  });
  port = proxy.address().port;

  const localUrl = `http://127.0.0.1:${port}`;
  urls = config.printLanUrls ? lanUrls(port) : [];
  tailscale = tailscaleUrls(port);
  preferredPairBase = config.publicUrl || tailscale[0]?.url || null;
  log('==============================================');
  log(' dshremote 已启动');
  log(` 宿主模式: ${upstream.mode === 'plugin' ? '接管模式（插件导出的桌面宿主）' : '自启模式（独立 dsh web 宿主）'}`);
  log(` 上游 DSH: ${upstream.origin}`);
  log(` 本机调试: ${localUrl}/pair?code=${pairing.code}`);
  for (const entry of urls) {
    log(` 手机访问: ${entry.url}/pair?code=${pairing.code}   (${entry.name})`);
  }
  if (tailscale.length > 0) {
    for (const entry of tailscale) {
      log(` Tailscale: ${entry.url}/pair?code=${pairing.code}   (${entry.name})`);
    }
  } else if (!config.publicUrl) {
    log(' Tailscale: 未检测到（装好 Tailscale 并登录后重启 daemon 会自动启用）');
  }
  if (config.publicUrl) {
    log(` 外网地址: ${config.publicUrl}/pair?code=${pairing.code}   (publicUrl)`);
  }
  if (preferredPairBase !== null) {
    log(` 二维码地址: ${preferredPairBase}/pair?code=${pairing.code}`);
  }
  log(` 配对码:   ${pairing.code}${devices.oneTime ? '（一次性，配对后自动轮换）' : ''}`);
  log(` 配对码有效期: ${config.pairing.codeTtlMs === null ? '不过期' : `${Math.round(config.pairing.codeTtlMs / 60000)} 分钟`}`);
  log(` 设备上限: ${devices.maxDevices} 台，令牌有效期 ${Math.round((config.pairing.deviceTtlMs ?? 0) / 86400000)} 天`);
  if (config.publicUrl) {
    log(' 公网配对: 关闭（配对新设备前运行 .\\tools\\pair-open.ps1 临时开启 5 分钟）');
  }
  log('==============================================');

  await writeRuntimeInfo(upstream);
  await writePairingInfo(pairing, 'startup');

  // 始终监视 host.json：桌面 DSH 后启动/重启时自动切到接管模式。
  startHostWatcher({
    file: config.hostFile || exportedHostPath(config.hostProfile || 'desktop'),
    hostRef,
    log,
    onSwitched: (next) => {
      void writeRuntimeInfo(next);
      startEventBus(next.profile);
    },
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`收到 ${signal}，正在关闭…`);
    proxy.close();
    eventBusRef.current?.stop();
    await hostRef.host.stop();
    log('已退出');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[dshremote] 启动失败:\n' + (error.stack ?? error.message));
  process.exit(1);
});
