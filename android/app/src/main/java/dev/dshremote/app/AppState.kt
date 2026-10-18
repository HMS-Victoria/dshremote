package dev.dshremote.app

/** 进程级的界面可见状态：前台时 WebView 自己会显示事件，避免重复弹通知。 */
object AppState {
    @Volatile
    var inForeground: Boolean = false
}
