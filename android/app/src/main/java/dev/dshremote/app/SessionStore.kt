package dev.dshremote.app

import android.content.Context

/** 本地保存的服务器地址与设备令牌。 */
class SessionStore(context: Context) {
    private val prefs = context.getSharedPreferences("dshremote", Context.MODE_PRIVATE)

    val serverUrl: String? get() = prefs.getString("server_url", null)
    val deviceToken: String? get() = prefs.getString("device_token", null)
    val lastPairCode: String get() = prefs.getString("pair_code", "") ?: ""
    val lastServerUrl: String get() = prefs.getString("last_server_url", "") ?: ""

    /** 配对时 daemon 返回的其它可用地址（局域网/Tailscale 等，换行分隔）。 */
    val serverCandidates: List<String>
        get() = (prefs.getString("server_candidates", "") ?: "")
            .split('\n')
            .map { it.trim().trimEnd('/') }
            .filter { it.isNotEmpty() }

    val paired: Boolean get() = !serverUrl.isNullOrEmpty() && !deviceToken.isNullOrEmpty()

    /** 最近一次已通知的事件时间（ISO 字符串），用于服务重连后去重。 */
    var lastEventAt: String
        get() = prefs.getString("last_event_at", "") ?: ""
        set(value) {
            prefs.edit().putString("last_event_at", value).apply()
        }

    /** 是否已经展示过“返回键/长按可打开连接菜单”的新手提示。 */
    var connMenuHintShown: Boolean
        get() = prefs.getBoolean("conn_menu_hint_shown", false)
        set(value) {
            prefs.edit().putBoolean("conn_menu_hint_shown", value).apply()
        }

    /** 通知开关：审批/错误提醒。 */
    var notifyApproval: Boolean
        get() = prefs.getBoolean("notify_approval", true)
        set(value) {
            prefs.edit().putBoolean("notify_approval", value).apply()
        }

    /** 通知开关：回合完成提醒。 */
    var notifyTurns: Boolean
        get() = prefs.getBoolean("notify_turns", true)
        set(value) {
            prefs.edit().putBoolean("notify_turns", value).apply()
        }

    fun save(serverUrl: String, token: String, candidates: List<String> = emptyList()) {
        val normalized = (listOf(serverUrl) + candidates)
            .map { it.trim().trimEnd('/') }
            .filter { it.isNotEmpty() }
            .distinct()
        prefs.edit()
            .putString("server_url", serverUrl)
            .putString("last_server_url", serverUrl)
            .putString("device_token", token)
            .putString("server_candidates", normalized.joinToString("\n"))
            .apply()
    }

    fun saveLastInputs(serverUrl: String, code: String) {
        prefs.edit()
            .putString("last_server_url", serverUrl)
            .putString("pair_code", code)
            .apply()
    }

    fun clear() {
        prefs.edit()
            .remove("server_url")
            .remove("device_token")
            .apply()
    }
}
