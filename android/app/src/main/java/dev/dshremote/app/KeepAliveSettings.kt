package dev.dshremote.app

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings

/**
 * 后台保活相关设置入口：
 * - 忽略电池优化（系统弹窗）；
 * - 华为等国产 ROM 的「应用启动管理 / 后台活动」设置页（尽力跳转，失败回退应用详情）。
 */
object KeepAliveSettings {
    fun isIgnoringBatteryOptimizations(context: Context): Boolean {
        return runCatching {
            val manager = context.getSystemService(Context.POWER_SERVICE) as PowerManager
            manager.isIgnoringBatteryOptimizations(context.packageName)
        }.getOrDefault(false)
    }

    fun requestIgnoreBatteryOptimizations(context: Context) {
        val intent = Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:" + context.packageName),
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (runCatching { context.startActivity(intent) }.isFailure) {
            openBatteryOptimizationSettings(context)
        }
    }

    fun openBatteryOptimizationSettings(context: Context) {
        runCatching {
            context.startActivity(
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }

    /** 打开应用详情页（找不到厂商启动管理时的兜底）。 */
    fun openAppSettings(context: Context) {
        runCatching {
            context.startActivity(
                Intent(
                    Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + context.packageName),
                ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        }
    }

    /** 尝试打开发动机型（华为/荣耀）的启动管理页面；成功返回 true。 */
    fun openVendorStartupManager(context: Context): Boolean {
        val candidates = listOf(
            ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
            ComponentName("com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity"),
            ComponentName("com.hihonor.systemmanager", "com.hihonor.systemmanager.startupmgr.ui.StartupNormalAppListActivity"),
        )
        for (component in candidates) {
            val intent = Intent().setComponent(component).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (runCatching { context.startActivity(intent) }.isSuccess) return true
        }
        return false
    }
}
