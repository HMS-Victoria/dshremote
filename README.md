# dshremote

手机（Android）远程控制 PC 上正在运行的 **DeepSeek Harness（DSH）** agent。
类似 codexremote，但利用 DSH 自身的 Host/Client 架构：手机端拿到的是真实 DSH 界面
（实时会话、流式输出、工具审批、文件浏览），而不是一份简化的副本。

> 当前版本 **0.4.7**，功能概览：
> - 手机端：Android App（原生外壳 + WebView）+ 扫码配对 + 通知（审批/回合完成/错误）+
>   横竖屏/软键盘适配 + 断线横幅 + 手机端添加工作区 + **持久配对**（配对一次长期有效）；
> - 电脑端：daemon 以**接管模式**直接操控桌面 DSH 宿主；设备配对鉴权、审计日志、
>   配对限速、公网配对窗口、设备令牌哈希/过期/数量上限、设备复用；
> - 组网：**WireGuard 点对点**（电脑做服务端，手机导入配置后直连家宽公网 UDP 端口），
>   daemon 只对 WireGuard / 局域网网段开放，**公网没有 HTTP 入口**；
> - 安全：公网只暴露一个加密的 WireGuard UDP 端口；另有「受限令牌运行」方案见
>   [docs/security.md](docs/security.md)；
> - 文档：方案 [docs/design.md](docs/design.md)、组网 [docs/network.md](docs/network.md)、
>   测试 [docs/tester-guide.md](docs/tester-guide.md)、Android 构建 [android/README.md](android/README.md)。
>
> **下载**：`dist/dshremote-0.4.7-debug.apk`（手机端）与
> `dist/dshremote-pc-0.4.7.zip`（电脑端：插件 + daemon + 工具脚本 + APK + 说明）。
> 自行打包：`.\tools\package-pc.ps1`（输出到 `dist\`，不入库）。

## 原理

```
Android App（原生外壳 + WebView）
      │ HTTP/WS（WireGuard 加密隧道 10.9.0.1 / 局域网）
      ▼
dshremote daemon（Node，含移动端样式注入/通知/配对鉴权）
      │ loopback + DSH 签名 cookie
      ▼
DSH 桌面宿主
```

## 图形管理面板（推荐）

双击项目根目录下的 `dshremote-gui.cmd` 打开管理面板，可直接：
- 查看/启动/停止/重启 daemon；
- 显示配对码、一键重新生成、打开二维码页面、复制服务器地址；
- 查看/吊销已配对设备；
- 查看 WireGuard 状态、切换开机自启、局域网直连开关、查看日志。

## 日常使用（WireGuard）

1. 电脑：WireGuard 隧道服务 `WireGuardTunnel$server`（自启动，10.9.0.1）；
   daemon 由计划任务 `dshremote-daemon` 登录后自动后台启动；
2. 路由器：已设置 UDP 51820 → 电脑；公网只开这一个加密端口；
3. 手机：安装 WireGuard App 并导入 `.data\wireguard\phone-qr.png` 的配置，连接后手机地址 10.9.0.2；
4. DSH Remote App：服务器地址填 `http://10.9.0.1:7801`，配对后长期有效；
5. 在家同一 Wi-Fi 时可直接走局域网（管理面板可开开关，App 自动选择可用地址）。

> ⚠️ 手机上的 WireGuard 是 VPN 应用，与梯子互斥，用 DSH 时先关梯子。

## 常用命令

```powershell
.\tools\start.ps1 -Background   # 启动 daemon（后台）
.\tools\stop.ps1                # 停止 daemon
.\tools\pair-info.ps1           # 查看配对码、地址、设备数
.\tools\show-qr.ps1             # 打开配对二维码页面
.\tools\devices.ps1             # 设备列表 / 吊销（-Revoke <id>）
.\tools\diag.ps1                # 诊断（WS 握手、客户端日志）
```

## 目录

```
docs/design.md        完整设计方案
docs/network.md       组网（WireGuard + 局域网）
docs/security.md      安全加固 & 普通权限运行
server/               daemon（Node ESM，零依赖）
server/mobile/        注入的移动端样式/脚本/PWA manifest
plugin/               DSH 宿主插件（接管模式）
android/              Android App
tools/                脚本（启动/配对/设备/诊断/打包/安全）
.data/                运行时数据（gitignore，含 WireGuard 私钥，注意保管）
```

## 安全提示

DSH agent 能执行任意命令，**能访问 dshremote 就等价于能控制这台 PC**。
项目已内置：WireGuard 加密组网（公网只开 UDP 51820，无 HTTP 入口）、配对限速、
一次性短时配对码、设备令牌只存哈希、默认 10 年有效、最多 5 台设备、审计日志。
仍建议：DSH 以普通用户 / 受限令牌运行（见 [docs/security.md](docs/security.md)），
不要把 WireGuard 配置 / 配对码 / 设备令牌发给他人。
