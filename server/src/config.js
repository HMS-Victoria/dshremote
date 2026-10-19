/**
 * 配置加载。
 *
 * 配置位于 <repo>/.data/config.json；首次运行时生成默认值。
 * 关键路径允许用环境变量覆盖（方便换机器 / 换安装位置）：
 *   DSHREMOTE_DSH_EXE  DeepSeek Harness.exe 的绝对路径
 *   DSHREMOTE_DSH_CLI  桌面版 CLI 入口（dsh-desktop-host/lib/cli.js）
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DATA_DIR = path.join(ROOT, '.data');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

/** 默认配置：适合本机的一次性安装；其他机器改这里或改 .data/config.json。 */
export const DEFAULTS = {
  /** 手机访问本 daemon 的监听地址 */
  listen: {
    host: '0.0.0.0',
    port: 7801,
  },
  /** DSH 桌面安装信息（自启模式需要；接管模式下仅作为降级备份） */
  dsh: {
    executable: 'D:\\新建文件夹\\DeepSeek Harness.exe',
    cli: 'D:\\新建文件夹\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js',
    profile: 'web',
    extraArgs: [],
    /** 宿主启动超时（毫秒） */
    startTimeoutMs: 120000,
  },
  /** 配对与设备安全 */
  pairing: {
    /** 配对码有效期（毫秒），默认 10 分钟；null 表示本进程内不过期 */
    codeTtlMs: 10 * 60 * 1000,
    /** 配对码是否一次性：配对成功后立即作废并轮换新码（默认 true） */
    oneTime: true,
    /** 设备令牌有效期（毫秒），默认 10 年（配对一次后长期有效） */
    deviceTtlMs: 3650 * 24 * 60 * 60 * 1000,
    /** 最多允许配对的设备数量 */
    maxDevices: 5,
    /** 公网配对窗口时长（毫秒），默认 5 分钟 */
    publicPairWindowMs: 5 * 60 * 1000,
  },
  /**
   * 宿主接入模式：
   *   auto   先尝试接管插件导出的宿主（host-<profile>.json），没有/失效则自启一个；
   *   plugin 只用插件导出的宿主（缺文件直接报错，不会自启）；
   *   spawn  始终自启一个独立 dsh web 宿主（M3 之前的行为）。
   */
  hostMode: 'auto',
  /** 接管模式下读取哪个 profile 导出的 host.json（桌面 App 为 desktop） */
  hostProfile: 'desktop',
  /** 显式指定 host.json 路径（默认 <DSH_HOME>/remote/host-<hostProfile>.json） */
  hostFile: null,
  /** 显式指定宿主事件日志路径（默认 <DSH_HOME>/remote/events-<profile>.jsonl） */
  hostEventsFile: null,
  /** 是否在启动时打印所有局域网地址 */
  printLanUrls: true,
  /**
   * 外网访问地址（如 Tailscale 的 http://100.x.x.x:7801、frp/域名的 https://...）。
   * 设置后二维码/配对信息优先用它；为空时自动检测 Tailscale 地址，其次局域网。
   */
  publicUrl: null,
};

function deepMerge(base, extra) {
  if (extra === null || typeof extra !== 'object' || Array.isArray(extra)) return extra ?? base;
  const result = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    const baseValue = base?.[key];
    result[key] = baseValue !== null && typeof baseValue === 'object' && !Array.isArray(baseValue)
      ? deepMerge(baseValue, value)
      : value;
  }
  return result;
}

function fromEnv(config) {
  const env = process.env;
  if (env.DSHREMOTE_DSH_EXE) config.dsh.executable = env.DSHREMOTE_DSH_EXE;
  if (env.DSHREMOTE_DSH_CLI) config.dsh.cli = env.DSHREMOTE_DSH_CLI;
  if (env.DSHREMOTE_PORT) config.listen.port = Number(env.DSHREMOTE_PORT);
  if (env.DSHREMOTE_HOST) config.listen.host = env.DSHREMOTE_HOST;
  if (env.DSHREMOTE_HOST_MODE) config.hostMode = env.DSHREMOTE_HOST_MODE;
  if (env.DSHREMOTE_HOST_PROFILE) config.hostProfile = env.DSHREMOTE_HOST_PROFILE;
  if (env.DSHREMOTE_HOST_FILE) config.hostFile = env.DSHREMOTE_HOST_FILE;
  if (env.DSHREMOTE_HOST_EVENTS_FILE) config.hostEventsFile = env.DSHREMOTE_HOST_EVENTS_FILE;
  if (env.DSHREMOTE_PUBLIC_URL) config.publicUrl = env.DSHREMOTE_PUBLIC_URL;
  if (env.DSHREMOTE_PAIRING_TTL_MS) config.pairing.codeTtlMs = Number(env.DSHREMOTE_PAIRING_TTL_MS);
  if (env.DSHREMOTE_DEVICE_TTL_MS) config.pairing.deviceTtlMs = Number(env.DSHREMOTE_DEVICE_TTL_MS);
  if (env.DSHREMOTE_MAX_DEVICES) config.pairing.maxDevices = Number(env.DSHREMOTE_MAX_DEVICES);
  return config;
}

/** 读取配置；文件不存在时写入默认配置。 */
export async function loadConfig() {
  await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(CONFIG_PATH)) {
    await writeFile(CONFIG_PATH, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8');
  }
  const text = await readFile(CONFIG_PATH, 'utf8');
  let stored;
  try {
    stored = JSON.parse(text);
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON: ${CONFIG_PATH} — ${error.message}`);
  }
  const config = fromEnv(deepMerge(DEFAULTS, stored));
  validateConfig(config);
  return config;
}

export function validateConfig(config) {
  const errors = [];
  if (!config.dsh || typeof config.dsh !== 'object') errors.push('dsh 配置缺失');
  if (config.dsh && !existsSync(config.dsh.executable)) {
    errors.push(`找不到 DSH 可执行文件: ${config.dsh.executable}（改 .data/config.json 或设 DSHREMOTE_DSH_EXE）`);
  }
  // 注意：cli 位于 app.asar 内部，宿主进程外的 Node 看不到它，所以只做基本形态检查。
  if (config.dsh && typeof config.dsh.cli !== 'string') {
    errors.push(`dsh.cli 必须是字符串路径（设 DSHREMOTE_DSH_CLI）`);
  }
  if (!Number.isInteger(config.listen?.port) || config.listen.port < 0 || config.listen.port > 65535) {
    errors.push(`listen.port 非法: ${config.listen?.port}`);
  }
  if (errors.length > 0) throw new Error('配置错误：\n  - ' + errors.join('\n  - '));
}
