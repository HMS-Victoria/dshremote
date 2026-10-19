# dshremote

[![Release](https://img.shields.io/github/v/release/HMS-Victoria/dshremote?label=release)](https://github.com/HMS-Victoria/dshremote/releases/latest)

手机（Android）远程控制 PC 上正在运行的 **DeepSeek Harness（DSH）** agent。
类似 codexremote，但利用 DSH 自身的 Host/Client 架构：手机端拿到的是真实 DSH 界面
（实时会话、流式输出、工具审批、文件浏览），而不是一份简化的副本。

> 当前版本 **0.4.6**，功能概览：
> - 手机端：Android App（原生外壳 + WebView）+ 扫码配对 + 通知（审批/回合完成/错误）+
>   横竖屏/软键盘适配 + 断线横幅 + 手机端添加工作区 + 持久配对；
> - 电脑端：daemon 以**接管模式**直接操控桌面 DSH 宿主；设备配对鉴权、审计日志、
>   配对限速、公网配对窗口、设备令牌哈希/过期/数量上限、设备复用（同一手机重复配对
>   不占额外名额）；
> - 组网：**Tailscale 私有网络**（手机装 Tailscale，电脑/手机同账号）或**同一局域网**，
>   **不开 Funnel、不暴露公网端口**；daemon 只对 Tailscale / 局域网网段放行；
> - 安全：防火墙脚本仅放行 Tailscale / 局域网网段访问 7801；另有「受限令牌运行」方案见
>   [docs/security.md](docs/security.md)；
> - 文档：方案 [docs/design.md](docs/design.md)、组网 [docs/network.md](docs/network.md)、
>   测试 [docs/tester-guide.md](docs/tester-guide.md)、Android 构建 [android/README.md](android/README.md)。
>
> **下载**：[GitHub Releases](https://github.com/HMS-Victoria/dshremote/releases/latest)
> —— `dshremote-0.4.6-debug.apk`（手机端，debug 签名直接安装）、
> `dshremote-pc-0.4.6.zip`（电脑端：插件 + daemon + 工具脚本 + APK + 测试说明，解压即用）。
> 自行打包：`.\tools\package-pc.ps1`（输出到 `dist\`，不入库）。

## 原理

```
Android App（原生外壳 + WebView）
      │ HTTP/WS（Tailscale 私有网络 / 局域网）
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
- 查看 Tailscale 状态、切换开机自启、查看日志。

## 日常使用（当前方案：Tailscale 私有网络）

1. 电脑：Tailscale 已登录（服务自动启动），daemon 由计划任务 `dshremote-daemon`
   在登录后自动后台启动；也可手动 `.\tools\start.ps1 -Background`。
2. 手机：安装 Tailscale APK，登录**与电脑相同的账号**，开启 VPN（手机拿到 100.x 地址）；在家同一 Wi-Fi 也可以不走 Tailscale 直连（App 0.4.4+ 自动选择，见 docs/network.md）。
3. 手机 DSH Remote App：服务器地址填 `http://<电脑 Tailscale IP>:7801`，配对码填
   `.\tools\pair-info.ps1` 里的 6 位码，或 `.\tools\show-qr.ps1` 扫码。
4. 需要临时关闭远程入口时：手机断开 Tailscale 即可（没有公网端口暴露）。

> ⚠️ 手机上的 Tailscale 是 VPN 应用，与梯子互斥，用 DSH 时先关梯子。

## 常用命令

```powershell
.\tools\start.ps1 -Background   # 启动 daemon（后台）
.\tools\stop.ps1                # 停止 daemon
.\tools\pair-info.ps1           # 查看配对码、Tailscale/局域网地址、设备数
.\tools\show-qr.ps1             # 打开配对二维码页面
.\tools\devices.ps1             # 设备列表 / 吊销（-Revoke <id>）
.\tools\diag.ps1                # 诊断（WS 握手、客户端日志）
.\tools\pair-open.ps1           # 若配置了公网域名，临时开启公网配对窗口
```

## 目录

```
docs/design.md        完整设计方案
docs/network.md       组网方案（Tailscale 私有网络 / Funnel / frp 等）
docs/security.md      安全加固 & 普通权限运行
server/               daemon（Node ESM，零依赖）
server/mobile/        注入的移动端样式/脚本/PWA manifest
plugin/               DSH 宿主插件（接管模式）
android/              Android App
tools/                脚本（启动/配对/设备/诊断/打包/安全）
.data/                运行时数据（gitignore）
```

## 安全提示

DSH agent 能执行任意命令，**能访问 dshremote 就等价于能控制这台 PC**。
项目已内置：Tailscale 私有组网 / 局域网直连（无公网入口）、配对限速、一次性短时配对码、
设备令牌只存哈希、默认 10 年有效并自动续期（可在 `.data/config.json` 调整）、
最多 5 台设备（同一手机重复配重复用名额）、防火墙脚本仅放行 Tailscale / 局域网网段。
仍建议：DSH 以普通用户 / 受限令牌运行（见 [docs/security.md](docs/security.md)），
不要把配对码 / 设备令牌发给他人。





