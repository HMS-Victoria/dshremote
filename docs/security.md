# 安全加固与「以普通用户权限运行 DSH」

> 本项目已内置的安全措施：
> - 公网配对窗口、配对限速、令牌哈希 / 过期时间 / 设备数量上限、审计日志；
> - 建议同时启用 Windows 防火墙，并收紧 `.data` 目录权限（去掉 `Authenticated Users` 继承）；
> - **建议**：DSH 和 daemon 不要以 Administrator 运行 → 用本页的受限令牌方案解决。

## 一、为什么不能以 Administrator 运行

DSH 能执行命令、写文件；如果它（或手机令牌）被攻击，管理员权限意味着攻击者可以：
- 安装服务/驱动、改防火墙、读其他账户数据；
- 持久化控制整台电脑。

而 DSH 的日常工作（读写你的项目、跑命令、管理会话）**只需要普通用户权限**。

## 二、方案：受限令牌启动（管理员登录不变）

`runas /trustlevel:0x20000` 会用当前账户生成一个「Basic User」受限令牌：DSH/daemon
进程里没有管理员权限，但仍是你的用户身份，可以读写你的文件。

### 切换到受限模式

**在项目根目录打开文件资源管理器，双击**（不要在 DSH 的对话/终端里运行，因为会重启 DSH）：

```
tools\switch-to-restricted.cmd
```

脚本会：
1. 停止旧 daemon 和 DSH；
2. 以受限令牌启动 DSH，等待宿主就绪；
3. 以受限令牌隐藏启动 daemon（VBS + `runas /trustlevel`）；
4. 校验 `http://127.0.0.1:7801/__dshremote/health`，输出 `.data\restricted-privs.txt`。

### 验证

```powershell
Get-Content .\.data\restricted-privs.txt
```

受限身份下权限非常少（实测只有 `SeChangeNotifyPrivilege`），没有
`SeDebugPrivilege`、`SeTakeOwnershipPrivilege` 等管理员权限。

### 回退

```
tools\switch-to-normal.cmd
```

或手动：`.\tools\stop.ps1` → 正常打开 DSH → `.\tools\start.ps1 -Background`

### 受限模式的限制

| 操作 | 受限令牌 |
|---|---|
| 读写项目/工作区/DSH 数据 | ✅ |
| DSH 执行命令、改文件、构建 | ✅ 正常 |
| 改系统设置/防火墙/服务/注册表 HKLM、装驱动 | ❌ |
| 提权（UAC） | ❌ |
| 手机远程/通知/接管模式 | ✅ 不受影响 |
| Tailscale Funnel（系统服务） | ✅ 不受影响 |

如果 DSH 某些功能报权限错误，请记录（哪个功能、什么报错），可以针对性放宽或回退普通模式。

## 三、外网入口

受限模式不影响公网方案。需要时：

```powershell
tailscale funnel 7801        # 开启
tailscale funnel --https=443 off   # 关闭
```

配对新设备前仍然要先运行 `.\tools\pair-open.ps1`。

## 四、剩余风险（即使切到受限令牌）

- **个人文件仍可被 DSH 读写**：受限令牌只是去掉管理员权限，不隔离你的文件；
  若要做到连个人文件隔离，需要给 DSH 单独建标准用户并只授权工作区目录；
- 手机令牌泄漏：手机丢失请立刻 `.\tools\devices.ps1 -Revoke <id>`；
- DSH 的「完全权限」预设会自动批准工具调用：不要让 Agent 处理不可信的网页/文件内容；
- Tailscale 账号建议开启 2FA；`*.ts.net` 地址不要外传。

## 五、开机自启（可选）

- **Tailscale**：Windows 服务自动启动（登录状态已保存）；
- **dshremote daemon**：可用 `.\tools\install-autostart.ps1` 注册计划任务 `dshremote-daemon`
  （登录后延迟启动），查看/修改：`Get-ScheduledTask -TaskName dshremote-daemon`；
- 登录 DSH 桌面版后 daemon 会自动以接管模式接入（`.\tools\pair-info.ps1` 可确认）。

## 七、配对持久化（0.4.6+）

- 设备令牌默认有效期 **10 年**（`.data/config.json` 的 `pairing.deviceTtlMs` 可调整）；
- App 的「修改地址」只换地址、**保留配对令牌**；同一台电脑的局域网 / Tailscale 地址可随意切换；
- 页面加载失败会自动重试；只有服务器返回 401（令牌过期/被吊销）才提示重新配对；
- 只有点「重新配对」才会清除令牌。

