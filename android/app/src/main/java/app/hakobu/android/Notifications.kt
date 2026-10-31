package app.hakobu.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.hakobu.core.DownloadItem

object Notifications {
    const val PROGRESS_CHANNEL = "progress"
    const val DONE_CHANNEL = "done"
    const val PROGRESS_ID = 1

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(PROGRESS_CHANNEL, "Downloads in progress", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(DONE_CHANNEL, "Finished downloads", NotificationManager.IMPORTANCE_DEFAULT))
    }

    fun openAppIntent(context: Context): PendingIntent = PendingIntent.getActivity(
        context, 0,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    fun finished(context: Context, item: DownloadItem) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
        createChannels(context)
        val ref = item.storeRef ?: return
        val open = Intent(Intent.ACTION_VIEW)
            .setDataAndType(Uri.parse(ref), context.hakobu.store.mimeType(item.name))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        val pi = PendingIntent.getActivity(context, item.id.hashCode(), open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val n = NotificationCompat.Builder(context, DONE_CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_download)
            .setContentTitle(item.name)
            .setContentText("Download finished")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        NotificationManagerCompat.from(context).notify(item.id.hashCode(), n)
    }
}
