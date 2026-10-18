# dshremote 设计方案

> 状态：Phase 0 + M2 完成；**M3 Android 混合壳已完成模拟器端到端验证**
> （2026-10-18，同一 APK 待用户真机确认）；M1/M4 待办
> 最后更新：2026-10-18

## 0. 实施进度

### M3（2026-10-18）：Android 混合壳（MVP）

- Gradle 工程（AGP 8.7.3 / Kotlin 2.0.21 / Compose BOM 2024.10 / JDK 21 / SDK 35，
  Gradle 8.11.1 装在 `D:\Android\gradle-8.11.1`，并生成 wrapper）；
- **原生配对页**：服务器地址 + 6 位配对码 → `POST /__dshremote/pair` 换取设备令牌
  （HttpURLConnection，IO 线程 + 错误提示）；令牌存 SharedPreferences；
- **WebView 壳**：写入 `dshremote_device` Cookie 后加载 daemon；支持图片附件
  （系统文件选择器）、外部链接交给系统浏览器、返回键先交给注入脚本
  （`window.dshremoteGoBack`，关闭抽屉/右栏）再退回历史，最后弹原生连接菜单；
- **原生连接菜单**：注入脚本里长按左上角悬浮按钮可调用 `window.DshRemoteNative.showMenu()`
  （刷新页面 / 切换服务器 / 退出）；
- 构建脚本 `tools/build-android.mjs`，产物：
  `android/app/build/outputs/apk/debug/app-debug.apk`（约 10MB debug，包名
  `dev.dshremote.app`，minSdk 26 / target 35）；`dist/dshremote-0.1.0-debug.apk` 为副本；
- **模拟器端到端验证通过**（Android 35 x86_64 模拟器，720×1280）：
  配对页输入服务器 + 配对码 → 成功换取令牌 → WebView 加载 DSH 界面（移动注入生效：
  悬浮菜单、工作区选择、输入区、状态条渲染正常）；Android 返回键可关闭移动端抽屉；
- 验证过程中发现并修复：**旧 WebView（124）里 `100vh/100dvh/100%` 会算成 0**，
  导致整页高度 0、全黑。已在 `mobile.js` 注入口注入 `--dshremote-vh`（真实 innerHeight）
  并由 `mobile.css` 兜底撑开 html/body/#root（mobile shell v0.2.2）；
- 验证工具：`tools/cdp.mjs` 新增 `--connect-port`，可直连 Android WebView 的 CDP
  （经 `adb forward`），导出 DOM/截图/console 日志——模拟器软件 GPU 下系统截屏不可靠，
  这是更可靠的验证方式。

待办：用户真机安装确认；扫码配对（QR + 相机权限）；通知（依赖 daemon 事件通道）；
重新配对/失效令牌的提示。

**真机兼容性修复（旧 WebView / 华为 ArkWeb）**：真机（某款 Android 手机，Android 12
兼容层 WebView）出现"一直重新连接中"。通过 daemon 诊断 + 页面内注入的 WebSocket
监控定位到：WS 握手/鉴权/API 全部正常，但客户端**一帧都收不到**，且页面报
`Promise.withResolvers is not a function` / `AbortSignal.any is not a function`。
即旧内核缺少这些新 API，DSH 客户端模块初始化失败，mux 握手帧从未发出 → 就绪超时 →
无限重连。修复：在注入的 `<head>` 引导脚本里加 polyfill（`Promise.withResolvers`、
`AbortSignal.any`、`throwIfAborted`、`structuredClone`、`toSorted`、`findLastIndex`、
`crypto.randomUUID`、`navigator.clipboard` 兜底），并加 console.error/JS 异常/
WebSocket 关闭码上报（`POST /__dshremote/client-log`）。用"删除这些 API 再加载页面"
的模拟旧内核测试验证：mux 帧收发恢复正常、无重连。另新增 daemon
`/__dshremote/diag` 诊断端点与 `tools/diag.ps1`。

### M2（2026-10-18）：移动端适配核心可用

已验证（390×844 无头浏览器 + 真实 DSH web 宿主）：

- **导航**：隐藏 DSH 原生 56px 图标栏，改为左上角悬浮菜单按钮；复用 DSH 侧栏展开逻辑，
  展开后以覆盖式抽屉（84vw/300px）滑入，遮罩点击/Session 点击自动收起；
- **右栏**：DSH 在 viewport < 768 时自动把右侧栏切成全屏模式
  （`data-sidebar-right-panel=fullscreen`），外层做全屏覆盖即可；文件浏览器实测可用；
- **聊天**：会话全宽；消息/代码块/元信息渲染正常；底部输入区固定；
- **状态条**：轮数/token/上下文统计一行的间距与留白已调整（隐藏百分比前的环形图标），
  390px 下三项完整可见，超长时可横向滑动；
- **会话标题**：DSH 原生 header 标题恢复显示（隐藏了子智能体入口让位）；
- **设置页（真机反馈修复）**：设置弹窗在手机上改为全屏 + 上下布局，左侧导航变成横向
  tabs（图标 16px 固定、可横向滑动）；账号/通用/模型等页面在 390px 下正常渲染；
  打开设置时自动收起抽屉、隐藏悬浮按钮；
- **端到端**：无头浏览器中实际新建会话、发送消息、收到模型回复（"收到。"，1 秒）；
- 工具：`tools/cdp.mjs` 增加 `--steps` 场景脚本（点击/输入/按键/截图/DOM/eval）、
  `--eval-file`、`--mouse`、`--keys`，可复现整条移动端交互流程；修复了
  Windows 下 Edge 进程树未清理导致的偶发挂起（改随机调试端口 + taskkill /T）。

证据：`.data/shots/m2-19-response.png`（对话+输入区）、`m2-05-drawer.png`（抽屉）、
`m2-16-files.png`（文件浏览）、`m2-33-settings-final-account.png` /
`m2-34-settings-final-general.png`（设置页）、`m2-32-status-bar.png`（状态条）。

待办：审批弹窗实测（当前 workspace-write preset 不触发审批，需要更严格 preset 或
在插件模式/提升权限时验证）；设置页部分深层表单（插件列表等）待逐页验证。

### Phase 0（已完成）：代理链路 spike

已验证：

- daemon 自启 `dsh --profile web` 宿主，从 stdout 解析启动 token URL；
- 用 token 换取 DSH 签名 cookie（30 天）；
- 局域网 HTTP 反向代理：HTML 注入（`dsh-mobile` 类、mobile.css/js、PWA manifest）生效；
- 静态资源（约 1.6MB JS/CSS）透传正常；
- 无配对请求只返回配对页；配对后 Set-Cookie 设备令牌，进入真实 DSH 界面；
- CDP 无头浏览器在 390×844 视口成功渲染真实 GUI（Edge 无头模式对长连接页面会挂起，
  已改用 `tools/cdp.mjs` 直接走 CDP，可截图 + 导出 DOM + 点击元素）。

证据：`.data/shots/mobile-390-after.png`（真实界面截图）、`.data/shots/mobile-390-after.html`（DOM）。

结论：方向 A 的代理链路成立；桌面布局在手机上确认需要 M2 的适配层。

## 1. 背景与目标

在手机上远程使用 / 控制 PC 上正在运行的 DeepSeek Harness（DSH）agent，类似 codexremote、
cc-remote 这类工具，但深度利用 DSH 自身的 Host/Client 架构。

核心目标（已确认）：

- 手机能**实时接管桌面 DSH 正在跑的会话**：看流式输出、回答审批、继续对话、看会话历史。
- Android 原生 App（第一版为"原生外壳 + WebView 承载 DSH 界面"的混合形态）。
- 网络：**局域网先行**，架构上预留内网穿透（Cloudflare Tunnel / frp / Tailscale 等）。
- 安全：配对令牌 + 审计；DSH 等价于远程 RCE，默认只对可信网络开放。

## 2. 已确认的决策

| 决策点 | 结论 | 说明 |
|---|---|---|
| 主线 | **A：桌面远控插件** | 手机操作正在运行的桌面 DSH（同一会话、实时审批） |
| 手机形态 | Android 原生 App（混合优先） | 原生外壳（配对/服务器/通知）+ WebView 承载 DSH 界面 |
| 网络 | 局域网先行 | App 里"服务器地址 + 配对令牌"抽象，可随时切隧道 |
| 开发环境 | **Windows 原生** | 插件/daemon 依赖 Windows 上的 DSH；Android 构建也放 Windows |
| 首个里程碑 | Phase 0 代理链路 spike | 半天内用手机浏览器连上真实 DSH 界面 |

## 3. 为什么可行（调研事实）

1. DSH 是 Host + Client 架构：GUI 是浏览器客户端，通过 `POST /api`（一元 RPC）和
   `/api/remote.mux`（WebSocket，流式/事件）与 Host 通信。
2. 桌面 App 的 Host 只绑 `127.0.0.1` 随机端口，启动 token 经 IPC 交给 Electron 主进程，
   外部进程拿不到 —— 所以需要宿主内插件来取得认证。
3. 官方插件系统支持给 desktop profile 装本地 / 第三方组合包：
   `dsh plugin --profile desktop ...`、GUI 插件页、`link:` 本地包均可。
4. 宿主 ctx 暴露 `ctx.webServer.getOrigin()` 与 `ctx.connection.authenticatedUrl()`，
   后者返回带进程启动 token 的 URL；用 `GET /` 可换取签名 cookie，`GET /connect?token=...`
   可换取 API Peer（供程序化客户端使用）。→ 插件可以在宿主内"拿到钥匙"。
5. DSH 前端是桌面布局（无宽度断点），需要注入移动端样式做适配。
6. 已实测 `dsh --profile acp` 的 ACP 服务可用（initialize / session/list 正常，
   能列出桌面会话），作为未来"独立移动端原生界面"的备选数据通道。

## 4. 总体架构

```
┌──────────────────────────── Android App（混合） ────────────────────────────┐
│ 原生外壳：配对(扫码/输码)、服务器地址管理、前台服务 + 通知、会话入口            │
│ WebView：DSH 真实界面（注入 mobile.css / mobile.js / PWA manifest）          │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ HTTP/WS（局域网 / 隧道 / 虚拟专网）
                                ▼
┌──────────────────────────── PC：dshremote daemon（Node，主体） ──────────────┐
│ · 配对与鉴权：配对码 → 设备令牌(cookie) → 每个请求校验 + 审计                  │
│ · 反向代理：HTTP + WebSocket 全透传（含 /api/remote.mux）                     │
│ · 移动端注入：改写 index.html，注入移动样式/脚本/PWA                          │
│ · 事件与通知：审批中 / 本轮完成 → App（WebSocket 推送，App 前台服务）          │
│ · 宿主管理：模式一（自启 dsh web）/ 模式二（读取插件导出的 host.json）         │
│ · 隧道管理（后续）：cloudflared 一键启停、二维码                               │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ loopback + 签名 cookie
                                ▼
┌──────────────────── DSH Desktop Host（Electron 内进程） ────────────────────┐
│ 官方插件 dsh-remote-host（极小，仅 ~100 行）：                                 │
│   · 启动时把 { origin, authenticatedUrl } 写入 ~/.dsh/remote/host.json      │
│   · 订阅宿主事件（审批请求、会话状态），供 daemon 推送通知                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 两种宿主接入模式

| 模式 | 用途 | 认证来源 | 是否需装插件 |
|---|---|---|---|
| **自启模式**（dev / 独立使用） | daemon 自己 spawn `dsh --profile web` | 解析启动时打印的 token URL | 否 |
| **接管模式**（正式） | 接入桌面 App 正在运行的 Host | 插件写出的 `host.json` | 是 |

开发期靠自启模式快速迭代，最后再装插件切到接管模式。两种模式对代理层完全透明。

## 5. 关键机制

### 5.1 宿主认证

- 自启模式：`spawn dsh --profile web --host 127.0.0.1 --port 0 --no-open`
  → 从 stdout 解析 `dsh web: http://127.0.0.1:PORT/?token=...`
  → `GET` 该 URL 得到 `Set-Cookie`（签名会话 cookie，30 天有效）
  → 后续代理请求一律带该 cookie，Host 改写为 `127.0.0.1:PORT`。
- 接管模式：插件用 `ctx.webServer.getOrigin()` + `ctx.connection.authenticatedUrl()` 拿到
  同样的带 token URL，写入 `host.json`，daemon 做同样的交换。

### 5.2 反向代理

- 请求：改写 `Host`、`Origin`，注入上游 `Cookie`，禁用上游压缩以便注入 HTML；
  请求体直接 pipe（支持上传）。
- 响应：HTML 响应做注入；其余原样透传；剥离上游 `Set-Cookie`（认证只由我们这层管）。
- WebSocket：`server.on('upgrade')` 鉴权后与上游 `net.connect`，手写握手（带上游 Cookie 和
  改写后的 Origin），双向 pipe。
- 流式响应（SSE / 长轮询）不缓冲。

### 5.3 移动端注入与适配

- 注入内容：`viewport-fit=cover`、我们的 PWA manifest、`mobile.css`、`mobile.js`。
- 适配策略（迭代式）：
  1. 只做安全区、字号、触控尺寸等低风险规则；
  2. 用 Edge 无头浏览器 390×844 截图 + DOM dump 分析真实 DOM；
  3. 逐步做：单列布局、侧栏抽屉化、底部输入区固定、会话列表全屏化；
  4. 通过 `html.dsh-mobile` 类名限定作用范围，避免影响桌面端。
- 所有注入资源由 daemon 自己服务（`/__dshremote/*`），可热更新。

### 5.4 鉴权与配对

- daemon 启动生成 6 位配对码（可配置有效期），打印配对 URL/二维码。
- 手机打开 `/pair?code=XXXXXX` → 校验 → 下发设备令牌 cookie（HttpOnly、SameSite=Lax）
  → 重定向到 `/`。
- 也为 Android 预留 `POST /__dshremote/pair`（JSON: code + deviceName）接口，返回设备令牌。
- 设备列表持久化在 `.data/devices.json`，可撤销；后续加失败限速与审计日志。

### 5.5 通知通道（后续）

- 插件在宿主内订阅事件（审批请求、轮次完成、会话错误）；
- 通过 loopback 内部接口推给 daemon；
- daemon 经与 App 的长连接 WebSocket 推送；
- App 用前台服务维持连接并弹通知，点通知回到对应会话。

### 5.6 网络模式（架构上抽象）

App 只配置 `serverUrl + deviceToken`，底层可切换：

1. 局域网（当前开发）：`http://192.168.x.x:7801`
2. Cloudflare Tunnel：daemon 管理 cloudflared，输出 `https://xxx.trycloudflare.com`
3. 自建 frp：模板配置（frps 在 VPS，frpc 在 PC）
4. Tailscale 类虚拟专网：直接用 100.x IP

## 6. Android App 设计（混合优先）

### 6.1 页面

- 首屏：服务器列表（+ 添加服务器：扫码配对 / 手动输入）
- 主界面：WebView 承载 DSH；原生工具条：刷新、切换服务器、会话入口、设置
- 通知：审批中 / 完成；点击后带上会话 id 自动进入
- 设置：连接诊断、断线重连、清缓存

### 6.2 技术要点

- Kotlin + Jetpack Compose，minSdk 26，targetSdk 35
- WebView：`androidx.webkit`；开启 JS、支持文件选择（相机/相册，对应 DSH 图片附件）
- 网络：OkHttp（WebSocket 长连接）
- 配对扫码：ZXing（离线，不依赖 Google 服务）
- 通知：前台服务 + `POST_NOTIFICATIONS`（Android 13+）
- 构建：Gradle 8.x + AGP，Android SDK 装到 D 盘；产物 debug APK 直接安装

### 6.3 后续原生化路径

1. 原生会话列表 / 审批弹层 / 通知操作按钮（半原生）
2. 移动端 BFF（daemon 把 DSH gateway 数据转成移动 API）→ 聊天界面全原生
3. 备选：ACP 桥接独立会话（不依赖桌面 App 的实时会话）

## 7. 里程碑

| 阶段 | 内容 | 验收 | 预估 |
|---|---|---|---|
| M0 | 代理链路 spike：自启宿主 + token 交换 + HTTP/WS 代理 + 基础注入 | 手机/无头浏览器打开真实 DSH 界面并完成一轮对话 | 0.5–1 天 |
| M1 | daemon 完整：配对、设备管理、审计、配置、健壮重连 | 多个设备配对/撤销；断线自动恢复 | 1–2 天 |
| M2 | 移动端适配层：PWA + mobile.css/js 迭代 | 390×844 下主要流程可用（会话/聊天/审批/文件） | 2–3 天 |
| M3 | Android 混合 App：Gradle 工程、WebView、扫码配对、前台服务通知 | 真机安装 APK，局域网全流程可用 | 3–5 天 |
| M4 | 插件接管桌面 App（host.json + 事件通知） | 手机实时接管桌面正在跑的会话与审批 | 1–2 天 |
| M5 | 隧道集成（cloudflared）+ 可选半原生/全原生 | 任何网络下可用 | 按需 |

## 8. 工程结构

```
dshremote/
├─ docs/design.md           本文件
├─ server/                  daemon（Node 24，ESM，零依赖）
│  ├─ src/
│  │  ├─ index.js           入口：配置、启动宿主、代理
│  │  ├─ config.js          配置加载/默认值（.data/config.json）
│  │  ├─ dsh-host.js        spawn dsh web + token→cookie 交换
│  │  ├─ auth.js            设备令牌、配对码、cookie 校验
│  │  ├─ proxy.js           HTTP/WS 反向代理
│  │  ├─ inject.js          HTML 注入 + 静态资源
│  │  └─ net.js             局域网地址探测
│  └─ mobile/               mobile.css / mobile.js / manifest / icons
├─ plugin/                  DSH 宿主插件（接管模式，M4 实施）
├─ android/                 Android App（M3 实施）
├─ tools/                   开发脚本（启动/停止/诊断）
└─ .data/                   运行时数据（gitignore：配置、设备、日志）
```

## 9. 安全模型

威胁：DSH 能执行任意命令 → 任何能访问 daemon 的人 = 能控制 PC。

- 默认只监听局域网，且必须配对；未配对请求只看到配对页。
- 设备令牌：HttpOnly cookie；服务端只存哈希（后续）；可撤销。
- 审计日志：设备、时间、请求路径、审批动作。
- 隧道模式：必须 HTTPS；建议 Cloudflare Access / IP 白名单；绝不裸奔公网。
- DSH 的启动 token / cookie 只在 PC 侧内存或受限权限文件中，绝不下发手机。
- `host.json` 写盘权限限制为当前用户，daemon 随读随用。

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| DSH 内部 API（`authenticatedUrl`/`webServer`）随版本变化 | 插件极小、失败可降级到自启模式；锁定已验证的版本行为 |
| 双宿主共享 DSH_HOME 并发读写 | 开发期自启模式接受；正式用插件接管单宿主（推荐） |
| WebView 兼容性（DSH 前端面向 Chromium） | Android WebView 内核较新可满足；必要时内嵌 Chrome Custom Tabs 备选 |
| 移动端样式与 DSH DOM 变化冲突 | 注入层独立文件、可热更新；限定 `html.dsh-mobile` |
| HTML 注入被 CSP 拦截 | 外部资源同源加载；必要时代理层扩展 CSP 头 |
| 国内隧道稳定性 | 先局域网；隧道按需选 cloudflared / frp / 虚拟专网，实测决定 |
| 鼠标悬停/快捷键交互缺失 | 移动端适配层补齐触控交互；保留完整桌面功能 |

## 11. 开放问题

- 通知是否需要 FCM（可离线到达）还是前台服务长连接即可？（先长连接）
- Android 最低支持版本与目标机型？（默认 minSdk 26）
- 是否需要多服务器 / 多 PC 管理？（架构已预留服务器列表）
- 是否要做 iOS（PWA 可先覆盖）？
