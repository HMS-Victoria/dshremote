/**
 * dsh-remote-host — dshremote 的宿主桥接插件。
 *
 * 作用：
 * 1. 在 DSH 宿主进程内（Desktop App 自己的 Host，或 `dsh --profile` 起的 Host）
 *    拿到 127.0.0.1 的 origin 与带启动 token 的 authenticatedUrl，写到
 *      $DSH_HOME/remote/host-<profile>.json
 *    局域网侧 dshremote daemon 读取该文件后即可“接管”这个宿主：用 token 换签名
 *    cookie，然后反向代理 + 注入移动端界面。这样手机连的是**同一个宿主**，
 *    不再出现两个 Host 争抢会话写句柄（session/writer-held）的问题。
 * 2. 把宿主内值得通知的事件（审批请求、本轮结束、Agent 错误）追加到
 *      $DSH_HOME/remote/events-<profile>.jsonl
 *    daemon 跟随该文件并把事件推给手机（通知 / 前台服务）。
 *
 * 安全：host.json 只落在本机 `~/.dsh/remote/`，其中 authenticatedUrl 含进程
 * 启动 token；daemon 读取后立即换取 cookie，不会把 token 下发给手机。
 * 事件日志只包含会话 id/标题、工具名、原因等展示信息，不含消息正文。
 */
import { appendFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Stable Cordis plugin name. */
const name = 'dsh-remote-host';

/** Services required before the bridge can resolve the host address. */
const inject = ['webServer'];

/** @returns {string} DSH home directory (matches @deepseek-ai/dsh-home-paths). */
function dshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
}

/**
 * @param {string} profileName - profile name reported by `profileContext`.
 * @returns {string} absolute host.json path for this profile.
 */
function hostFilePath(profileName) {
  return join(dshHome(), 'remote', `host-${profileName}.json`);
}

/**
 * @param {string} profileName - profile name reported by `profileContext`.
 * @returns {string} absolute notification event log path for this profile.
 */
function eventsFilePath(profileName) {
  return join(dshHome(), 'remote', `events-${profileName}.jsonl`);
}

/**
 * Mount the host bridge.
 * @param {object} ctx - Cordis plugin context carrying the webServer service.
 * @param {{ hostFile?: string, eventsFile?: string, state?: string }} [config] - optional overrides.
 */
function apply(ctx, config = {}) {
  try {
    mount(ctx, config);
  } catch (error) {
    // 桥接插件绝不能影响 DSH 本身启动：失败只记录一行日志。
    console.error(`dsh-remote-host: 初始化失败（不影响 DSH 使用）: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

/** @param {object} ctx @param {{ hostFile?: string, eventsFile?: string, state?: string }} config */
function mount(ctx, config) {
  const webServer = ctx.webServer;

  ctx.inject(['connection'], (connectionCtx) => {
    const connection = connectionCtx.connection;
    if (webServer === undefined || connection === undefined) return;

    const profileName = connectionCtx.get('profileContext')?.name
      ?? process.env.DSH_PROFILE
      ?? 'unknown';
    const file = typeof config.hostFile === 'string' && config.hostFile !== ''
      ? config.hostFile
      : hostFilePath(profileName);
    const localOrigin = `${webServer.protocol}//127.0.0.1:${String(webServer.port)}`;

    /** Build one snapshot of everything the LAN daemon needs. */
    const payload = () => ({
      source: 'dsh-remote-host',
      version: '0.2.0',
      profile: profileName,
      pid: process.pid,
      host: '127.0.0.1',
      port: webServer.port,
      origin: webServer.getOrigin(),
      authenticatedUrl: connection.authenticatedUrl(localOrigin),
      state: typeof config.state === 'string' ? config.state : undefined,
      updatedAt: new Date().toISOString(),
    });

    /** Write atomically so the daemon never reads a half-written file. */
    const write = async () => {
      const snapshot = payload();
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${String(process.pid)}.tmp`;
      await writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      await rename(tmp, file);
      return snapshot;
    };

    const announce = () => {
      write().then(
        (snapshot) => console.log(`dsh-remote-host: 已导出宿主地址 → ${file} (${snapshot.origin})`),
        (error) => console.error(`dsh-remote-host: 写出 ${file} 失败: ${error instanceof Error ? error.message : String(error)}`),
      );
    };

    // 等 loader 把整棵树装配完再导出，避免拿到尚未就绪的 connection。
    const settled = connectionCtx.get('loader')?.await();
    if (settled === undefined) announce();
    else settled.then(announce).catch(announce);

    // token 可能随宿主重启轮换：每 5 分钟刷新一次快照（很轻量）。
    const timer = setInterval(announce, 5 * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();

    connectionCtx.effect(() => () => {
      clearInterval(timer);
      rm(file, { force: true }).catch(() => {});
    }, 'dshremote.host-file');

    // ── 通知事件导出（审批 / 本轮结束 / Agent 错误）──────────────────────────
    installEventExport(connectionCtx, {
      file: typeof config.eventsFile === 'string' && config.eventsFile !== ''
        ? config.eventsFile
        : eventsFilePath(profileName),
      profileName,
    });
  });
}

/**
 * 把宿主内值得通知的事件追加到 JSONL 事件日志，供 daemon 跟随并推给手机。
 * 只导出展示所需字段（会话 id/标题、工具名、原因、结果），不包含消息正文。
 * @param {object} ctx - 已注入 connection 的插件上下文。
 * @param {{ file: string, profileName: string }} options
 */
function installEventExport(ctx, { file, profileName }) {
  const base = () => ({ at: new Date().toISOString(), profile: profileName });
  let ready = false;
  let pending = Promise.resolve();
  const emit = (entry) => {
    if (!ready) {
      ready = true;
      mkdir(dirname(file), { recursive: true }).catch(() => {});
    }
    const line = `${JSON.stringify(entry)}\n`;
    pending = pending.then(() => appendFile(file, line, 'utf8')).catch(() => {});
  };
  const sessionId = (session) => session?.header?.id ?? null;
  const sessionTitle = (session) => (typeof session?.header?.title === 'string' ? session.header.title : null);

  ctx.effect(() => {
    const offSession = ctx.on('session/event', (session, event) => {
      try {
        const type = event?.type;
        const data = event?.data ?? {};
        if (type === 'approval/asked') {
          emit({
            ...base(),
            kind: 'approval',
            sessionId: sessionId(session),
            title: sessionTitle(session),
            toolName: data.toolName ?? null,
            reason: data.reason ?? null,
            callId: data.callId ?? null,
          });
        } else if (type === 'approval/decided') {
          emit({
            ...base(),
            kind: 'approval-decided',
            sessionId: sessionId(session),
            title: sessionTitle(session),
            outcome: data.outcome ?? null,
          });
        } else if (type === 'turn/start') {
          emit({ ...base(), kind: 'turn-start', sessionId: sessionId(session), title: sessionTitle(session) });
        } else if (type === 'turn/end') {
          emit({
            ...base(),
            kind: 'turn-end',
            sessionId: sessionId(session),
            title: sessionTitle(session),
            status: data.status ?? data.outcome ?? null,
          });
        }
      } catch { /* 事件导出失败不能影响宿主 */ }
    });
    const offError = ctx.on('agent/error', (payload) => {
      try {
        const session = payload?.agent?.session;
        emit({
          ...base(),
          kind: 'agent-error',
          sessionId: sessionId(session),
          title: sessionTitle(session),
          message: String(payload?.error?.message ?? payload?.error ?? '').slice(0, 300),
        });
      } catch { /* ignore */ }
    });
    return () => {
      try { offSession?.(); } catch { /* ignore */ }
      try { offError?.(); } catch { /* ignore */ }
    };
  }, 'dshremote.events');
}

export { apply, inject, name };
