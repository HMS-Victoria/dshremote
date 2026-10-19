# dshremote Android（M3）

薄壳 + WebView 的混合 App：
1. 原生配对页：填服务器地址 + 6 位配对码 → `POST /__dshremote/pair` 换设备令牌；
2. 原生壳把设备令牌写入 WebView Cookie，加载 daemon 提供的 DSH 界面（含移动端注入）；
3. 系统返回键：先让注入脚本关闭抽屉/右栏，再退回 WebView 历史，最后弹出连接菜单；
4. 长按页面左上角悬浮菜单按钮 → 打开原生连接菜单（刷新/切换服务器/退出，由注入脚本桥接
   `window.DshRemoteNative.showMenu()`）；
5. WebView 里点附件按钮会拉起系统图片选择器（对应 DSH 图片附件）。

## 环境

- JDK 21：`C:\Program Files\Microsoft\jdk-21.0.10.7-hotspot`
- Android SDK：`D:\Android`（build-tools 35.0.0、platforms;android-35）
- Gradle：`D:\Android\gradle-8.11.1\bin\gradle.bat`
- `android/local.properties` 已配置 `sdk.dir=D:\Android`（不入库）

## 构建

```powershell
cd <项目根目录>
node tools/build-android.mjs
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

## 安装

方式一（USB 调试）：

```powershell
D:\Android\platform-tools\adb.exe install -r android\app\build\outputs\apk\debug\app-debug.apk
```

方式二：把 APK 传到手机（微信/USB/网盘），在手机上允许"安装未知应用"后打开安装。

## 使用

1. PC 上启动 daemon：`.\tools\start.ps1`（或 `cd server; node src/index.js`）；
2. 控制台会打印配对码与手机访问地址，例如：
   `手机访问: http://192.168.1.10:7801/pair?code=076310`
3. App 里填服务器地址 `http://192.168.1.10:7801` + 配对码；
4. 连接成功后进入 DSH 界面。

## 权限说明

- `INTERNET`：连接 daemon；
- `ACCESS_NETWORK_STATE`：网络状态；
- `POST_NOTIFICATIONS`：预留（通知功能在后续迭代实现）。
- 明文 HTTP：`usesCleartextTraffic=true`，用于局域网 http；后续接隧道后走 HTTPS。
