package app.hakobu.android

import android.Manifest
import android.app.Service
import android.content.pm.PackageManager
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.hakobu.android.ui.formatSpeed
import app.hakobu.core.DownloadItem
import app.hakobu.core.Status
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/** Foreground service that keeps the process alive while downloads run, with a progress notification. */
class DownloadService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var watcher: Job? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Notifications.createChannels(this)
        ServiceCompat.startForeground(
            this, Notifications.PROGRESS_ID, buildNotification(emptyList()),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
        acquireLocks()
        if (watcher == null) {
            watcher = scope.launch {
                hakobu.manager.itemsFlow.collect { items ->
                    val busy = items.filter { it.status == Status.ACTIVE || it.status == Status.RESOLVING || it.status == Status.QUEUED }
                    if (busy.isEmpty()) {
                        stop()
                    } else {
                        updateNotification(busy)
                    }
                }
            }
        }
        return START_NOT_STICKY
    }

    private fun updateNotification(busy: List<DownloadItem>) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        runCatching { NotificationManagerCompat.from(this).notify(Notifications.PROGRESS_ID, buildNotification(busy)) }
    }

    private fun buildNotification(busy: List<DownloadItem>): android.app.Notification {
        val speed = busy.sumOf { if (it.via.isDebrid) 0L else it.speed }
        val active = busy.filter { it.status == Status.ACTIVE }
        val sized = active.filter { (it.size ?: 0) > 0 }
        val total = sized.sumOf { it.size ?: 0 }
        val done = sized.sumOf { it.downloaded }
        val title = when {
            busy.isEmpty() -> "Starting downloads"
            busy.size == 1 -> busy[0].name
            else -> "${busy.size} downloads"
        }
        val text = buildString {
            if (active.isNotEmpty()) append(formatSpeed(speed))
            val waiting = busy.size - active.size
            if (waiting > 0) {
                if (isNotEmpty()) append(" · ")
                append("$waiting waiting")
            }
        }
        return NotificationCompat.Builder(this, Notifications.PROGRESS_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(Notifications.openAppIntent(this))
            .setProgress(100, if (total > 0) (done * 100 / total).toInt() else 0, total <= 0 && active.isNotEmpty())
            .build()
    }

    @Suppress("DEPRECATION")
    private fun acquireLocks() {
        if (wakeLock == null) {
            wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Hakobu:downloads").apply {
                setReferenceCounted(false)
                acquire()
            }
        }
        if (wifiLock == null) {
            wifiLock = getSystemService(WifiManager::class.java)?.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Hakobu:downloads")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        }
    }

    private fun stop() {
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    /** Android 15 caps dataSync services at 6 hours a day: pause everything cleanly when told to stop. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        // The system only waits a few seconds here: leave the foreground first, then pause in the app's own scope.
        stop()
        hakobu.scope.launch { hakobu.manager.pauseAll() }
    }

    override fun onDestroy() {
        scope.cancel()
        runCatching { wakeLock?.release() }
        runCatching { wifiLock?.release() }
        super.onDestroy()
    }
}
