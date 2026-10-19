# 安全加固与「以普通用户权限运行 DSH」

> 当前环境（2026-10-18 检查）已处理项：
> - Windows 防火墙已启用（此前三个配置文件全部关闭，是最大风险）；
> - `.data` 权限已收紧（去掉 `Authenticated Users` 继承）；
> - 公网配对窗口、配对限速、令牌哈希/30 天过期/5 台上限、审计日志已启用；
> - **待处理**：DSH 和 daemon 仍以 Administrator 运行 → 用本页的受限令牌方案解决。

## 一、为什么不能以 Administrator 运行

DSH 能执行命令、写文件；如果它（或手机令牌）被攻击，管理员权限意味着攻击者可以：
- 安装服务/驱动、改防火墙、读其他账户数据；
- 持久化控制整台电脑。

而 DSH 的日常工作（读写你的项目、跑命令、管理会话）**只需要普通用户权限**。

## 二、方案：受限令牌启动（管理员登录不变）

`runas /trustlevel:0x20000` 会用当前账户生成一个「Basic User」受限令牌：DSH/daemon
进程里没有管理员权限，但仍是你的用户身份，可以读写你的文件。

### 切换到受限模式

**从文件资源管理器双击**（不要在 DSH 的对话/终端里运行，因为会重启 DSH）：

```
D:\dshremote\tools\switch-to-restricted.cmd
```

脚本会：
1. 停止旧 daemon 和 DSH；
2. 以受限令牌启动 DSH，等待宿主就绪；
3. 以受限令牌隐藏启动 daemon（VBS + `runas /trustlevel`）；
4. 校验 `http://127.0.0.1:7801/__dshremote/health`，输出 `.data\restricted-privs.txt`。

### 验证

```powershell
Get-Content D:\dshremote\.data\restricted-privs.txt
```

受限身份下权限非常少（实测只有 `SeChangeNotifyPrivilege`），没有
`SeDebugPrivilege`、`SeTakeOwnershipPrivilege` 等管理员权限。

### 回退

```
D:\dshremote\tools\switch-to-normal.cmd
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
C:\Program Files\Tailscale\tailscale.exe funnel 7801        # 开启
C:\Program Files\Tailscale\tailscale.exe funnel --https=443 off   # 关闭
```

配对新设备前仍然要先运行 `.\tools\pair-open.ps1`。

## 四、剩余风险（即使切到受限令牌）

- **个人文件仍可被 DSH 读写**：受限令牌只是去掉管理员权限，不隔离你的文件；
  若要做到连个人文件隔离，需要给 DSH 单独建标准用户并只授权工作区目录；
- 手机令牌泄漏：手机丢失请立刻 `.\tools\devices.ps1 -Revoke <id>`；
- DSH 的「完全权限」预设会自动批准工具调用：不要让 Agent 处理不可信的网页/文件内容；
- Tailscale 账号建议开启 2FA；`*.ts.net` 地址不要外传。

## 五、开机自启（当前已配置）

- **Tailscale**：Windows 服务自动启动（登录状态已保存），重启后无需手动操作；
- **dshremote daemon**：计划任务 `dshremote-daemon`（登录后延迟 20 秒、受限权限后台启动），
  查看/修改：`Get-ScheduledTask -TaskName dshremote-daemon`；
- 登录 DSH 桌面版后 daemon 会自动以接管模式接入（`.\tools\pair-info.ps1` 可确认）。

## 六、手机端后台保活（防被杀）

华为/荣耀等系统会清理后台应用，导致通知/连接中断。App 0.4.5+ 已内置：

- 保活闹钟：服务被杀后 15 分钟内自动尝试拉起（从最近任务划掉后 3 秒先试一次）；
- 开机自启：重启手机后自动恢复事件服务；
- 网络切换（Wi-Fi/4G）：自动立即重连；
- App 内「返回键 → 后台保活」：一键忽略电池优化、跳转华为「启动管理」页面。

**仍需手动设置一次（系统限制，App 无法自动改）：**
1. 设置 → 电池 → 应用启动管理 → DSH Remote → 改为「手动管理」，允许自启动/关联启动/后台活动；
2. 设置 → 电池 → 更多电池设置 → 开启「休眠时始终保持网络连接」。

