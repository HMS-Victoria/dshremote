import os from 'node:os';

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
