package dev.dshremote.app.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

/**
 * 扫码配对：相机预览 + ML Kit 条码识别；也支持从相册选一张二维码图片。
 * 识别到内容后回调原始字符串（通常是 `http://<ip>:<port>/pair?code=XXXXXX`）。
 */
@Composable
fun ScannerScreen(
    onResult: (String) -> Unit,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    var permissionGranted by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED,
        )
    }
    var handling by remember { mutableStateOf(false) }

    val scanner = remember {
        val options = BarcodeScannerOptions.Builder()
            .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
            .build()
        BarcodeScanning.getClient(options)
    }
    DisposableEffect(scanner) {
        onDispose { scanner.close() }
    }

    fun accept(rawValue: String?) {
        if (handling) return
        val value = rawValue?.trim().orEmpty()
        if (value.isEmpty()) return
        handling = true
        onResult(value)
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> permissionGranted = granted }
    LaunchedEffect(permissionGranted) {
        if (!permissionGranted) permissionLauncher.launch(Manifest.permission.CAMERA)
    }

    val galleryLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.GetContent(),
    ) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        runCatching {
            val image = InputImage.fromFilePath(context, uri)
            scanner.process(image)
                .addOnSuccessListener { barcodes -> accept(barcodes.firstOrNull()?.rawValue) }
        }
    }

    Box(modifier = Modifier.fillMaxSize().background(Color.Black)) {
        if (permissionGranted) {
            CameraPreview(
                modifier = Modifier.fillMaxSize(),
                scanner = scanner,
                onBarcode = { rawValue -> accept(rawValue) },
            )
        } else {
            Text(
                text = "需要相机权限才能扫码。\n也可以从相册选择二维码图片。",
                color = Color(0xFFE6EDF3),
                fontSize = 14.sp,
                textAlign = TextAlign.Center,
                modifier = Modifier.align(Alignment.Center).padding(horizontal = 32.dp),
            )
        }

        Column(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .padding(top = 28.dp, start = 20.dp, end = 20.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Text(
                text = "扫描电脑上的配对二维码",
                color = Color.White,
                fontSize = 16.sp,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                text = "电脑浏览器打开 daemon 地址（或运行 .\\tools\\show-qr.ps1）后对准二维码",
                color = Color(0xB3FFFFFF),
                fontSize = 12.sp,
                textAlign = TextAlign.Center,
            )
        }

        Row(
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .fillMaxWidth()
                .padding(bottom = 36.dp, start = 24.dp, end = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            OutlinedButton(
                onClick = { galleryLauncher.launch("image/*") },
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White),
                shape = RoundedCornerShape(12.dp),
            ) { Text("从相册选择") }
            OutlinedButton(
                onClick = onClose,
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.outlinedButtonColors(contentColor = Color.White),
                shape = RoundedCornerShape(12.dp),
            ) { Text("取消") }
        }

        if (handling) {
            Box(
                modifier = Modifier.fillMaxSize().background(Color(0x66000000)),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator() }
        }
    }
}

/** 相机预览 + ImageAnalysis 扫码。 */
@Composable
private fun CameraPreview(
    modifier: Modifier,
    scanner: BarcodeScanner,
    onBarcode: (String?) -> Unit,
) {
    val context = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    val executor = remember { Executors.newSingleThreadExecutor() }
    DisposableEffect(Unit) {
        onDispose { executor.shutdown() }
    }

    AndroidView(
        modifier = modifier,
        factory = { ctx ->
            val previewView = PreviewView(ctx).apply {
                scaleType = PreviewView.ScaleType.FILL_CENTER
            }
            val providerFuture = ProcessCameraProvider.getInstance(ctx)
            providerFuture.addListener({
                val provider = providerFuture.get()
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(previewView.surfaceProvider)
                }
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                    .build()
                var lastHandled = false
                analysis.setAnalyzer(executor) { imageProxy ->
                    if (lastHandled) {
                        imageProxy.close()
                        return@setAnalyzer
                    }
                    processFrame(scanner, imageProxy) { value ->
                        if (!lastHandled && !value.isNullOrBlank()) {
                            lastHandled = true
                            onBarcode(value)
                        }
                    }
                }
                runCatching {
                    provider.unbindAll()
                    provider.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
                }
            }, ContextCompat.getMainExecutor(ctx))
            previewView
        },
    )
}

/** 把一帧相机画面交给 ML Kit 识别二维码。 */
private fun processFrame(
    scanner: BarcodeScanner,
    imageProxy: androidx.camera.core.ImageProxy,
    onValue: (String?) -> Unit,
) {
    val mediaImage = imageProxy.image
    if (mediaImage == null) {
        imageProxy.close()
        return
    }
    val image = InputImage.fromMediaImage(mediaImage, imageProxy.imageInfo.rotationDegrees)
    scanner.process(image)
        .addOnSuccessListener { barcodes -> onValue(barcodes.firstOrNull()?.rawValue) }
        .addOnFailureListener { onValue(null) }
        .addOnCompleteListener { imageProxy.close() }
}
