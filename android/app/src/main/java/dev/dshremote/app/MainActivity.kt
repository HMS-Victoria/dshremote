package dev.dshremote.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import android.os.Bundle
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat
import dev.dshremote.app.ui.DshRemoteTheme
import dev.dshremote.app.ui.PairScreen
import dev.dshremote.app.ui.ScannerScreen
import dev.dshremote.app.ui.WebViewScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    /** 通知点击带过来的会话 id（打开对应会话用）。 */
    private val pendingSessionId = mutableStateOf<String?>(null)

    private val requestNotifications = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { _: Boolean -> ensureEventService() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 允许通过 chrome://inspect / CDP 调试 WebView（仅对调试用途有价值）
        WebView.setWebContentsDebuggingEnabled(true)
        val store = SessionStore(this)
        pendingSessionId.value = intent?.getStringExtra(EventService.EXTRA_OPEN_SESSION)
        requestNotificationsIfNeeded()
        ensureEventService()

        setContent {
            DshRemoteTheme {
                var paired by remember { mutableStateOf(store.paired) }
                var error by remember { mutableStateOf<String?>(null) }
                var busy by remember { mutableStateOf(false) }
                var scannerOpen by remember { mutableStateOf(false) }
                var scannedUrl by remember { mutableStateOf<String?>(null) }
                var showConnHint by remember {
                    mutableStateOf(store.paired && !store.connMenuHintShown)
                }
                val scope = rememberCoroutineScope()

                Box(modifier = Modifier.fillMaxSize()) {
                    if (paired) {
                        WebViewScreen(
                            serverUrl = store.serverUrl.orEmpty(),
                            token = store.deviceToken.orEmpty(),
                            pendingSessionId = pendingSessionId.value,
                            onSessionOpened = { pendingSessionId.value = null },
                            onSwitchServer = {
                                store.clear()
                                EventService.stop(this@MainActivity)
                                paired = false
                                error = null
                            },
                        )
                    } else {
                        PairScreen(
                            initialServerUrl = store.lastServerUrl.ifBlank { "http://192.168.1.10:7801" },
                            initialCode = store.lastPairCode,
                            error = error,
                            busy = busy,
                            scannedUrl = scannedUrl,
                            onScannedConsumed = { scannedUrl = null },
                            onScan = { scannerOpen = true },
                            onConnect = { rawServer, code ->
                                error = null
                                busy = true
                                scope.launch {
                                    try {
                                        val server = PairingClient.normalizeBaseUrl(rawServer)
                                        val result = withContext(Dispatchers.IO) {
                                            val deviceName = Build.MODEL ?: "Android"
                                            val deviceId = Settings.Secure.getString(
                                                contentResolver,
                                                Settings.Secure.ANDROID_ID,
                                            )
                                            PairingClient().pair(server, code, deviceName, deviceId)
                                        }
                                        store.save(server, result.token)
                                        store.saveLastInputs(server, code)
                                        paired = true
                                        ensureEventService()
                                    } catch (throwable: Throwable) {
                                        error = throwable.message ?: "配对失败"
                                    } finally {
                                        busy = false
                                    }
                                }
                            },
                        )
                    }

                    if (scannerOpen) {
                        ScannerScreen(
                            onResult = { value ->
                                scannedUrl = value
                                scannerOpen = false
                            },
                            onClose = { scannerOpen = false },
                        )
                    }
                }

                // 首次连接时说明：返回键/长按左上角按钮可打开连接菜单
                if (showConnHint) {
                    AlertDialog(
                        onDismissRequest = {
                            showConnHint = false
                            store.connMenuHintShown = true
                        },
                        title = { Text("连接菜单") },
                        text = {
                            Text(
                                "按「返回键」（或长按左上角按钮）可以打开连接菜单：" +
                                    "刷新页面、切换服务器、设置、退出。\n\n" +
                                    "连接断开时，点页面顶部横幅的「重试」也能重新连接。",
                            )
                        },
                        confirmButton = {
                            TextButton(
                                onClick = {
                                    showConnHint = false
                                    store.connMenuHintShown = true
                                },
                            ) { Text("知道了") }
                        },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.getStringExtra(EventService.EXTRA_OPEN_SESSION)?.let { pendingSessionId.value = it }
    }

    override fun onResume() {
        super.onResume()
        AppState.inForeground = true
    }

    override fun onPause() {
        AppState.inForeground = false
        super.onPause()
    }

    private fun requestNotificationsIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (!granted) requestNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    private fun ensureEventService() {
        val store = SessionStore(this)
        if (store.paired) EventService.start(this)
    }
}
