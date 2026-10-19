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
---

## 方案 C：Tailscale Funnel（电脑装 Tailscale，手机零安装）

如果手机装不了 Tailscale，但电脑上能装，可以用 Funnel 把本机端口直接发布成公网 HTTPS：

1. 电脑登录 Tailscale（托盘图标 → Log in）；
2. 打开 Tailscale 后台 <https://login.tailscale.com/admin>：
   - 在 **DNS** 里启用 HTTPS 证书（HTTPS Certificates）；
   - 在 **Access Controls** 里给节点开放 funnel 权限（nodeAttrs 加 `funnel`；或按后台提示一键启用）；
3. 在电脑上执行（`tailscale` 命令；Windows 默认安装路径为 `C:\Program Files\Tailscale\tailscale.exe`）：
   ```powershell
   tailscale funnel 7801
   ```
   成功后会得到形如 `https://你的电脑名.你的tailnet.ts.net/` 的地址（只对 7801 端口的本地服务生效）；
4. 把这个地址填进 dshremote：
   ```powershell
   .\tools\set-public-url.ps1 -Url "https://你的电脑名.你的tailnet.ts.net" -Restart
   ```
5. 手机 App 重新扫码或刷新页面即可，**手机不需要装任何 VPN/App**。

注意：Funnel 要求电脑上的 Tailscale 保持在线；如果 Clash TUN 导致 Tailscale 连不上，
参考上面的 Clash 配置（把 Tailscale/`*.tailscale.com` 设为直连）。

## 方案 D：免费内网穿透（SakuraFrp / 花生壳等）

手机同样零安装，国内可用性通常不错，但需要注册并安装对应客户端：

1. 注册 SakuraFrp 等免费穿透服务，创建一个指向 `127.0.0.1:7801` 的 TCP/HTTP 隧道；
2. 拿到公网地址（如 `https://xxxx.natfrp.cloud`）；
3. 执行：
   ```powershell
   .\tools\set-public-url.ps1 -Url "https://xxxx.natfrp.cloud" -Restart
   ```
4. 手机扫码即可。

> 若穿透服务只给「IP:端口」，也可以直接填：`.\tools\set-public-url.ps1 -Url "http://1.2.3.4:12345"`。
---

## 公网暴露的安全配置（已内置）

把 daemon 通过 Funnel/隧道发布到公网后，以下保护默认生效：

- **公网配对窗口**：通过 `publicUrl` 域名访问 `/pair` 或配对接口时，默认**一律返回 403**。
  需要给新设备配对时，在电脑上运行：
  ```powershell
  .\tools\pair-open.ps1          # 打开 5 分钟公网配对窗口并显示二维码
  ```
  窗口结束或配对成功后自动关闭。局域网/本机访问不受此限制。
- **配对码**：默认一次性、**10 分钟过期**，配对成功立即轮换；
- **限速**：配对尝试每 IP 5 次/分钟、全局 10 次/分钟，超限 429；失败/被拒会写审计日志；
- **设备令牌**：服务端只存 **sha256 哈希**；令牌默认 **30 天过期**；最多 **5 台设备**；
- **Cookie**：公网 https 域名下自动加 `Secure`；
- **审计**：配对、吊销、过期、公网配对被拒、限速触发都写入 `.data/audit.log`；
- `/__dshremote/health` 对公网只返回 `{"ok":true}`，不暴露上游/进程信息。

### 日常使用建议

1. 不需要远程访问时，关掉公网入口：`tailscale funnel --https=443 off`；
2. 需要时才开 Funnel，用完关掉；
3. 给别人测试/临时配对时，配对完立刻确认设备列表：`.\tools\devices.ps1`；
4. 手机丢了立刻吊销：`.\tools\devices.ps1 -Revoke <id>`；
5. 长期建议：DSH/daemon 不要用 Administrator 账户运行（管理员权限过高，见 [security.md](security.md)）。

---


---

## 推荐方案：Tailscale 私有网络（不开 Funnel）

> 不使用 EasyTier（官方公共中继域名失效）和 Funnel（公网入口）；
> 手机与电脑登录同一个 Tailscale 账号组成私有网络，手机通过 100.x 地址访问 daemon。

### 手机端步骤

1. 安装 Tailscale Android APK（<https://pkgs.tailscale.com/stable/#android>）；
2. 登录与电脑相同的 Tailscale 账号（电脑托盘里显示的账号）；
3. 开启 VPN，确认手机拿到 `100.x` 地址；
4. DSH Remote App → 切换服务器 → `http://<电脑 Tailscale IP>:7801` → 扫码配对
   （私有网地址，无需公网配对窗口）；
5. ⚠️ 手机 Tailscale 与梯子互斥，用 DSH 时先关梯子。

### 电脑端检查

- Tailscale Windows 客户端已安装并登录（服务自动启动），IP 形如 `100.x.y.z`；
- Funnel 未开启：`tailscale funnel status` 应为 `No serve config`；
- daemon `publicUrl` = `http://<电脑 Tailscale IP>:7801`，二维码/配对直接用这个地址；
- 防火墙只放行 Tailscale 网段（`100.64.0.0/10`）访问 7801；
- Clash TUN 的 fake-IP 会破坏 Tailscale 控制面连接，可用 hosts 指向真实 IP 解决；
  Tailscale 登录异常时先检查 hosts 里那几行。

### EasyTier 为什么弃用

官方免费共享节点域名 `public.easytier.cn` 已返回 NXDOMAIN（2026-10-18 实测），
`config-server.easytier.cn` 连接也超时；没有公共中继就无法跨 NAT 组网（除非自建中继）。
相关文件、防火墙规则和配置已清理。


---

## 局域网访问（与 Tailscale 并存）

> 2026-10-18 起：同一局域网（Wi-Fi）也能直接连，不再只限 Tailscale。

- 防火墙规则 `dshremote LAN TCP 7801`：只允许**本地子网**（LocalSubnet）访问 7801，
  公网/其他网段仍然被拒；管理面板里有「局域网直连：已允许」开关（需要管理员权限）；
- 手机 App **0.4.4+**：配对时 daemon 会返回所有可用地址（局域网 + Tailscale），
  App 自动探测当前网络下可用的那个——在家用 Wi-Fi 走局域网，出门走 Tailscale，
  不需要手动切换服务器；
- 旧版 App：需要切换服务器地址时，手动改成 `http://<电脑局域网IP>:7801`（重新配对会自动复用设备名额）。

