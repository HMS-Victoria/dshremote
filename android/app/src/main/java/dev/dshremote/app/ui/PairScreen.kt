package dev.dshremote.app.ui

import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * 解析扫码得到的配对地址（也兼容只含 6 位码的纯文本）。
 * @returns 服务器地址（scheme://host:port）与 6 位配对码。
 */
internal fun parsePairTarget(raw: String): Pair<String, String>? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return null
    val scheme = uri.scheme?.lowercase() ?: return null
    if (scheme != "http" && scheme != "https") return null
    val host = uri.host ?: return null
    val port = if (uri.port > 0) uri.port else if (scheme == "https") 443 else 80
    val code = uri.getQueryParameter("code")?.filter { it.isDigit() }?.take(6) ?: return null
    if (code.length != 6) return null
    val server = if ((scheme == "https" && port == 443) || (scheme == "http" && port == 80)) {
        "$scheme://$host"
    } else {
        "$scheme://$host:$port"
    }
    return server to code
}

@Composable
fun PairScreen(
    initialServerUrl: String,
    initialCode: String,
    error: String?,
    busy: Boolean,
    onConnect: (server: String, code: String) -> Unit,
    scannedUrl: String? = null,
    onScannedConsumed: () -> Unit = {},
    onScan: () -> Unit = {},
) {
    var server by remember { mutableStateOf(initialServerUrl) }
    var code by remember { mutableStateOf(initialCode.filter { it.isDigit() }.take(6)) }

    // 扫码结果：自动填入并直接发起配对
    LaunchedEffect(scannedUrl) {
        if (scannedUrl.isNullOrBlank()) return@LaunchedEffect
        val target = parsePairTarget(scannedUrl)
        onScannedConsumed()
        if (target != null) {
            server = target.first
            code = target.second
            onConnect(target.first, target.second)
        }
    }

    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .windowInsetsPadding(WindowInsets.systemBars)
                .padding(horizontal = 24.dp),
            verticalArrangement = Arrangement.Center,
        ) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Surface(
                    modifier = Modifier.size(44.dp),
                    shape = CircleShape,
                    color = MaterialTheme.colorScheme.primary.copy(alpha = 0.18f),
                ) {}
                Spacer(Modifier.size(12.dp))
                Text(
                    text = "DSH Remote",
                    fontSize = 26.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onBackground,
                )
            }
            Spacer(Modifier.height(6.dp))
            Text(
                text = "手机远程控制 PC 上的 DeepSeek Harness",
                fontSize = 14.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(28.dp))

            OutlinedTextField(
                value = server,
                onValueChange = { server = it },
                label = { Text("服务器地址") },
                placeholder = { Text("http://192.168.1.10:7801") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
            )
            Spacer(Modifier.height(12.dp))
            OutlinedTextField(
                value = code,
                onValueChange = { input ->
                    code = input.filter { it.isDigit() }.take(6)
                },
                label = { Text("配对码") },
                placeholder = { Text("6 位数字") },
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
            )

            Spacer(Modifier.height(12.dp))
            OutlinedButton(
                onClick = onScan,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(46.dp),
            ) {
                Text("扫码配对", fontSize = 15.sp)
            }

            if (error != null) {
                Spacer(Modifier.height(12.dp))
                Text(
                    text = error,
                    color = MaterialTheme.colorScheme.error,
                    fontSize = 13.sp,
                )
            }

            Spacer(Modifier.height(22.dp))
            Button(
                onClick = { onConnect(server, code) },
                enabled = !busy && server.isNotBlank() && code.length == 6,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(50.dp),
            ) {
                if (busy) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Text("连接", fontSize = 16.sp)
                }
            }

            Spacer(Modifier.height(22.dp))
            Text(
                text = "在 PC 上启动 dshremote daemon，控制台会打印 6 位配对码。\n" +
                    "手机与 PC 需要在同一局域网（后续支持内网穿透）。",
                fontSize = 12.sp,
                lineHeight = 18.sp,
                textAlign = TextAlign.Center,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}
