# dshremote

手机（Android）远程控制 PC 上正在运行的 **DeepSeek Harness（DSH）** agent。
类似 codexremote，但利用 DSH 自身的 Host/Client 架构：手机端拿到的是真实 DSH 界面
（实时会话、流式输出、工具审批、文件浏览），而不是一份简化的副本。

> 当前进度（2026-10-18）：**M2/M3/M4 核心完成**。
> 手机端可通过 Android APK（或浏览器）连接 PC 上的 daemon，使用真实 DSH 界面
> （会话抽屉、聊天、文件浏览、设置页均已适配手机）；已修复旧 WebView 的
> 兼容性问题（polyfill）导致的无限重连。
> **M4 插件接管已生效**：plugin/dsh-remote-host 已装进 desktop profile，
> daemon 以接管模式直接操控桌面 DSH 的宿主（不再有 session/writer-held 冲突）；
> 安装/卸载见 	ools/install-remote-host-plugin.ps1、	ools/uninstall-remote-host-plugin.ps1。
> 下一步：通知动作（审批直接处理）→ M1 daemon 加固 → M3.5 扫码/横屏细节。
> 已支持：手机通知（审批/回合完成/错误）+ 点击通知打开对应会话。
> 完整方案见 [docs/design.md](docs/design.md)；Android 构建见
> [android/README.md](android/README.md)。
>
> **APK**：`dist/dshremote-0.2.0-debug.apk`（debug 签名，直接安装）

## 原理

```
Android App（原生外壳 + WebView）
      │ HTTP/WS（局域网 / 隧道）
      ▼
dshremote daemon（Node）
      │ loopback + DSH 签名 cookie
      ▼
DSH 桌面宿主
```

daemon 负责：设备配对鉴权、HTTP/WebSocket 反向代理、移动端样式注入、通知推送。

两种宿主接入模式：

1. **自启模式**（当前）：daemon 自己 spawn 一个 `dsh web` 宿主，不依赖桌面 App，
   适合开发与独立使用；
2. **接管模式**（M4）：DSH 桌面插件把宿主认证信息导出，daemon 接入桌面 App
   正在运行的宿主，实现"手机实时接管桌面会话"。

## 快速开始（自启模式）

环境：Node.js ≥ 22（本机 v24 已验证）、Windows。

```powershell
# 1. 检查/编辑配置（DSH 安装路径）
notepad .data/config.json

# 2. 启动 daemon（首次会自动拉起 dsh web 宿主，可能需要 10–30 秒）
cd server
node src/index.js
```

启动后会打印类似：

```
 dshremote 已启动
 上游 DSH: http://127.0.0.1:54321
 本机调试: http://127.0.0.1:7801/pair?code=123456
 手机访问: http://192.168.1.10:7801/pair?code=123456   (WLAN)
 配对码:   123456
```

手机连同一 Wi-Fi，浏览器打开"手机访问"链接，输入配对码即进入 DSH 界面。

## 移动端调试（无头浏览器）

```powershell
# 以手机视口打开（配对 URL 会自动下发设备 cookie），导出截图与 DOM
node tools/cdp.mjs --url "http://127.0.0.1:7801/pair?code=123456" `
  --wait 10000 --click "继续" `
  --screenshot .data/shots/mobile.png --dom .data/shots/mobile.html
```

`--click <文字>` 可点击包含该文字的按钮（例如关掉预览版弹窗）。
截图在 `.data/shots/`，可直接用看图工具检查移动端布局。

## 已知事项

- Phase 0 阶段 daemon 会自启一个独立的 `dsh --profile web` 宿主（与桌面 App 共享
  DSH_HOME，但会话是独立进程），用于开发验证；接管桌面 App 是 M4 的插件模式。
- 配对码在 daemon 每次重启后重新生成；当前配对码可复用（M1 会改为一次性）。
- 本机防火墙三个 profile 均关闭，手机可直接连接；若换机器需放行 7801 端口。

## 目录

```
docs/design.md        完整设计方案
server/               daemon（Node ESM，零依赖）
server/mobile/        注入的移动端样式/脚本/PWA manifest
plugin/               DSH 宿主插件（M4）
android/              Android App（M3）
.data/                运行时数据（gitignore）
```

## 安全提示

DSH agent 能执行任意命令，**能访问 dshremote 就等价于能控制这台 PC**。
请只在可信网络（局域网 / Tailscale 等私网）使用；公网必须走 HTTPS + 强认证 + IP 白名单。
