# 外网访问（Tailscale / publicUrl）

## 原理

daemon 监听 `0.0.0.0:7801`，手机只要**能访问到这个端口**就行。二维码 / 配对页里的地址
优先顺序：

1. 配置的 `publicUrl`（frp / 域名 / Cloudflare 等）；
2. 自动检测到的 **Tailscale 地址**（`100.64.0.0/10`）；
3. 局域网地址（原来的行为）。

配置 `publicUrl` 或检测到 Tailscale 后，`.\tools\show-qr.ps1` 打开的二维码就是外网地址，
手机扫码配对后自动走外网，App 端不需要任何改动。

---

## 方案 A：Tailscale（推荐，0 成本，自己用）

Tailscale 是 WireGuard 组网工具：电脑和手机都登录同一账号后，双方会分配
`100.x.x.x` 地址，能互相直连（打洞失败时走中继）。流量由 WireGuard 端到端加密，
所以**不需要额外配 HTTPS**。

### 电脑端

1. 安装 Tailscale：<https://tailscale.com/download/windows>
2. 打开 Tailscale，登录账号，确认状态是 Connected；
3. 查看本机 Tailscale IP（托盘 → 本机 IP，或命令行 `tailscale ip -4`，形如 `100.101.102.103`）；
4. **放行防火墙**（Windows 常把 Tailscale 网卡识别为“公用网络”）：
   以管理员身份打开 PowerShell，执行
   ```powershell
   .\tools\firewall-allow.ps1
   ```
5. 重启 dshremote daemon：
   ```powershell
   .\tools\stop.ps1
   .\tools\start.ps1 -Background
   .\tools\pair-info.ps1
   ```
   控制台会多出一行 `Tailscale: http://100.x.x.x:7801/pair?code=...`，
   `pair-info` 也会显示外网地址。

### 手机端

1. 安装 Tailscale（应用商店搜 “Tailscale”，或官网 APK），登录**同一个账号**；
2. 打开 Tailscale 开关（会请求 VPN 权限，允许）；
3. 手机 App 里按返回键 →「刷新页面」，或者重新扫码配对；
4. 之后无论在家还是外网，手机都能连到电脑。

> ⚠️ Tailscale 在 Android 上是一个 VPN 应用，而系统同一时间只允许一个 VPN：
> 用 DSH 的时候要**关掉梯子、开 Tailscale**；用完再切回梯子。

### 常见问题

- **手机连不上**：电脑上 `ping 100.x.x.x` 是否通；Windows 防火墙是否放行了 7801
  （`.\tools\firewall-allow.ps1`）；Tailscale 两端是否都是 Connected。
- **二维码还是局域网地址**：daemon 要在 Tailscale 启动**之后**重启才能检测到 100.x 网卡。
- **速度慢**：Tailscale 打洞失败时会走 DERP 中继，速度受中继影响；网络好的时候一般能直连。

---

## 方案 B：publicUrl（frp / 域名 / Cloudflare Tunnel）

已有公网地址（例如 frp 映射到 `https://dsh.example.com`）时，不需要改代码：

```jsonc
// .data/config.json
{
  "publicUrl": "https://dsh.example.com"
}
```

或者启动前设置环境变量：

```powershell
$env:DSHREMOTE_PUBLIC_URL = "https://dsh.example.com"
.\tools\start.ps1
```

二维码/配对页会自动使用这个地址。HTTPS 隧道也支持（页面里的 API/WebSocket 都是
相对路径，会走同一个域名）。

### 安全提醒

- 不管用哪种方案，都不要把 7801 端口**明文**暴露到公网；走隧道/组网，
  或者至少前面套一层 HTTPS；
- 设备访问需要配对令牌（一次性配对码 + 长期设备令牌），
  丢手机可以用 `.\tools\devices.ps1 -Revoke <id>` 立刻吊销；
- 公网暴露时建议只允许隧道来源、并定期检查 `.data/audit.log`。
