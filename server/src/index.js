#!/usr/bin/env node
/**
 * dshremote daemon 入口。
 *
 * 模式一（当前）：自己拉起一个 dsh web 宿主（自启模式），代理给局域网/手机使用。
 * 模式二（M4）：读取 DSH 桌面插件导出的 host.json，接管桌面 App 的宿主。
 */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { DATA_DIR, loadConfig } from './config.js';
import { DeviceStore } from './auth.js';
import { DshHost } from './dsh-host.js';
import { createProxy } from './proxy.js';
import { lanUrls } from './net.js';

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

async function main() {
  const config = await loadConfig();
  await mkdir(DATA_DIR, { recursive: true });

  const devices = new DeviceStore(path.join(DATA_DIR, 'devices.json'), {
    codeTtlMs: config.pairing.codeTtlMs,
  });
  await devices.load();
  const pairing = devices.newPairingCode();

  const host = new DshHost(config.dsh, log);
  const upstream = await host.start();

  const proxy = createProxy({ upstream, devices, log });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(config.listen.port, config.listen.host, resolve);
  });
  const port = proxy.address().port;

  const localUrl = `http://127.0.0.1:${port}`;
  const urls = config.printLanUrls ? lanUrls(port) : [];
  log('==============================================');
  log(' dshremote 已启动');
  log(` 上游 DSH: ${upstream.origin}`);
  log(` 本机调试: ${localUrl}/pair?code=${pairing.code}`);
  for (const entry of urls) {
    log(` 手机访问: ${entry.url}/pair?code=${pairing.code}   (${entry.name})`);
  }
  log(` 配对码:   ${pairing.code}`);
  log('==============================================');

  await writeFile(path.join(DATA_DIR, 'runtime.json'), JSON.stringify({
    pid: process.pid,
    upstream: upstream.origin,
    listen: { host: config.listen.host, port },
    startedAt: new Date().toISOString(),
  }, null, 2) + '\n');

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log(`收到 ${signal}，正在关闭…`);
    proxy.close();
    await host.stop();
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
