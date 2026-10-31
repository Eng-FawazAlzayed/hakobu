package app.hakobu.android

import android.content.Context
import app.hakobu.core.Route
import app.hakobu.core.Settings

class SettingsStore(context: Context) {
    private val prefs = context.getSharedPreferences("settings", Context.MODE_PRIVATE)

    private fun route(key: String, default: Route) =
        prefs.getString(key, null)?.let { runCatching { Route.valueOf(it) }.getOrNull() } ?: default

    fun load(): Settings {
        val d = Settings()
        return Settings(
            maxActive = prefs.getInt("maxActive", d.maxActive),
            connectionsPerDownload = prefs.getInt("connections", d.connectionsPerDownload),
            speedLimitKB = prefs.getInt("speedLimitKB", d.speedLimitKB),
            httpRoute = route("httpRoute", d.httpRoute),
            torrentRoute = route("torrentRoute", d.torrentRoute),
            preferredDebrid = route("preferredDebrid", d.preferredDebrid),
            torboxKey = SecretBox.decrypt(prefs.getString("torboxKey", "")!!),
            realdebridToken = SecretBox.decrypt(prefs.getString("realdebridToken", "")!!),
            ytFormat = prefs.getString("ytFormat", d.ytFormat)!!,
            ytVideoQuality = prefs.getString("ytVideoQuality", d.ytVideoQuality)!!,
            ytAudioQuality = prefs.getString("ytAudioQuality", d.ytAudioQuality)!!,
        )
    }

    fun save(s: Settings) {
        prefs.edit()
            .putInt("maxActive", s.maxActive)
            .putInt("connections", s.connectionsPerDownload)
            .putInt("speedLimitKB", s.speedLimitKB)
            .putString("httpRoute", s.httpRoute.name)
            .putString("torrentRoute", s.torrentRoute.name)
            .putString("preferredDebrid", s.preferredDebrid.name)
            .putString("torboxKey", SecretBox.encrypt(s.torboxKey.trim()))
            .putString("realdebridToken", SecretBox.encrypt(s.realdebridToken.trim()))
            .putString("ytFormat", s.ytFormat)
            .putString("ytVideoQuality", s.ytVideoQuality)
            .putString("ytAudioQuality", s.ytAudioQuality)
            .apply()
    }
}
