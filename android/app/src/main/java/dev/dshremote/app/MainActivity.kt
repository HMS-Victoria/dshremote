package dev.dshremote.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import dev.dshremote.app.ui.DshRemoteTheme
import dev.dshremote.app.ui.PairScreen
import dev.dshremote.app.ui.WebViewScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = SessionStore(this)

        setContent {
            DshRemoteTheme {
                var paired by remember { mutableStateOf(store.paired) }
                var error by remember { mutableStateOf<String?>(null) }
                var busy by remember { mutableStateOf(false) }
                val scope = rememberCoroutineScope()

                if (paired) {
                    WebViewScreen(
                        serverUrl = store.serverUrl.orEmpty(),
                        token = store.deviceToken.orEmpty(),
                        onSwitchServer = {
                            store.clear()
                            paired = false
                            error = null
                        },
                    )
                } else {
                    PairScreen(
                        initialServerUrl = store.lastServerUrl.ifBlank { "http://192.168.1.10:7801" },
                        initialCode = store.lastPairCode,
                        error = error,
                        busy = busy,
                        onConnect = { rawServer, code ->
                            error = null
                            busy = true
                            scope.launch {
                                try {
                                    val server = PairingClient.normalizeBaseUrl(rawServer)
                                    val result = withContext(Dispatchers.IO) {
                                        PairingClient().pair(server, code)
                                    }
                                    store.save(server, result.token)
                                    store.saveLastInputs(server, code)
                                    paired = true
                                } catch (throwable: Throwable) {
                                    error = throwable.message ?: "配对失败"
                                } finally {
                                    busy = false
                                }
                            }
                        },
                    )
                }
            }
        }
    }
}
