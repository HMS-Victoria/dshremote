# DSH Remote 电脑端测试说明

这是一个**测试版**：用手机远程控制电脑上正在运行的 DeepSeek Harness（DSH）桌面版。
电脑端由两部分组成：

- **dsh-remote-host 插件**：装进 DSH 桌面版，让手机能接管桌面正在用的那个 Host；
- **dshremote daemon**：一个小服务（Node.js），手机通过它连接电脑，默认端口 `7801`。

手机端需要安装 `dist\dshremote-0.4.5-debug.apk`（本压缩包里已附带，版本信息见 `VERSION.txt`）。
如果解压后没有 `dist` 目录，说明这个包没有附带 APK，请向开发者索取。

---

## 一、环境要求

1. Windows 10/11；
2. **DSH 桌面版已安装**，并且能正常打开、能正常对话（DSH 会自动创建 `%USERPROFILE%\.dsh` 配置）；
3. **Node.js 22 或更高版本**（命令行执行 `node -v` 确认；没有的话到 https://nodejs.org 安装 LTS 版）；
4. 手机和电脑在**同一个 Tailscale/虚拟私有网络**（推荐，无公网端口）或同一局域网；
5. 解压到一个**简单路径**（建议 `D:\dshremote-pc`，路径里不要有空格/特殊字符）。

> 首次启动 daemon 时 Windows 防火墙可能弹窗，请选择「允许访问」（专用网络）。

---

## 二、安装步骤

在解压出来的目录（下面叫「项目目录」）里打开 PowerShell，按顺序执行：

```powershell
cd D:\dshremote-pc
Set-ExecutionPolicy -Scope Process Bypass -Force

# 1. 安装 DSH 插件（自动查找 DSH 安装目录；找不到时加 -DshDir "<DSH安装目录>"）
.\tools\install-remote-host-plugin.ps1

# 2. 完全退出 DSH 桌面版（托盘图标也要退出），然后重新打开，等它正常进入界面

# 3. 启动 dshremote daemon（后台运行）
.\tools\start.ps1 -Background

# 4. 查看状态与配对码
.\tools\pair-info.ps1

# 5. 打开电脑上的配对二维码页面（用手机 App 扫码）
.\tools\show-qr.ps1
```

手机端：安装 `dist\dshremote-0.4.5-debug.apk` → 打开 App → **扫码配对**（或手动输入配对码）。

> 如果第 1 步报「找不到 DSH 安装目录」，请找到 `DeepSeek Harness.exe` 所在目录，用：
> `.\tools\install-remote-host-plugin.ps1 -DshDir "C:\Program Files\DeepSeek Harness"`
>
> 如果 `pair-info.ps1` 显示「自启模式」而不是「接管模式」，说明插件没加载成功：
> 确认 DSH 已完全重启，再运行一次 `.\tools\pair-info.ps1` 看宿主模式。

---

## 三、测试清单（重点）

请在测试时留意这些点，通过/失败都可以记下来：

- [ ] 手机打开后能看到电脑上 DSH 的会话列表；
- [ ] 打开**桌面正在使用**的会话，发一条消息能正常回复（不报 writer-held 错误）；
- [ ] 手机上能实时看到回复内容 / 工具调用过程；
- [ ] 审批弹窗、通知栏能收到「需要审批」「回合完成」通知，点通知能打开对应会话；
- [ ] 打开左侧抽屉，底部连接状态行显示绿色「已连接」；
- [ ] 把电脑上的 daemon 停掉（`.\tools\stop.ps1`），手机出现红色断线横幅 / 状态行变红；重新 `.\tools\start.ps1 -Background` 后能自动恢复；
- [ ] 手机横屏/竖屏来回切换，界面布局正常（抽屉、输入框不出错）；
- [ ] 点手机输入框弹出键盘时，输入框仍然可见、能正常输入；
- [ ] 返回键 / 长按左上角按钮能打开「连接」菜单，菜单里的两个通知开关可以关闭/打开；
- [ ] 扫码配对、相册选二维码配对都能用。

---

## 四、遇到问题时请提供

1. 手机截图 / 录屏（说明是哪一步）；
2. 电脑上执行 `.\tools\pair-info.ps1` 的输出（截图或文本）；
3. daemon 日志：项目目录下 `.data\daemon.log`（如果没用 `-Background` 就是命令行窗口里的输出）；
4. daemon 运行中时执行 `.\tools\diag.ps1` 的输出；
5. 手机型号 / Android 版本，以及 DSH 桌面版版本号。

> 注意：`.data` 目录里有设备令牌和配对信息，发日志前可以只发 `daemon.log` 和 `diag.ps1` 输出，
> 不要把 `.data\devices.json` 或配对码发给无关的人。

---

## 五、停止与卸载

```powershell
# 停止 daemon
.\tools\stop.ps1

# 卸载 DSH 插件（然后重启 DSH 桌面版）
.\tools\uninstall-remote-host-plugin.ps1
```

卸载后 DSH 桌面版恢复原样，手机端不再能通过插件接管桌面 Host。

---

## 六、说明

- 这是开发中的测试版，功能可能不完整、可能崩溃，请勿用于重要数据；
- 只建议在局域网或 Tailscale 等私有网络内测试，**不要**把 7801 端口直接暴露到公网；
- 配对码是一次性的，配对成功后会自动换新码，不要截图外传。


