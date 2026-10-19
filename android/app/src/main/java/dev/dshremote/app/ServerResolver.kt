package dev.dshremote.app

import android.content.Context
import android.net.Uri
import java.net.HttpURLConnection
import java.net.URL

/**
 * 服务器地址自动选择：配对时 daemon 会返回它的所有可达地址
 * （局域网、Tailscale 等），这里按顺序探测，返回当前网络下可用的那个。
 *
 * 这样同一台手机在家用局域网、出门用 Tailscale，不需要手动切换服务器。
 */
object ServerResolver {
    /** 候选地址：保存的主地址 + 配对时从服务器拿到的地址（局域网优先）。 */
    fun candidates(context: Context): List<String> {
        val store = SessionStore(context)
        val list = mutableListOf<String>()
        store.serverUrl?.let { list.add(it) }
        list.addAll(store.serverCandidates)
        val normalized = list.map { it.trim().trimEnd('/') }
            .filter { it.isNotEmpty() }
            .distinct()
        // 局域网优先、Tailscale 次之：同一网络下避免绕行中继（在家走 Wi-Fi 更快）
        return normalized.sortedBy { score(it) }
    }

    /** 地址优先级：局域网 0、Tailscale 1、其它 2。 */
    private fun score(url: String): Int {
        val host = runCatching { Uri.parse(url).host }.getOrNull() ?: return 2
        return when {
            host.startsWith("192.168.") || host.startsWith("10.") ||
                host.startsWith("172.") || host.startsWith("169.254.") -> 0
            host.startsWith("100.") -> 1
            else -> 2
        }
    }

    /** 探测单个地址是否可用（GET /__dshremote/health，短超时）。 */
    fun probe(url: String, timeoutMs: Int = 1500): Boolean {
        return runCatching {
            val connection = (URL("$url/__dshremote/health").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = timeoutMs
                readTimeout = timeoutMs
                useCaches = false
            }
            try {
                connection.responseCode in 200..299
            } finally {
                connection.disconnect()
            }
        }.getOrDefault(false)
    }

    /** 返回第一个可达的服务器地址；都不可达时返回保存的主地址（让界面显示连接失败）。 */
    fun resolve(context: Context): String {
        val list = candidates(context)
        if (list.isEmpty()) return ""
        for (url in list) {
            if (probe(url)) return url
        }
        return list.first()
    }
}
