/**
 * 手机端「添加工作区」用的目录浏览：只列目录，不读文件内容。
 *
 * 桌面端 DSH 用的是主机原生目录选择器（只在电脑上弹窗），远程客户端没法用；
 * daemon 直接在自己的文件系统上列目录，手机通过设备 cookie 鉴权后浏览。
 */
import { access, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_ENTRIES = 400;

/** 可访问的盘符（Windows）或根目录（其他平台）。 */
async function listDrives() {
  if (process.platform !== 'win32') return [];
  const drives = [];
  for (let code = 65; code <= 90; code += 1) {
    const root = `${String.fromCharCode(code)}:\\`;
    try {
      await access(root);
      drives.push(root);
    } catch {
      // 盘符不存在
    }
  }
  return drives;
}

/** 判断路径是否是目录（符号链接跟随）。 */
async function isDirectory(target) {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 列出一个目录下的子目录。
 * @param {string} inputPath 绝对路径；空字符串表示用户主目录。
 * @returns {Promise<{ path: string, home: string, parent: string|null, entries: Array<{ name: string, path: string, hidden: boolean }>, truncated: boolean, drives: string[] }>}
 */
export async function listDirectory(inputPath) {
  const home = os.homedir();
  const requested = typeof inputPath === 'string' ? inputPath.trim() : '';
  const target = requested === '' ? home : path.resolve(requested);
  if (!(await isDirectory(target))) {
    const error = new Error('目录不存在或无法访问');
    error.code = 'ENOENT';
    throw error;
  }

  const dirents = await readdir(target, { withFileTypes: true });
  const entries = [];
  for (const dirent of dirents) {
    const entryPath = path.join(target, dirent.name);
    const isDir = dirent.isDirectory() || (dirent.isSymbolicLink() && (await isDirectory(entryPath)));
    if (!isDir) continue;
    entries.push({ name: dirent.name, path: entryPath, hidden: dirent.name.startsWith('.') });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  const parent = path.dirname(target);
  return {
    path: target,
    home,
    parent: parent === target ? null : parent,
    entries: entries.slice(0, MAX_ENTRIES),
    truncated: entries.length > MAX_ENTRIES,
    drives: await listDrives(),
  };
}

// 自查：node server/src/browse.js [目录]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const listing = await listDirectory(process.argv[2] ?? '');
  console.log(JSON.stringify({
    path: listing.path,
    parent: listing.parent,
    drives: listing.drives,
    firstEntries: listing.entries.slice(0, 8).map((entry) => entry.name),
    total: listing.entries.length,
  }, null, 2));
}
