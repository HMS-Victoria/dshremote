package dev.dshremote.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 开机 / 应用更新后尝试恢复事件订阅服务（配合保活闹钟）。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED &&
            action != Intent.ACTION_MY_PACKAGE_REPLACED &&
            action != "android.intent.action.QUICKBOOT_POWERON"
        ) {
            return
        }
        val store = SessionStore(context)
        if (!store.paired) return
        runCatching { EventService.start(context) }
        KeepAliveReceiver.schedule(context)
    }
}
