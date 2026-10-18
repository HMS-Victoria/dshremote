/**
 * 宿主事件总线。
 *
 * dsh-remote-host 插件把值得通知的宿主事件（审批请求、本轮结束、Agent 错误）
 * 追加到 `~/.dsh/remote/events-<profile>.jsonl`。本模块从文件末尾跟随
 * （首次读取时跳过历史内容），把新事件放进环形缓冲并广播给订阅者（daemon 的
 * `/__dshremote/events` WebSocket，手机 App 用）。
 *
 * 只用轮询（1s）而不是 fs.watch：Windows 上对“边写边读”的日志文件更稳，
 * 而且事件量很小（每个回合个位数），开销可以忽略。
 */
import { open, stat } from 'node:fs/promises';

/** 最近事件在内存里保留多少条（供 App 重连时补发）。 */
const RECENT_LIMIT = 100;

export class HostEventBus {
  /** @param {string} file @param {(message: string) => void} log */
  constructor(file, log) {
    this.file = file;
    this.log = log;
    this.recent = [];
    this.listeners = new Set();
    this.offset = 0;
    this.initialized = false;
    this.reading = false;
    this.timer = null;
  }

  start() {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      void this.poll();
    }, 1_000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.log(`[events] 跟随宿主事件日志: ${this.file}`);
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** @param {number} limit @returns {object[]} 最近的若干条事件（旧 → 新）。 */
  getRecent(limit = 20) {
    const size = Math.max(0, Math.min(limit, this.recent.length));
    return this.recent.slice(this.recent.length - size);
  }

  /**
   * 订阅新事件。
   * @param {(event: object) => void} listener
   * @returns {() => void} 取消订阅。
   */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** @param {object} event */
  push(event) {
    this.recent.push(event);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 单个订阅者出错不影响其它订阅者
      }
    }
  }

  async poll() {
    if (this.reading) return;
    this.reading = true;
    try {
      let info;
      try {
        info = await stat(this.file);
      } catch {
        return; // 文件还不存在（插件未加载 / 尚未产生事件）
      }
      if (!this.initialized) {
        // 首次读取跳过历史内容，避免把上次运行的事件重放给手机
        this.initialized = true;
        this.offset = info.size;
        return;
      }
      if (info.size < this.offset) this.offset = 0; // 文件被截断/重建
      if (info.size === this.offset) return;

      const handle = await open(this.file, 'r');
      try {
        const length = info.size - this.offset;
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, this.offset);
        this.offset = info.size;
        for (const line of buffer.toString('utf8').split('\n')) {
          const trimmed = line.trim();
          if (trimmed === '') continue;
          try {
            const event = JSON.parse(trimmed);
            if (event !== null && typeof event === 'object') this.push(event);
          } catch {
            // 半行（插件正在写）留到下一轮再读不到就忽略
          }
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      this.log(`[events] 读取失败: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.reading = false;
    }
  }
}
