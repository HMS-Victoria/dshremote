package dev.dshremote.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.os.IBinder
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * 前台服务：订阅 daemon 的宿主事件通道（`/__dshremote/events`），
 * 在审批请求 / 回合结束 / Agent 报错时发通知，点击通知直接打开对应会话。
 *
 * 连接失败时指数退避重连；应用在前台时不重复弹通知（WebView 自己会显示）。
 */
class EventService : Service() {
    private val job = SupervisorJob()
    private val scope = CoroutineScope(job + Dispatchers.IO)
    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build()

    private lateinit var store: SessionStore
    private var socket: WebSocket? = null
    private var reconnectTimer: Job? = null
    private var connected = false
    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            // 网络恢复/切换（Wi-Fi <-> 4G）时立即重连，不用等退避
            if (!connected) {
                attempt = 0
                connect()
            }
        }
    }
    private var attempt = 0
    private var notificationSeq = 1000

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        store = SessionStore(this)
        createChannels()
        startForeground(NOTIFICATION_SERVICE_ID, buildServiceNotification("正在连接…"))
        KeepAliveReceiver.schedule(this)
        runCatching {
            val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            manager.registerDefaultNetworkCallback(networkCallback)
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            KeepAliveReceiver.cancel(this)
            stopSelf()
            return START_NOT_STICKY
        }
        KeepAliveReceiver.schedule(this)
        connect()
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // 从最近任务划掉应用后，尽量在几秒后重新拉起服务（部分 ROM 仍可能阻止）
        KeepAliveReceiver.scheduleSoon(this)
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        isRunning = false
        reconnectTimer?.cancel()
        socket?.close(1000, "service stopped")
        socket = null
        runCatching {
            val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            manager.unregisterNetworkCallback(networkCallback)
        }
        job.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    // ── 连接管理 ────────────────────────────────────────────────────────────

    private fun connect() {
        // 探测所有候选地址（局域网/Tailscale），选择当前网络下可用的那个
        scope.launch {
            val server = ServerResolver.resolve(this@EventService)
            val token = store.deviceToken
            if (server.isEmpty() || token.isNullOrEmpty()) {
                stopSelf()
                return@launch
            }
            val wsUrl = eventsUrl(server) ?: run {
                stopSelf()
                return@launch
            }
            socket?.cancel()
            updateServiceNotification("正在连接 ${Uri.parse(server).host}…")
            val request = Request.Builder()
                .url(wsUrl)
                .header("Cookie", "dshremote_device=$token")
                .build()
            socket = client.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    attempt = 0
                    connected = true
                    updateServiceNotification("已连接：审批/回合事件监听中")
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleMessage(text)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    connected = false
                    scheduleReconnect()
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    connected = false
                    updateServiceNotification("连接断开，重试中…")
                    scheduleReconnect()
                }
            })
        }
    }

    private fun scheduleReconnect() {
        if (reconnectTimer?.isActive == true) return
        attempt += 1
        val delayMs = (1_000L shl attempt.coerceAtMost(5)).coerceAtMost(60_000L)
        reconnectTimer = scope.launch {
            delay(delayMs)
            if (store.paired) connect() else stopSelf()
        }
    }

    // ── 事件处理 ────────────────────────────────────────────────────────────

    private fun handleMessage(text: String) {
        val payload = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (payload.optString("type")) {
            "hello" -> {
                val events = payload.optJSONArray("events") ?: return
                // 首次连接：把历史事件视为已读，避免一次弹出十几条旧通知。
                if (store.lastEventAt.isEmpty()) {
                    val last = events.optJSONObject(events.length() - 1)
                    if (last != null) {
                        store.lastEventAt = last.optString("at")
                        return
                    }
                }
                for (index in 0 until events.length()) {
                    val event = events.optJSONObject(index) ?: continue
                    handleEvent(event)
                }
            }

            "event" -> {
                val event = payload.optJSONObject("event") ?: return
                handleEvent(event)
            }

            else -> Unit // ping
        }
    }

    private fun handleEvent(event: JSONObject) {
        val at = event.optString("at")
        val lastSeen = store.lastEventAt
        if (at.isNotEmpty() && lastSeen.isNotEmpty() && at <= lastSeen) return
        if (at.isNotEmpty()) store.lastEventAt = at

        if (AppState.inForeground) return // 应用在前台，WebView 里已经能看到

        val sessionId = event.optString("sessionId").takeIf { it.isNotEmpty() }
        val title = event.optString("title").takeIf { it.isNotEmpty() }
        when (event.optString("kind")) {
            "approval" -> {
                if (!store.notifyApproval) return
                val tool = event.optString("toolName")
                val reason = event.optString("reason")
                val detail = listOf(tool, reason).filter { it.isNotEmpty() }.joinToString(" · ")
                notifyEvent(
                    CHANNEL_APPROVAL,
                    if (title != null) "需要审批：$title" else "需要审批",
                    detail.ifEmpty { "有一个工具调用等待审批" },
                    sessionId,
                    high = true,
                )
            }

            "turn-end" -> {
                if (!store.notifyTurns) return
                notifyEvent(
                    CHANNEL_TURNS,
                    if (title != null) "回合完成：$title" else "回合完成",
                    "本轮已结束，点按查看结果",
                    sessionId,
                    high = false,
                )
            }

            "agent-error" -> {
                if (!store.notifyApproval) return
                val message = event.optString("message")
                notifyEvent(
                    CHANNEL_APPROVAL,
                    if (title != null) "会话出错：$title" else "会话出错",
                    message.ifEmpty { "Agent 报错，点按查看" },
                    sessionId,
                    high = true,
                )
            }
        }
    }

    // ── 通知 ────────────────────────────────────────────────────────────────

    private fun createChannels() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_SERVICE, "远程连接状态", NotificationManager.IMPORTANCE_LOW).apply {
                description = "显示与电脑上 DSH 的连接状态"
                setShowBadge(false)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_APPROVAL, "审批与错误", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "需要审批或会话出错时提醒"
                enableVibration(true)
            },
        )
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_TURNS, "回合完成", NotificationManager.IMPORTANCE_DEFAULT).apply {
                description = "对话回合完成时提醒"
            },
        )
    }

    private fun buildServiceNotification(text: String): Notification {
        val contentIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Builder(this, CHANNEL_SERVICE)
            .setContentTitle("DSH Remote")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .build()
    }

    private fun updateServiceNotification(text: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_SERVICE_ID, buildServiceNotification(text))
    }

    private fun notifyEvent(channel: String, title: String, text: String, sessionId: String?, high: Boolean) {
        val contentIntent = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra(EXTRA_OPEN_SESSION, sessionId)
        val pendingIntent = PendingIntent.getActivity(
            this,
            notificationSeq,
            contentIntent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val priority = if (high) Notification.PRIORITY_HIGH else Notification.PRIORITY_DEFAULT
        val builder = Notification.Builder(this, channel)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(Notification.BigTextStyle().bigText(text))
            .setSmallIcon(android.R.drawable.stat_notify_more)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setPriority(priority)
            .setDefaults(Notification.DEFAULT_ALL)
        if (high) builder.setCategory(Notification.CATEGORY_REMINDER)
        getSystemService(NotificationManager::class.java).notify(notificationSeq++, builder.build())
    }

    companion object {
        const val ACTION_STOP = "dev.dshremote.app.action.STOP_EVENTS"
        const val EXTRA_OPEN_SESSION = "open_session"
        private const val CHANNEL_SERVICE = "dshremote_service"
        private const val CHANNEL_APPROVAL = "dshremote_approval"
        private const val CHANNEL_TURNS = "dshremote_turns"
        private const val NOTIFICATION_SERVICE_ID = 42

        /** 把 http(s) 服务器地址转成事件通道的 ws(s) 地址。 */
        private fun eventsUrl(serverUrl: String): String? = runCatching {
            val uri = Uri.parse(serverUrl)
            val scheme = if (uri.scheme == "https") "wss" else "ws"
            val host = uri.host ?: return null
            val port = if (uri.port > 0) uri.port else if (scheme == "wss") 443 else 80
            "$scheme://$host:$port/__dshremote/events"
        }.getOrNull()

        /** 启动事件订阅（配对成功后调用）。 */
        fun start(context: Context) {
            val intent = Intent(context, EventService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }

        /** 停止事件订阅（切换服务器/退出时调用）。 */
        fun stop(context: Context) {
            KeepAliveReceiver.cancel(context)
            context.stopService(Intent(context, EventService::class.java))
        }

        /** 服务是否在运行（保活闹钟用它判断是否需要重新拉起）。 */
        @Volatile
        var isRunning: Boolean = false
    }
}
