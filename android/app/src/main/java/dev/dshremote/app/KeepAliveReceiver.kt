package dev.dshremote.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 保活闹钟：定期检查事件服务是否还活着；被系统/厂商 ROM 杀掉后尽量重新拉起。
 * 使用不精确闹钟（不需要 exact alarm 权限），15 分钟一次，系统会做省电合并。
 */
class KeepAliveReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val store = SessionStore(context)
        if (!store.paired) {
            cancel(context)
            return
        }
        if (!EventService.isRunning) {
            runCatching { EventService.start(context) }
        }
        schedule(context)
    }

    companion object {
        private const val REQUEST_CODE = 1001
        private const val INTERVAL_MS = 15 * 60 * 1000L

        private fun pendingIntent(context: Context): PendingIntent {
            val intent = Intent(context, KeepAliveReceiver::class.java)
            return PendingIntent.getBroadcast(
                context,
                REQUEST_CODE,
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }

        /** 周期保活。 */
        fun schedule(context: Context) {
            val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            runCatching {
                manager.setInexactRepeating(
                    AlarmManager.RTC_WAKEUP,
                    System.currentTimeMillis() + INTERVAL_MS,
                    INTERVAL_MS,
                    pendingIntent(context),
                )
            }
        }

        /** 用户从最近任务划掉应用后，尽快尝试重启一次服务。 */
        fun scheduleSoon(context: Context) {
            val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            runCatching {
                manager.set(
                    AlarmManager.RTC_WAKEUP,
                    System.currentTimeMillis() + 3000,
                    pendingIntent(context),
                )
            }
        }

        fun cancel(context: Context) {
            val manager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            runCatching { manager.cancel(pendingIntent(context)) }
        }
    }
}
