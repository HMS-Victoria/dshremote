package dev.dshremote.app

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

data class PairResult(val token: String, val deviceId: String?)

class PairingClient {
    /**
     * 调用 daemon 的 POST /__dshremote/pair 换取设备令牌。
     * 会阻塞当前线程，调用方需放到 IO 线程。
     */
    fun pair(
        serverUrl: String,
        code: String,
        deviceName: String = "Android",
        deviceId: String? = null,
    ): PairResult {
        val base = normalizeBaseUrl(serverUrl)
        val connection = (URL("$base/__dshremote/pair").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = 10_000
            readTimeout = 15_000
            doOutput = true
            setRequestProperty("Content-Type", "application/json; charset=utf-8")
            setRequestProperty("Accept", "application/json")
        }
        try {
            val payload = JSONObject()
                .put("code", code.trim())
                .put("deviceName", deviceName)
                .apply {
                    // 稳定设备 ID：同一台手机重复配对时复用原设备记录，不占用额外名额
                    if (!deviceId.isNullOrBlank()) put("deviceId", deviceId)
                }
                .toString()
            connection.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }

            val status = connection.responseCode
            val body = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
                .orEmpty()

            if (status !in 200..299) {
                val message = runCatching { JSONObject(body).optString("error") }.getOrNull()
                throw IOException(
                    when {
                        status == 403 -> "配对码不正确或已过期"
                        status == 429 -> "尝试次数过多，请稍后再试"
                        !message.isNullOrBlank() -> "配对失败：$message"
                        else -> "配对失败（HTTP $status）"
                    },
                )
            }

            val json = JSONObject(body)
            if (!json.optBoolean("ok", false)) {
                throw IOException("配对失败：" + json.optString("error", "未知错误"))
            }
            val token = json.optString("token")
            if (token.isBlank()) throw IOException("配对失败：服务器未返回令牌")
            val deviceId = json.optJSONObject("device")?.optString("id")
            return PairResult(token, deviceId)
        } finally {
            connection.disconnect()
        }
    }

    companion object {
        /** 补全协议、去掉尾部斜杠，并校验是 http(s) URL。 */
        fun normalizeBaseUrl(input: String): String {
            var value = input.trim()
            if (value.isEmpty()) throw IOException("请填写服务器地址")
            if (!value.startsWith("http://") && !value.startsWith("https://")) {
                value = "http://$value"
            }
            value = value.trimEnd('/')
            val url = URL(value)
            if (url.host.isNullOrBlank()) throw IOException("服务器地址不合法")
            return value
        }
    }
}
