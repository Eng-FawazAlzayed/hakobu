package app.hakobu.android.ui

import java.util.Locale

fun formatBytes(bytes: Long?): String {
    if (bytes == null || bytes < 0) return "?"
    if (bytes < 1024) return "$bytes B"
    val units = listOf("KB", "MB", "GB", "TB")
    var v = bytes / 1024.0
    var i = 0
    while (v >= 1024 && i < units.lastIndex) {
        v /= 1024
        i++
    }
    return String.format(Locale.getDefault(), if (v >= 100) "%.0f %s" else "%.1f %s", v, units[i])
}

fun formatSpeed(bytesPerSec: Long) = "${formatBytes(bytesPerSec)}/s"

fun formatEta(remaining: Long, speed: Long): String? {
    if (speed <= 0 || remaining <= 0) return null
    val s = remaining / speed
    return when {
        s < 60 -> "${s}s left"
        s < 3600 -> "${s / 60}m left"
        else -> "${s / 3600}h ${(s % 3600) / 60}m left"
    }
}
