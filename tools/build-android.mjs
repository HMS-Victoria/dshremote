#!/usr/bin/env node
/**
 * 构建 Android debug APK（调用本机 Gradle，无需 wrapper）。
 * 用法：node tools/build-android.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const GRADLE = 'D:\\Android\\gradle-8.11.1\\bin\\gradle.bat';
const JDK = 'C:\\Program Files\\Microsoft\\jdk-21.0.10.7-hotspot';

if (!existsSync(GRADLE)) {
  console.error(`找不到 Gradle: ${GRADLE}`);
  process.exit(1);
}
if (!existsSync(JDK)) {
  console.error(`找不到 JDK: ${JDK}`);
  process.exit(1);
}
if (!existsSync(path.join(ANDROID_DIR, 'local.properties'))) {
  console.error('缺少 android/local.properties（sdk.dir=D:\\Android）');
  process.exit(1);
}

const child = spawn(GRADLE, ['assembleDebug', '--no-daemon', '--console=plain'], {
  cwd: ANDROID_DIR,
  env: { ...process.env, JAVA_HOME: JDK, ANDROID_HOME: 'D:\\Android' },
  stdio: 'inherit',
  windowsHide: true,
  // Windows 下 gradle.bat 需要经 cmd.exe 启动，否则 Node 24 spawn 报 EINVAL
  shell: true,
});
child.on('exit', (code) => {
  if (code === 0) {
    console.log('\nAPK: android/app/build/outputs/apk/debug/app-debug.apk');
  }
  process.exit(code ?? 1);
});
