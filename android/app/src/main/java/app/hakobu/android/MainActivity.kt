package app.hakobu.android

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import app.hakobu.android.ui.HakobuRoot
import app.hakobu.android.ui.HakobuTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Something another app handed us: text with links, or a .torrent file. */
sealed interface Incoming {
    data class Text(val text: String) : Incoming
    data class Torrent(val name: String, val bytes: ByteArray) : Incoming
}

class MainActivity : ComponentActivity() {
    private val incoming = MutableStateFlow<Incoming?>(null)

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        if (savedInstanceState == null) handleIntent(intent)
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
        setContent {
            HakobuTheme {
                HakobuRoot(hakobu, incoming, readTorrent = ::readTorrent)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        intent ?: return
        when (intent.action) {
            Intent.ACTION_SEND -> intent.getStringExtra(Intent.EXTRA_TEXT)?.let { incoming.value = Incoming.Text(it) }
            Intent.ACTION_VIEW -> {
                val data = intent.data ?: return
                if (data.scheme.equals("magnet", ignoreCase = true)) incoming.value = Incoming.Text(data.toString())
                else readTorrent(data)
            }
        }
    }

    /** Read a picked or opened .torrent file and hand it to the LinkGrabber. */
    fun readTorrent(uri: Uri) {
        lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                runCatching {
                    val name = contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                        if (c.moveToFirst()) c.getString(0) else null
                    } ?: uri.lastPathSegment ?: "file.torrent"
                    val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: error("Couldn't read the file")
                    require(bytes.size < 20 * 1024 * 1024) { "That file is too big to be a .torrent" }
                    Incoming.Torrent(name, bytes)
                }
            }
            result.getOrNull()?.let { incoming.value = it }
        }
    }
}
