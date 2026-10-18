import os from 'node:os';

/** 判断是否 Tailscale 的 CGNAT 地址段（100.64.0.0/10）。 */
export function isTailscaleAddress(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

/** 局域网候选地址：排除回环、链路本地和明显虚拟网卡。 */
export function lanAddresses() {
  const result = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      if (/vEthernet|vmware|virtualbox|hyper-v|loopback/iu.test(name)) continue;
      result.push({ name, address: info.address });
    }
  }
  // 物理 Wi-Fi / 以太网优先
  result.sort((a, b) => score(a) - score(b));
  return result;
}

function score(entry) {
  let value = 100;
  if (/wi-?fi|wlan|wireless/iu.test(entry.name)) value -= 40;
  if (/以太网|ethernet/iu.test(entry.name)) value -= 20;
  if (/tailscale|zerotier|radmin|clash|vpn/iu.test(entry.name)) value += 30;
  return value;
}

/** 生成 http://ip:port 列表，首选地址在最前。 */
export function lanUrls(port) {
  return lanAddresses().map((entry) => ({
    ...entry,
    url: `http://${entry.address}:${port}`,
  }));
}

/**
 * Tailscale 组网地址（100.64.0.0/10）。
 * 手机/电脑都装了 Tailscale 时，这个地址在局域网和外网都能访问，
 * 适合作为二维码里的首选地址（隧道本身已加密，不需要 HTTPS）。
 */
export function tailscaleUrls(port) {
  const result = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (!isTailscaleAddress(info.address) && !/tailscale/iu.test(name)) continue;
      result.push({ name: name || 'Tailscale', address: info.address, url: `http://${info.address}:${port}` });
    }
  }
  return result;
}
