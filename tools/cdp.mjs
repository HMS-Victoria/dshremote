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
  const result = { width: 390, height: 844, wait: 8000, mobile: true, port: undefined };
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
      case '--click-selector': result.clickSelector = argv[++i]; break;
      case '--eval': result.eval = argv[++i]; break;
      case '--eval-file': result.evalFile = argv[++i]; break;
      case '--steps': result.steps = argv[++i]; break;
      case '--edge': result.edge = argv[++i]; break;
      case '--port': result.port = Number(argv[++i]); break;
      case '--connect-port': result.connectPort = Number(argv[++i]); break;
      case '--reload': result.reload = true; break;
      case '--netlog': result.netlog = true; break;
    case '--netlog-body': result.netlog = true; result.netlogBody = true; break;
      case '--preload-file': result.preloadFile = argv[++i]; break;
      case '--no-mobile': result.mobile = false; break;
      case '--help':
        console.log('用法: node tools/cdp.mjs --url <url> [--width 390] [--height 844] [--wait 8000] [--screenshot out.png] [--dom out.html]');
        process.exit(0);
        break;
      default: throw new Error(`未知参数: ${key}`);
    }
  }
  if (!result.url && result.connectPort === undefined) throw new Error('缺少 --url');
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

/** 让操作系统分配一个空闲的调试端口，避免与残留进程冲突。 */
async function getFreePort() {
  const net = await import('node:net');
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 结束整个浏览器进程树（Windows 下 Edge 会 fork 多个子进程）。 */
async function killProcessTree(child) {
  if (!child) return;
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      const timer = setTimeout(resolve, 5000);
      killer.once('exit', () => { clearTimeout(timer); resolve(); });
      killer.once('error', () => { clearTimeout(timer); child.kill(); resolve(); });
    });
    return;
  }
  child.kill('SIGKILL');
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.handlers = new Map();
  }

  /** 订阅某个 CDP 事件（可多个监听）。 */
  on(method, handler) {
    const list = this.handlers.get(method) ?? [];
    list.push(handler);
    this.handlers.set(method, list);
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
      for (const handler of this.handlers.get(message.method) ?? []) {
        try { handler(message.params); } catch { /* ignore */ }
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

/** 打开 Network 域并打印 API/WebSocket 诊断（--netlog）。 */
async function enableNetLog(cdp, options = {}) {
  await cdp.send('Network.enable');
  const interesting = /\/api|remote\.mux|__dshremote/iu;
  cdp.on('Network.requestWillBeSent', (params) => {
    const request = params.request ?? {};
    if (interesting.test(request.url ?? '')) {
      console.log(`[net ->] ${request.method} ${String(request.url).slice(0, 180)}`);
    }
  });
  cdp.on('Network.responseReceived', (params) => {
    const response = params.response ?? {};
    if (interesting.test(response.url ?? '')) {
      console.log(`[net <-] ${response.status} ${String(response.url).slice(0, 180)}`);
    }
  });
  cdp.on('Network.loadingFailed', (params) => {
    console.log(`[net FAIL] ${params.errorText ?? ''} blocked=${params.blockedReason ?? '-'} type=${params.type ?? '-'}`);
  });
  cdp.on('Network.webSocketCreated', (params) => {
    console.log(`[ws created] ${String(params.url).slice(0, 160)}`);
  });
  cdp.on('Network.webSocketHandshakeResponseReceived', (params) => {
    const response = params.response ?? {};
    console.log(`[ws handshake] ${response.status} headers=${JSON.stringify(response.headers ?? {}).slice(0, 180)}`);
  });
  let wsFrameRecv = 0;
  let wsFrameSent = 0;
  cdp.on('Network.webSocketFrameReceived', (params) => {
    const frame = params.response ?? {};
    wsFrameRecv += 1;
    if (wsFrameRecv <= 8) console.log(`[ws recv] op=${frame.opcode} len=${String(frame.payloadData ?? '').length}`);
    if (frame.opcode === 8) console.log(`[ws recv CLOSE] ${JSON.stringify(frame).slice(0, 200)}`);
  });
  cdp.on('Network.webSocketFrameSent', (params) => {
    const frame = params.response ?? {};
    wsFrameSent += 1;
    if (wsFrameSent <= 8) console.log(`[ws sent] op=${frame.opcode} len=${String(frame.payloadData ?? '').length}`);
    if (frame.opcode === 8) console.log(`[ws sent CLOSE] ${JSON.stringify(frame).slice(0, 200)}`);
  });
  cdp.on('Network.webSocketClosed', (params) => {
    console.log(`[ws closed] ${JSON.stringify(params).slice(0, 200)}`);
  });
  cdp.on('Network.webSocketFrameError', (params) => {
    console.log(`[ws frame error] ${String(params.errorMessage ?? '').slice(0, 200)}`);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const edge = args.edge ?? EDGE_DEFAULT;
  const connectPort = args.connectPort;
  const port = args.port ?? await getFreePort();
  const userDataDir = connectPort === undefined
    ? await mkdtemp(path.join(os.tmpdir(), 'dshremote-cdp-'))
    : null;
  let browser = null;
  const client = { close() {} };
  try {
    let cdp;
    if (connectPort !== undefined) {
      // 连接已存在的调试端点（例如 Android WebView 经 adb forward 暴露的 CDP）
      const targets = await fetchJson(`http://127.0.0.1:${connectPort}/json/list`);
      const page = targets.find((entry) => entry.type === 'page') ?? targets[0];
      if (page === undefined) throw new Error('CDP 端点没有可用的页面 target');
      cdp = new CdpClient(page.webSocketDebuggerUrl);
      client.close = () => cdp.close();
      await cdp.connect();
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Log.enable').catch(() => {});
      // 打印页面 console / 异常，便于排查 WebView 里的问题
      cdp.on('Runtime.consoleAPICalled', (params) => {
        const text = (params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
        console.log(`[console.${params.type}] ${String(text).slice(0, 500)}`);
      });
      cdp.on('Runtime.exceptionThrown', (params) => {
        const details = params.exceptionDetails ?? {};
        console.error(`[exception] ${details.text ?? ''} ${details.exception?.description ?? ''}`.slice(0, 800));
      });
      cdp.on('Log.entryAdded', (params) => {
        const entry = params.entry ?? {};
        console.log(`[log.${entry.level}] ${String(entry.text ?? '').slice(0, 500)}`);
      });
      if (args.netlog) await enableNetLog(cdp, args);
      if (args.reload) {
        await cdp.send('Page.reload', { ignoreCache: true });
      }
      await sleep(args.wait);
    } else {
      browser = spawn(edge, [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--no-sandbox',
        '--disable-extensions',
        '--hide-scrollbars',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${userDataDir}`,
        'about:blank',
      ], { stdio: 'ignore', windowsHide: true });

      await waitForBrowser(port);
      const target = await fetchJson(
        `http://127.0.0.1:${port}/json/new?${encodeURIComponent('about:blank')}`,
        { method: 'PUT' },
      );
      cdp = new CdpClient(target.webSocketDebuggerUrl);
      client.close = () => cdp.close();
      await cdp.connect();

      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      if (args.preloadFile) {
        const { readFile } = await import('node:fs/promises');
        const source = await readFile(args.preloadFile, 'utf8');
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
      }
      if (args.netlog) await enableNetLog(cdp, args);
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
    }

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

    if (args.steps) {
      const { readFile } = await import('node:fs/promises');
      const steps = JSON.parse(await readFile(args.steps, 'utf8'));
      for (const [index, step] of steps.entries()) {
        const label = `[step ${index + 1}]`;
        try {
          if (step.clickSelector || step.clickText) {
            const expression = step.clickSelector
              ? `(() => { const el = document.querySelector(${JSON.stringify(step.clickSelector)}); if (!el) return { clicked: false }; el.click(); return { clicked: true, cls: String(el.className).slice(0, 60) }; })()`
              : `(() => { const t = ${JSON.stringify(step.clickText)}; const els = [...document.querySelectorAll('button, [role="button"], a, [tabindex]')]; const el = els.find((e) => (e.textContent || '').trim().includes(t)); if (!el) return { clicked: false, available: els.map((e) => (e.textContent || '').trim().slice(0, 20)).filter(Boolean).slice(0, 15) }; el.click(); return { clicked: true, text: (el.textContent || '').trim().slice(0, 40) }; })()`;
            const clicked = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
            console.log(label, 'click:', JSON.stringify(clicked.result.value));
          }
          if (step.mouse) {
            const [x, y] = step.mouse;
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
            await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
            await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
            console.log(label, `mouse click: ${x},${y}`);
          }
          if (step.typeText) {
            const focused = await cdp.send('Runtime.evaluate', {
              expression: `(() => {
                const el = document.querySelector('[contenteditable="true"], textarea, input[type="text"]');
                if (!el) return { focused: false };
                el.focus();
                return { focused: true, tag: el.tagName };
              })()`,
              returnByValue: true,
            });
            console.log(label, 'focus:', JSON.stringify(focused.result.value));
            await cdp.send('Input.insertText', { text: step.typeText });
            console.log(label, 'typeText:', step.typeText.slice(0, 60));
          }
          if (step.keys) {
            const combo = String(step.keys).split('+').map((part) => part.trim()).filter(Boolean);
            const key = combo[combo.length - 1];
            const modifierMap = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
            let modifiers = 0;
            for (const part of combo.slice(0, -1)) modifiers |= modifierMap[part] ?? 0;
            const upper = key.length === 1 ? key.toUpperCase() : key;
            const code = key.length === 1 ? `Key${upper}` : key;
            const keyCode = key.length === 1 ? upper.charCodeAt(0) : 0;
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
            await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
            console.log(label, `keys: ${step.keys}`);
          }
          if (step.evalFile || step.eval) {
            const { readFile: rf } = await import('node:fs/promises');
            const source = step.evalFile ? await rf(step.evalFile, 'utf8') : step.eval;
            const result = await cdp.send('Runtime.evaluate', { expression: source, returnByValue: true, awaitPromise: true });
            console.log(label, 'eval:', JSON.stringify(result.result.value, null, 2));
          }
          await sleep(step.wait ?? 500);
          if (step.screenshot) {
            const shot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
            await mkdir(path.dirname(path.resolve(step.screenshot)), { recursive: true });
            await writeFile(step.screenshot, Buffer.from(shot.data, 'base64'));
            console.log(label, '截图:', path.resolve(step.screenshot));
          }
          if (step.dom) {
            const dom = await cdp.send('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
            await mkdir(path.dirname(path.resolve(step.dom)), { recursive: true });
            await writeFile(step.dom, dom.result.value, 'utf8');
            console.log(label, 'DOM:', path.resolve(step.dom));
          }
        } catch (error) {
          console.error(label, '失败:', error.message);
        }
      }
    }

    if (args.clickSelector) {
      const clickResult = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const target = document.querySelector(${JSON.stringify(args.clickSelector)});
          if (!target) return { clicked: false };
          target.click();
          return { clicked: true, tag: target.tagName, cls: String(target.className).slice(0, 80) };
        })()`,
        returnByValue: true,
      });
      console.log('点击(selector)结果:', JSON.stringify(clickResult.result.value));
      await sleep(2500);
    }

    if (args.eval || args.evalFile) {
      const { readFile } = await import('node:fs/promises');
      const source = args.evalFile ? await readFile(args.evalFile, 'utf8') : args.eval;
      const evalResult = await cdp.send('Runtime.evaluate', {
        expression: source,
        returnByValue: true,
        awaitPromise: true,
      });
      console.log('eval:', JSON.stringify(evalResult.result.value, null, 2));
      if (evalResult.exceptionDetails) {
        console.error('eval 异常:', JSON.stringify(evalResult.exceptionDetails, null, 2));
      }
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
    await killProcessTree(browser);
    await sleep(300);
    if (userDataDir !== null) {
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

const watchdog = setTimeout(() => {
  console.error('[cdp] 总超时（watchdog），强制退出');
  process.exit(2);
}, Number(process.env.CDP_TIMEOUT_MS ?? 240000));
watchdog.unref?.();

main().catch((error) => {
  console.error('[cdp] 失败:', error.message);
  process.exit(1);
}).finally(() => {
  clearTimeout(watchdog);
});
