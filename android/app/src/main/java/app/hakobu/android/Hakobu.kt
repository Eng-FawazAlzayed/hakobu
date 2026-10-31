package app.hakobu.android

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.ProcessLifecycleOwner
import app.hakobu.core.DownloadManager
import app.hakobu.core.HosterRegistry
import app.hakobu.core.Route
import app.hakobu.core.Settings
import app.hakobu.core.Status
import app.hakobu.core.debrid.DebridProvider
import app.hakobu.core.debrid.RealDebrid
import app.hakobu.core.debrid.TorBox
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/** App-wide objects: the engine, settings and the hook that keeps the download service running. */
class Hakobu(private val context: Context) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()

    private val settingsStore = SettingsStore(context)
    private val _settings = MutableStateFlow(settingsStore.load())
    val settings: StateFlow<Settings> = _settings.asStateFlow()

    val store = MediaStoreFileStore(context)

    val media = YtDlpEngine(context, store)

    val manager = DownloadManager(
        client = client,
        store = store,
        stateFile = File(context.filesDir, "downloads.json"),
        hosters = HosterRegistry(client, File(context.filesDir, "hosters.json")),
        initialSettings = _settings.value,
        onFinished = { item -> Notifications.finished(context, item) },
        mediaEngine = media,
    )

    init {
        // Unpack yt-dlp and keep it current in the background.
        scope.launch { runCatching { media.update() } }
        scope.launch {
            manager.start()
            // Keep a foreground service alive while anything is moving, so Android doesn't stop the downloads.
            manager.itemsFlow
                .map { list -> list.any { it.status == Status.ACTIVE || it.status == Status.RESOLVING || it.status == Status.QUEUED } }
                .distinctUntilChanged()
                .collect { busy -> if (busy) startService() }
        }
        ProcessLifecycleOwner.get().lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStop(owner: LifecycleOwner) {
                scope.launch { manager.flush() }
            }
        })
    }

    private fun startService() {
        try {
            ContextCompat.startForegroundService(context, Intent(context, DownloadService::class.java))
        } catch (e: Exception) {
            // Android 12+ refuses to start a foreground service from the background; the next app start retries.
            Log.w("Hakobu", "Couldn't start the download service", e)
        }
    }

    fun updateSettings(transform: (Settings) -> Settings) {
        val next = transform(_settings.value)
        _settings.value = next
        settingsStore.save(next)
        scope.launch { manager.updateSettings { next } }
    }

    fun provider(route: Route, s: Settings = settings.value): DebridProvider =
        if (route == Route.TORBOX) TorBox(s.torboxKey, client) else RealDebrid(s.realdebridToken, client)
}
