package dev.dshremote.app

import android.content.Context

/** 本地保存的服务器地址与设备令牌。 */
class SessionStore(context: Context) {
    private val prefs = context.getSharedPreferences("dshremote", Context.MODE_PRIVATE)

    val serverUrl: String? get() = prefs.getString("server_url", null)
    val deviceToken: String? get() = prefs.getString("device_token", null)
    val lastPairCode: String get() = prefs.getString("pair_code", "") ?: ""
    val lastServerUrl: String get() = prefs.getString("last_server_url", "") ?: ""

    val paired: Boolean get() = !serverUrl.isNullOrEmpty() && !deviceToken.isNullOrEmpty()

    fun save(serverUrl: String, token: String) {
        prefs.edit()
            .putString("server_url", serverUrl)
            .putString("last_server_url", serverUrl)
            .putString("device_token", token)
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
