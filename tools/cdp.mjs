#!/usr/bin/env node
/**
 * 基于 Chrome DevTools Protocol 的无头浏览器探测小工具（零依赖）。
 *
 * 用途：在 390×844 等手机视口下打开 dshremote 代理页面，导出 DOM 与截图，
 * 供移动端适配迭代（Phase 2）使用。
 *
 * 用法：
 *   node tools/cdp.mjs --url "http://127.0.0.1:7801/pair?code=123456" \
 *     --width 390 --height 844 --wait 8000 \
 *     --screenshot .data/shots/mobile.png --dom .data/shots/mobile.html
 *
 * 可选：--edge <msedge.exe 路径>、--port 9223、--mobile（默认 true）
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const EDGE_DEFAULT = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

function parseArgs(argv) {
  const result = { width: 390, height: 844, wait: 8000, mobile: true, port: 9223 };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    switch (key) {
      case '--url': result.url = argv[++i]; break;
      case '--width': result.width = Number(argv[++i]); break;
      case '--height': result.height = Number(argv[++i]); break;
      case '--wait': result.wait = Number(argv[++i]); break;
      case '--screenshot': result.screenshot = argv[++i]; break;
      case '--dom': result.dom = argv[++i]; break;
      case '--click': result.click = argv[++i]; break;
      case '--eval': result.eval = argv[++i]; break;
      case '--edge': result.edge = argv[++i]; break;
      case '--port': result.port = Number(argv[++i]); break;
      case '--no-mobile': result.mobile = false; break;
      case '--help':
        console.log('用法: node tools/cdp.mjs --url <url> [--width 390] [--height 844] [--wait 8000] [--screenshot out.png] [--dom out.html]');
        process.exit(0);
        break;
      default: throw new Error(`未知参数: ${key}`);
    }
  }
  if (!result.url) throw new Error('缺少 --url');
  return result;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

async function waitForBrowser(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await fetchJson(`http://127.0.0.1:${port}/json/version`);
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`浏览器调试端口未就绪: ${error.message}`);
      await sleep(250);
    }
  }
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.eventWaiters = new Map();
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', (event) => reject(new Error(`CDP 连接失败: ${event.message ?? ''}`)), { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`));
        else pending.resolve(message.result);
        return;
      }
      const waiters = this.eventWaiters.get(message.method);
      if (waiters) {
        this.eventWaiters.delete(message.method);
        for (const resolve of waiters) resolve(message.params);
      }
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method, timeoutMs) {
    return new Promise((resolve) => {
      const list = this.eventWaiters.get(method) ?? [];
      const entry = (params) => { clearTimeout(timer); resolve(params); };
      list.push(entry);
      this.eventWaiters.set(method, list);
      const timer = setTimeout(() => resolve(null), timeoutMs);
    });
  }

  close() {
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const edge = args.edge ?? EDGE_DEFAULT;
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'dshremote-cdp-'));
  let browser;
  const client = { close() {} };
  try {
    browser = spawn(edge, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-sandbox',
      '--disable-extensions',
      '--hide-scrollbars',
      `--remote-debugging-port=${args.port}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ], { stdio: 'ignore', windowsHide: true });

    await waitForBrowser(args.port);
    const target = await fetchJson(
      `http://127.0.0.1:${args.port}/json/new?${encodeURIComponent('about:blank')}`,
      { method: 'PUT' },
    );
    const cdp = new CdpClient(target.webSocketDebuggerUrl);
    client.close = () => cdp.close();
    await cdp.connect();

    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: args.width,
      height: args.height,
      deviceScaleFactor: args.mobile ? 2 : 1,
      mobile: args.mobile,
      screenOrientation: { type: 'portraitPrimary', angle: 0 },
    });
    if (args.mobile) {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
      await cdp.send('Emulation.setUserAgentOverride', {
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      });
    }

    const loaded = cdp.waitForEvent('Page.loadEventFired', 30_000);
    const navigation = await cdp.send('Page.navigate', { url: args.url });
    if (navigation.errorText) throw new Error(`导航失败: ${navigation.errorText}`);
    await loaded;
    await sleep(args.wait);

    if (args.click) {
      const clickResult = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const wanted = ${JSON.stringify(args.click)};
          const candidates = [...document.querySelectorAll('button, [role="button"], a')];
          const target = candidates.find((el) => (el.textContent || '').trim().includes(wanted));
          if (!target) return { clicked: false, candidates: candidates.slice(0, 20).map((el) => (el.textContent || '').trim().slice(0, 30)) };
          target.click();
          return { clicked: true, tag: target.tagName, text: (target.textContent || '').trim().slice(0, 60) };
        })()`,
        returnByValue: true,
      });
      console.log('点击结果:', JSON.stringify(clickResult.result.value));
      await sleep(2500);
    }

    if (args.eval) {
      const evalResult = await cdp.send('Runtime.evaluate', {
        expression: args.eval,
        returnByValue: true,
        awaitPromise: true,
      });
      console.log('eval:', JSON.stringify(evalResult.result.value, null, 2));
    }

    const summary = await cdp.send('Runtime.evaluate', {
      expression: `(() => ({
        title: document.title,
        url: location.href,
        htmlClass: document.documentElement.className,
        nodes: document.querySelectorAll('*').length,
        bodyText: (document.body?.innerText ?? '').slice(0, 600),
        mobileMeta: !!document.querySelector('meta[name="dshremote"]'),
        mobileScript: !!document.querySelector('script[src*="__dshremote/mobile.js"]'),
      }))()`,
      returnByValue: true,
    });
    console.log(JSON.stringify(summary.result.value, null, 2));

    if (args.dom) {
      const dom = await cdp.send('Runtime.evaluate', {
        expression: 'document.documentElement.outerHTML',
        returnByValue: true,
      });
      await mkdir(path.dirname(path.resolve(args.dom)), { recursive: true });
      await writeFile(args.dom, dom.result.value, 'utf8');
      console.log(`DOM 已保存: ${path.resolve(args.dom)} (${dom.result.value.length} 字符)`);
    }
    if (args.screenshot) {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      await mkdir(path.dirname(path.resolve(args.screenshot)), { recursive: true });
      await writeFile(args.screenshot, Buffer.from(shot.data, 'base64'));
      console.log(`截图已保存: ${path.resolve(args.screenshot)}`);
    }
  } finally {
    client.close();
    browser?.kill();
    await sleep(300);
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error('[cdp] 失败:', error.message);
  process.exit(1);
});
