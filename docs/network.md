# 组网方案（WireGuard + 局域网）

> 推荐采用 **WireGuard 点对点**：电脑作为服务端（10.9.0.1），手机作为客户端（10.9.0.2），
> 公网只暴露一个 **UDP 51820**（加密），daemon 的 7801 端口不对公网开放。

## 一、电脑端配置

- WireGuard 隧道配置：`.data\wireguard\server.conf`（含服务端私钥，注意保管）；
- Windows 服务：`WireGuardTunnel$server`（自动启动），接口 `server` = `10.9.0.1/24`；
- 路由器端口转发：**UDP 51820 → 192.168.1.10:51820**；
- 防火墙：仅放行 UDP 51820 入站；7801 只允许 WireGuard 网段（10.9.0.0/24）、
  局域网和本机访问；
- daemon 的 `publicUrl` = `http://10.9.0.1:7801`（二维码/配对信息用这个地址）。

查看状态：

```powershell
Get-Service 'WireGuardTunnel$server'
& 'C:\Program Files\WireGuard\wg.exe' show
```

## 二、手机端

1. 安装 WireGuard Android APK（电脑端安装包内已附带 `wireguard-android.apk`，也可从 <https://www.wireguard.com/install/> 下载）；
2. 打开 App → **+** → **扫描二维码 / 导入配置**；
3. 连接（会占用 VPN 槽，**使用前先关掉梯子**；与其它 VPN 互斥）；
4. 手机地址变为 `10.9.0.2`；
5. 打开 DSH Remote → 返回键 →「修改地址」→ `http://10.9.0.1:7801`（保留配对，不用重配）。

> 建议手机配置导入后删除电脑上的手机私钥文件（`phone.conf` / `phone-qr.png`），减少泄露面；
> 以后重装手机需要重新生成配置（改 `server.conf` 的 peer 密钥后重新出码）。

## 三、局域网直连（可选）

与电脑处于同一局域网时，可以不经过 WireGuard：

- 管理面板里「局域网直连」开关（需要管理员权限）；
- App 会自动在可用地址间选择（局域网优先、WireGuard 次之）。

## 四、常见问题

- **连不上 WireGuard**：检查路由器 UDP 51820 转发是否还在、电脑服务是否运行、
  手机所在网络是否封 UDP（可切换 Wi-Fi / 流量试试）。
- **公网 IP 变了**：公网 IP 可能变化，需要把手机配置里的 `Endpoint`
  更新为新 IP（或路由器开 DDNS 用域名）。
- **手机丢了**：立刻在路由器删掉 UDP 51820 转发 → 管理面板吊销设备 →
  删除 WireGuard 里的手机 peer 并重建配置。
- **想临时关闭远程入口**：手机断开 WireGuard 即可（公网 51820 无人能连，仍需密钥）。

## 五、安全要点

- 公网只开 UDP 51820，没有 HTTP 端口暴露；
- WireGuard 配置 / 二维码包含私钥，不要发给别人，手机相册里的截图用完可删；
- 手机与梯子互斥，用完 DSH 再切回梯子。
