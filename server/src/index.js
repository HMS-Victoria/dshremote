#!/usr/bin/env node
/**
 * dshremote daemon 入口。
 *
 * 宿主接入有两种模式（见 config.hostMode）：
 *   - 自启模式（spawn）：自己拉起一个 `dsh web` 宿主再代理给手机；
 *   - 接管模式（plugin）：读取 dsh-remote-host 插件导出的 host.json，直接接管
 *     已经在运行的宿主（例如桌面 App 自己的 Host），避免两个 Host 争抢会话。
 */
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DATA_DIR, loadConfig } from './config.js';
import { DeviceStore } from './auth.js';
import { DshHost, ExportedHost, dshHomeDir, exportedHostPath } from './dsh-host.js';
import { HostEventBus } from './host-events.js';
import { createProxy } from './proxy.js';
import { lanUrls } from './net.js';

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

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
 * 接管模式下监视插件导出的 host.json：桌面 DSH 重启后会重写该文件，
 * 检测到 pid/端口/更新时间变化就重新换取 cookie 并热切换上游。
 * @param {{ file: string, hostRef: { host: object, upstream: object }, log: (message: string) => void }} options
 */
function startHostWatcher({ file, hostRef, log }) {
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
      hostRef.host = candidate;
      hostRef.upstream = next;
      lastSignature = signature;
      log(`[host] 已热切换上游: ${next.origin}`);
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

  const devices = new DeviceStore(path.join(DATA_DIR, 'devices.json'), {
    codeTtlMs: config.pairing.codeTtlMs,
  });
  await devices.load();
  const pairing = devices.newPairingCode();

  const { host, upstream } = await connectHost(config);
  // 宿主可能被插件重新导出（桌面 DSH 重启），代理层每次请求都从这里取最新上游。
  const hostRef = { host, upstream };

  // 宿主事件（审批 / 轮次 / 错误）：插件写 JSONL，daemon 跟随并推给手机 App。
  const eventsProfile = upstream.profile ?? config.dsh.profile ?? 'desktop';
  const eventsFile = config.hostEventsFile
    || path.join(dshHomeDir(), 'remote', `events-${eventsProfile}.jsonl`);
  const eventBus = new HostEventBus(eventsFile, log);
  eventBus.start();

  const proxy = createProxy({ getUpstream: () => hostRef.upstream, devices, log, eventBus });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(config.listen.port, config.listen.host, resolve);
  });
  const port = proxy.address().port;

  const localUrl = `http://127.0.0.1:${port}`;
  const urls = config.printLanUrls ? lanUrls(port) : [];
  log('==============================================');
  log(' dshremote 已启动');
  log(` 宿主模式: ${upstream.mode === 'plugin' ? '接管模式（插件导出的桌面宿主）' : '自启模式（独立 dsh web 宿主）'}`);
  log(` 上游 DSH: ${upstream.origin}`);
  log(` 本机调试: ${localUrl}/pair?code=${pairing.code}`);
  for (const entry of urls) {
    log(` 手机访问: ${entry.url}/pair?code=${pairing.code}   (${entry.name})`);
  }
  log(` 配对码:   ${pairing.code}`);
  log('==============================================');

  await writeFile(path.join(DATA_DIR, 'runtime.json'), JSON.stringify({
    pid: process.pid,
    hostMode: upstream.mode,
    upstream: upstream.origin,
    upstreamProfile: upstream.profile ?? null,
    listen: { host: config.listen.host, port },
    startedAt: new Date().toISOString(),
  }, null, 2) + '\n');

  // 接管模式：监视 host.json，桌面 DSH 重启（pid/端口变化）后自动重新接管。
  if (upstream.mode === 'plugin') {
    startHostWatcher({
      file: config.hostFile || exportedHostPath(config.hostProfile || 'desktop'),
      hostRef,
      log,
    });
  }

  // 方便随时查看当前配对码（daemon 重启会换码）
  await writeFile(path.join(DATA_DIR, 'pairing.json'), JSON.stringify({
    code: pairing.code,
    expiresAt: pairing.expiresAt === null ? null : new Date(pairing.expiresAt).toISOString(),
    localUrl: `${localUrl}/pair?code=${pairing.code}`,
    urls: urls.map((entry) => `${entry.url}/pair?code=${pairing.code}`),
    updatedAt: new Date().toISOString(),
  }, null, 2) + '\n');

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`收到 ${signal}，正在关闭…`);
    proxy.close();
    eventBus.stop();
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
