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
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
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

    if (showMenu) {
        AlertDialog(
            onDismissRequest = { showMenu = false },
            title = { Text("连接") },
            text = { Text(serverUrl) },
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
                        onSwitchServer()
                    }) { Text("切换服务器") }
                    TextButton(onClick = {
                        showMenu = false
                        activity?.finish()
                    }) { Text("退出") }
                }
            },
        )
    }
}
