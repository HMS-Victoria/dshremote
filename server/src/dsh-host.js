/**
 * DSH 宿主管理：自启模式 + 接管模式。
 *
 * 自启模式：
 * 1. spawn 桌面版 CLI，以 web profile 启动一个只绑 loopback 的宿主；
 * 2. 从 stdout 解析带 token 的启动 URL；
 * 3. GET 该 URL 换取签名会话 cookie，作为代理层的上游凭据。
 *
 * 接管模式（M4 插件）：
 * 读取 dsh-remote-host 插件写出的 host-<profile>.json，同样换取 cookie 后
 * 直接代理到**已经运行的宿主**（例如桌面 App 自己的 Host），不再 spawn 第二个
 * 宿主，从而避免两个 Host 争抢同一份会话写句柄。
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';

/** 不传给子宿主的 DSH 进程级环境变量，避免继承本会话的上下文。 */
const STRIPPED_ENV = /^(DSH_PROFILE|DSH_PROFILE_DIR|DSH_SESSION_ID|DSH_WEB_URL|DSH_SHELL)$/u;

export function hostEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!STRIPPED_ENV.test(key)) env[key] = value;
  }
  env.ELECTRON_RUN_AS_NODE = '1';
  return { ...env, ...extra };
}

/** 极简 GET（不跟随重定向，逐跳手动处理）。 */
function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const request = http.request({
      host: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'GET',
      headers: { host: target.host, ...headers },
      timeout: 30_000,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on('timeout', () => request.destroy(new Error('DSH 认证请求超时')));
    request.on('error', reject);
    request.end();
  });
}

function mergeSetCookie(cookie, setCookie) {
  if (!setCookie) return cookie;
  const entries = Array.isArray(setCookie) ? setCookie : [setCookie];
  const map = new Map();
  for (const entry of cookie.split(';')) {
    const index = entry.indexOf('=');
    if (index > 0) map.set(entry.slice(0, index).trim(), entry.slice(index + 1).trim());
  }
  for (const entry of entries) {
    const pair = entry.split(';')[0];
    const index = pair.indexOf('=');
    if (index > 0) map.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return [...map].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** 用带启动 token 的 URL 换取 DSH 的签名会话 cookie。 */
export async function exchangeCookie(tokenUrl) {
  let current = tokenUrl;
  let cookie = '';
  for (let hop = 0; hop < 6; hop += 1) {
    const response = await httpGet(current, cookie ? { cookie } : {});
    cookie = mergeSetCookie(cookie, response.headers['set-cookie']);
    const location = response.headers.location;
    if (response.status >= 300 && response.status < 400 && location) {
      current = new URL(location, current).href;
      continue;
    }
    break;
  }
  if (!cookie) throw new Error('未能从 DSH 宿主换取认证 cookie（启动 URL 无效？）');
  return cookie;
}

export class DshHost {
  /** @param {object} config @param {(message: string) => void} log */
  constructor(config, log) {
    this.config = config;
    this.log = log;
    this.child = null;
    this.upstream = null;
  }

  async start() {
    const { executable, cli, profile, extraArgs, startTimeoutMs } = this.config;
    const args = [
      '--expose-internals', cli,
      '--profile', profile,
      '--no-open',
      '--host', '127.0.0.1',
      '--port', '0',
      ...(extraArgs ?? []),
    ];
    this.log(`[host] ${executable}`);
    this.log(`[host] 启动: --profile ${profile} --host 127.0.0.1 --port 0`);
    const child = spawn(executable, args, {
      env: hostEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trimEnd();
      if (text) this.log(`[host:err] ${text}`);
    });

    const tokenUrl = await this.waitForUrl(child, startTimeoutMs);
    this.log(`[host] 已就绪: ${new URL(tokenUrl).origin}`);
    const cookie = await exchangeCookie(tokenUrl);
    this.upstream = {
      origin: new URL(tokenUrl).origin,
      host: new URL(tokenUrl).host,
      cookie,
      pid: child.pid,
      mode: 'spawn',
      profile,
    };
    this.log('[host] 已换取签名 cookie');
    return this.upstream;
  }

  waitForUrl(child, timeoutMs) {
    return new Promise((resolve, reject) => {
      let buffer = '';
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.stdout.off('data', onData);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error(`DSH 宿主启动超时（${timeoutMs}ms）`)), timeoutMs);
      const onData = (chunk) => {
        const text = chunk.toString();
        buffer += text;
        for (const line of text.split(/\r?\n/u)) {
          const trimmed = line.trim();
          if (trimmed) this.log(`[host] ${trimmed}`);
        }
        const match = /dsh web:\s*(\S+)/u.exec(buffer);
        if (match) finish(null, match[1]);
      };
      child.stdout.on('data', onData);
      child.once('error', (error) => finish(error));
      child.once('exit', (code) => finish(new Error(`DSH 宿主提前退出（code=${code}）`)));
    });
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    this.log('[host] 停止宿主进程…');
    this.child.kill();
    await Promise.race([
      new Promise((resolve) => this.child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
}

/** DSH home 目录（与 @deepseek-ai/dsh-home-paths 的默认值一致）。 */
export function dshHomeDir() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(homedir(), '.dsh');
}

/** dsh-remote-host 插件写出的 host.json 路径。 */
export function exportedHostPath(profile) {
  return path.join(dshHomeDir(), 'remote', `host-${profile}.json`);
}

/**
 * 接管模式：连接 dsh-remote-host 插件导出的、已经在运行的宿主。
 * 不 spawn、不关闭宿主，只换取一份签名 cookie 后交给代理层。
 */
export class ExportedHost {
  /** @param {string} file @param {(message: string) => void} log */
  constructor(file, log) {
    this.file = file;
    this.log = log;
    this.upstream = null;
  }

  async start() {
    this.log(`[host] 接管模式: ${this.file}`);
    let data;
    try {
      data = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (error) {
      throw new Error(
        `读取 ${this.file} 失败: ${error.message}`
        + '（桌面 DSH 是否装好 dsh-remote-host 插件并重启过？）',
      );
    }
    if (data.source !== 'dsh-remote-host'
      || typeof data.origin !== 'string'
      || typeof data.authenticatedUrl !== 'string') {
      throw new Error(`${this.file} 不是 dsh-remote-host 导出的有效文件`);
    }
    const origin = new URL(data.origin).origin;
    const cookie = await exchangeCookie(data.authenticatedUrl);
    const probe = await httpGet(`${origin}/`, { cookie, accept: 'text/html' });
    if (probe.status !== 200 || !String(probe.headers['content-type'] ?? '').includes('text/html')) {
      throw new Error(`接管失败：${origin} 返回 ${probe.status}（宿主可能已退出）`);
    }
    this.upstream = {
      origin,
      host: new URL(origin).host,
      cookie,
      pid: data.pid,
      mode: 'plugin',
      profile: data.profile,
      exportedAt: data.updatedAt,
    };
    this.log(`[host] 已接管 ${origin}（profile=${data.profile}, pid=${data.pid}）`);
    this.log('[host] 已换取签名 cookie');
    return this.upstream;
  }

  async stop() {
    // 桌面 App 还在用这个宿主，接管方只解除引用，不能关闭它。
    this.log('[host] 接管模式：保留宿主进程运行');
  }
}
