package dev.dshremote.app.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.dshremote.app.SessionStore
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import org.json.JSONObject
import kotlin.coroutines.resume

/** 在 WebView 里选择图片（对应 DSH 的图片附件）时，桥接系统文件选择器。 */
private class FileChooserBridge {
    var callback: ValueCallback<Array<Uri>>? = null
    var launch: (() -> Unit)? = null
}

/** 暴露给注入脚本的原生桥（window.DshRemoteNative）。 */
private class NativeBridge(private val onShowMenu: () -> Unit) {
    private val handler = Handler(Looper.getMainLooper())

    @JavascriptInterface
    fun onReady(version: String) = Unit

    @JavascriptInterface
    fun showMenu() {
        handler.post(onShowMenu)
    }

    @JavascriptInterface
    fun toast(message: String) = Unit
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebViewScreen(
    serverUrl: String,
    token: String,
    pendingSessionId: String? = null,
    onSessionOpened: () -> Unit = {},
    onSwitchServer: () -> Unit,
    onServerChanged: (String) -> Unit = {},
    onPairingLost: () -> Unit = {},
) {
    val context = LocalContext.current
    val activity = context as? Activity
    val chooser = remember { FileChooserBridge() }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        chooser.callback?.onReceiveValue(uris.toTypedArray())
        chooser.callback = null
    }
    chooser.launch = { filePicker.launch("image/*") }

    var showMenu by remember { mutableStateOf(false) }
    var webView by remember { mutableStateOf<WebView?>(null) }
    var showServerDialog by remember { mutableStateOf(false) }
    var serverEdit by remember { mutableStateOf(serverUrl) }
    val loadRetries = remember { intArrayOf(0) }
    val serverHost = remember(serverUrl) { runCatching { Uri.parse(serverUrl).host }.getOrNull() }

    // 通知点击带来的会话 id：等页面脚本就绪后调用 window.dshremoteOpenSession 打开对应会话
    LaunchedEffect(pendingSessionId, webView) {
        val view = webView
        val sessionId = pendingSessionId
        if (view == null || sessionId == null) return@LaunchedEffect
        val quoted = JSONObject.quote(sessionId)
        val script = """
            (function () {
              if (!window.dshremoteOpenSession) return 'not-ready';
              return window.dshremoteOpenSession($quoted) ? true : false;
            })()
        """.trimIndent()
        repeat(25) {
            val result = suspendCancellableCoroutine<String?> { continuation ->
                view.evaluateJavascript(script) { value -> continuation.resume(value) }
            }
            if (result == "true") {
                onSessionOpened()
                return@LaunchedEffect
            }
            delay(300)
        }
        onSessionOpened()
    }

    // 返回键：先让页面消费（关闭抽屉/右栏），再退回历史，最后弹出连接菜单
    BackHandler {
        val view = webView
        if (view == null) {
            showMenu = true
            return@BackHandler
        }
        view.evaluateJavascript("window.dshremoteGoBack ? window.dshremoteGoBack() : false") { handled ->
            if (handled != "true") {
                if (view.canGoBack()) view.goBack() else showMenu = true
            }
        }
    }

    Box(modifier = Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { ctx ->
                WebView(ctx).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.databaseEnabled = true
                    settings.useWideViewPort = true
                    settings.loadWithOverviewMode = false
                    settings.setSupportZoom(false)
                    settings.builtInZoomControls = false
                    settings.mediaPlaybackRequiresUserGesture = false
                    settings.allowFileAccess = false
                    settings.allowContentAccess = false
                    setBackgroundColor(0xFF0E1116.toInt())
                    overScrollMode = WebView.OVER_SCROLL_NEVER

                    CookieManager.getInstance().setAcceptCookie(true)
                    CookieManager.getInstance().setCookie(serverUrl, "dshremote_device=$token")
                    CookieManager.getInstance().flush()

                    addJavascriptInterface(NativeBridge(onShowMenu = { showMenu = true }), "DshRemoteNative")

                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                            val uri = request.url
                            if (uri.host == serverHost) return false
                            runCatching {
                                view.context.startActivity(Intent(Intent.ACTION_VIEW, uri))
                            }
                            return true
                        }

                        override fun onPageFinished(view: WebView, url: String) {
                            loadRetries[0] = 0
                        }

                        override fun onReceivedError(
                            view: WebView,
                            request: WebResourceRequest,
                            error: WebResourceError,
                        ) {
                            // 主页面加载失败（网络波动/切换）时自动重试，避免直接显示错误页让用户以为要重新配对
                            if (request.isForMainFrame && loadRetries[0] < 6) {
                                loadRetries[0]++
                                view.postDelayed({ view.loadUrl(serverUrl) }, 2500)
                            }
                        }

                        override fun onReceivedHttpError(
                            view: WebView,
                            request: WebResourceRequest,
                            errorResponse: WebResourceResponse,
                        ) {
                            // 只有令牌失效（401）才需要重新配对
                            if (request.isForMainFrame && errorResponse.statusCode == 401) {
                                onPairingLost()
                            }
                        }
                    }
                    webChromeClient = object : WebChromeClient() {
                        override fun onShowFileChooser(
                            view: WebView?,
                            callback: ValueCallback<Array<Uri>>?,
                            params: FileChooserParams?,
                        ): Boolean {
                            if (callback == null || chooser.callback != null) return false
                            chooser.callback = callback
                            val launch = chooser.launch
                            if (launch == null) {
                                chooser.callback = null
                                return false
                            }
                            launch()
                            return true
                        }
                    }

                    webView = this
                    loadUrl(serverUrl)
                }
            },
            onRelease = { view ->
                view.stopLoading()
                view.destroy()
            },
        )
    }

    // 通知开关（存 SharedPreferences，EventService 发通知前读取）
    val settingsStore = remember { activity?.let { SessionStore(it) } }
    var notifyApproval by remember { mutableStateOf(settingsStore?.notifyApproval ?: true) }
    var notifyTurns by remember { mutableStateOf(settingsStore?.notifyTurns ?: true) }

    if (showMenu) {
        AlertDialog(
            onDismissRequest = { showMenu = false },
            title = { Text("连接") },
            text = {
                Column {
                    Text(serverUrl)
                    Spacer(Modifier.height(12.dp))
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                    ) {
                        Text("审批与错误提醒", modifier = Modifier.weight(1f), fontSize = 14.sp)
                        Switch(
                            checked = notifyApproval,
                            onCheckedChange = {
                                notifyApproval = it
                                settingsStore?.notifyApproval = it
                            },
                        )
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
                    ) {
                        Text("回合完成提醒", modifier = Modifier.weight(1f), fontSize = 14.sp)
                        Switch(
                            checked = notifyTurns,
                            onCheckedChange = {
                                notifyTurns = it
                                settingsStore?.notifyTurns = it
                            },
                        )
                    }
                }
            },
            confirmButton = {
                Row(horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = {
                        showMenu = false
                        webView?.evaluateJavascript(
                            "window.dshremoteOpenSettings && window.dshremoteOpenSettings()",
                            null,
                        )
                    }) { Text("设置") }
                    TextButton(onClick = {
                        showMenu = false
                        webView?.reload()
                    }) { Text("刷新页面") }
                }
            },
            dismissButton = {
                Row(horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = {
                        showMenu = false
                        serverEdit = serverUrl
                        showServerDialog = true
                    }) { Text("修改地址") }
                    TextButton(onClick = {
                        showMenu = false
                        activity?.finish()
                    }) { Text("退出") }
                }
            },
        )
    }

    if (showServerDialog) {
        AlertDialog(
            onDismissRequest = { showServerDialog = false },
            title = { Text("服务器地址") },
            text = {
                Column {
                    Text(
                        "修改地址不会丢失配对（同一台电脑的局域网/Tailscale 地址可互换）。\n" +
                            "只有换了一台电脑或配对失效时才需要「重新配对」。",
                        fontSize = 12.sp,
                        lineHeight = 18.sp,
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedTextField(
                        value = serverEdit,
                        onValueChange = { serverEdit = it },
                        label = { Text("地址") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(onClick = {
                    val value = serverEdit.trim()
                    showServerDialog = false
                    if (value.isNotEmpty()) onServerChanged(value)
                }) { Text("保存并重连") }
            },
            dismissButton = {
                Row(horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = {
                        showServerDialog = false
                        onSwitchServer()
                    }) { Text("重新配对") }
                    TextButton(onClick = { showServerDialog = false }) { Text("取消") }
                }
            },
        )
    }
}
