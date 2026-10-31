package app.hakobu.android

import android.content.Context
import android.util.Log
import app.hakobu.core.DownloadItem
import app.hakobu.core.MediaEngine
import app.hakobu.core.MediaFile
import app.hakobu.core.MediaFormats
import app.hakobu.core.MediaInfo
import app.hakobu.core.MediaProgress
import app.hakobu.core.Names
import com.yausername.ffmpeg.FFmpeg
import com.yausername.youtubedl_android.YoutubeDL
import com.yausername.youtubedl_android.YoutubeDLRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.job
import kotlinx.coroutines.runInterruptible
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import java.io.File
import java.io.FileInputStream
import java.util.Collections
import kotlin.coroutines.coroutineContext

private const val SYNDICATION = "twitter:api=syndication"
private val X_HOST = Regex("""^https?://([^/]+\.)?(x|twitter)\.com/""", RegexOption.IGNORE_CASE)

/** yt-dlp (with its own Python, ffmpeg and QuickJS) running on the phone. */
class YtDlpEngine(private val context: Context, private val store: MediaStoreFileStore) : MediaEngine {
    private val mutex = Mutex()
    @Volatile
    private var ready = false
    private val json = Json { ignoreUnknownKeys = true }

    // X links whose lookup only worked through the syndication API, so their download uses it too.
    private val useSyndication: MutableSet<String> = Collections.synchronizedSet(HashSet())
    private fun isX(url: String) = X_HOST.containsMatchIn(url)

    suspend fun ensureReady() = mutex.withLock {
        if (!ready) withContext(Dispatchers.IO) {
            try {
                YoutubeDL.init(context)
                FFmpeg.init(context)
            } catch (t: Throwable) {
                // An Error here (e.g. a class missing from the release build) must reach callers as a normal failure, not kill the app.
                throw IllegalStateException("Couldn't start yt-dlp: ${t.message ?: t.javaClass.simpleName}", t)
            }
            ready = true
        }
    }

    /** Fetch the newest yt-dlp at most once a day (YouTube changes often). Returns the version in use. */
    suspend fun update(force: Boolean = false): String? {
        ensureReady()
        val prefs = context.getSharedPreferences("ytdlp", Context.MODE_PRIVATE)
        val last = prefs.getLong("lastUpdate", 0)
        if (force || System.currentTimeMillis() - last > 24 * 3600_000L) {
            withContext(Dispatchers.IO) {
                try {
                    YoutubeDL.updateYoutubeDL(context, YoutubeDL.UpdateChannel._STABLE)
                    prefs.edit().putLong("lastUpdate", System.currentTimeMillis()).apply()
                } catch (e: Exception) {
                    Log.w("Hakobu", "yt-dlp update failed", e)
                    if (force) throw e
                }
            }
        }
        return version()
    }

    fun version(): String? = runCatching { YoutubeDL.versionName(context) ?: YoutubeDL.version(context) }.getOrNull()

    override suspend fun info(url: String, playlist: Boolean): MediaInfo {
        ensureReady()
        fun request(syndication: Boolean) = YoutubeDLRequest(url)
            .addOption("--dump-single-json")
            .addOption("--flat-playlist")
            .addOption("--no-warnings")
            .addOption("--socket-timeout", "20")
            .addOption(if (playlist) "--yes-playlist" else "--no-playlist")
            .apply { if (syndication) addOption("--extractor-args", SYNDICATION) }
        val out = try {
            runInterruptible(Dispatchers.IO) { YoutubeDL.execute(request(url in useSyndication), null, false, null).out }
        } catch (e: Exception) {
            if (e is CancellationException || !isX(url) || url in useSyndication) throw e
            // X often stalls its guest API; its public embed (syndication) API still serves most posts.
            Log.w("Hakobu", "X lookup failed, retrying via syndication", e)
            useSyndication += url
            runInterruptible(Dispatchers.IO) { YoutubeDL.execute(request(true), null, false, null).out }
        }
        val o = json.parseToJsonElement(out) as JsonObject
        fun str(k: String) = (o[k] as? JsonPrimitive)?.takeIf { it.isString }?.content?.ifBlank { null }
        val thumbs = (o["thumbnails"] as? JsonArray)?.mapNotNull { ((it as? JsonObject)?.get("url") as? JsonPrimitive)?.content }
        val isPlaylist = str("_type") == "playlist"
        return MediaInfo(
            title = str("title") ?: url,
            uploader = str("uploader") ?: str("channel") ?: str("playlist_uploader"),
            thumbnail = str("thumbnail") ?: thumbs?.lastOrNull(),
            durationSec = (o["duration"] as? JsonPrimitive)?.doubleOrNull?.toInt(),
            site = str("extractor_key"),
            isPlaylist = isPlaylist,
            entries = if (isPlaylist) (o["playlist_count"] as? JsonPrimitive)?.intOrNull ?: (o["entries"] as? JsonArray)?.size else null,
        )
    }

    /** A direct audio stream for previewing [url], with the headers the site wants. */
    suspend fun audioStream(url: String): Pair<String, Map<String, String>> {
        ensureReady()
        val req = YoutubeDLRequest(url)
            .addOption("-j")
            .addOption("-f", "bestaudio/best")
            .addOption("--no-playlist")
            .addOption("--no-warnings")
            .addOption("--socket-timeout", "20")
            .apply { if (url in useSyndication) addOption("--extractor-args", SYNDICATION) }
        val out = runInterruptible(Dispatchers.IO) { YoutubeDL.execute(req, null, false, null).out }
        val o = json.parseToJsonElement(out.lines().first { it.startsWith("{") }) as JsonObject
        val stream = (o["url"] as? JsonPrimitive)?.content ?: throw IllegalStateException("No audio stream for this link")
        val headers = (o["http_headers"] as? JsonObject)?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.content?.let { k to it } }?.toMap().orEmpty()
        return stream to headers
    }

    private fun outputTemplate(item: DownloadItem): String {
        if (item.playlist) return "%(playlist_index)03d - %(title).150B.%(ext)s"
        // "∶" looks like a colon but is allowed in file names.
        val clip = MediaFormats.clipLabel(item.clipStart, item.clipEnd)?.replace(":", "∶")?.replace("%", "%%")
        return if (clip != null) "%(title).160B ($clip).%(ext)s" else "%(title).180B.%(ext)s"
    }

    override suspend fun download(item: DownloadItem, onProgress: (MediaProgress) -> Unit): List<MediaFile> {
        ensureReady()
        // Work in a private folder per item, so a paused download resumes from yt-dlp's .part files.
        val dir = File(context.cacheDir, "media/${item.id}").apply { mkdirs() }
        val req = YoutubeDLRequest(item.source)
            .addOption("--newline")
            .addOption("--no-warnings")
            .addOption("--no-mtime")
            .addOption("--retries", "5")
            .addOption("--fragment-retries", "5")
            .addOption("-N", "4")
            .addOption("-P", dir.absolutePath)
            .addOption("-o", outputTemplate(item))
            .addOption("--embed-metadata")
            .addOption("--embed-thumbnail")
            .addOption("--convert-thumbnails", "jpg")
            .addOption(if (item.playlist) "--yes-playlist" else "--no-playlist")
            .apply { if (item.source in useSyndication) addOption("--extractor-args", SYNDICATION) }
        val fmtArgs = MediaFormats.args(item.mediaFormat ?: "mp4", item.mediaQuality ?: "1080") + MediaFormats.sectionArgs(item.clipStart, item.clipEnd)
        var i = 0
        while (i < fmtArgs.size) {
            val next = fmtArgs.getOrNull(i + 1)
            if (next != null && !next.startsWith("-")) {
                req.addOption(fmtArgs[i], next)
                i += 2
            } else {
                req.addOption(fmtArgs[i])
                i++
            }
        }

        var stage: String? = null
        var total: Long? = null
        val handle = coroutineContext.job.invokeOnCompletion { cause ->
            if (cause is CancellationException) runCatching { YoutubeDL.destroyProcessById(item.id) }
        }
        try {
            runInterruptible(Dispatchers.IO) {
                YoutubeDL.execute(req, item.id, false) { progress, eta, line ->
                    MediaFormats.itemOf(line)?.let { stage = it }
                    MediaFormats.stageOf(line)?.let { stage = it }
                    MediaFormats.totalOf(line)?.let { total = it }
                    onProgress(
                        MediaProgress(
                            fraction = (progress / 100.0).coerceIn(0.0, 1.0),
                            speed = MediaFormats.speedOf(line) ?: 0,
                            etaSec = eta.takeIf { it > 0 },
                            totalBytes = total,
                            stage = stage,
                        )
                    )
                }
            }
        } finally {
            handle.dispose()
        }

        // Move the results into Download/Hakobu (a playlist gets its own folder).
        val leftovers = setOf("part", "ytdl", "jpg", "jpeg", "webp", "png", "temp")
        val produced = dir.listFiles()?.filter { it.isFile && it.extension.lowercase() !in leftovers }?.sortedBy { it.name }.orEmpty()
        val folder = if (produced.size > 1) listOf(item.folder, Names.sanitize(item.name)).filter { it.isNotEmpty() }.joinToString("/") else item.folder
        val out = withContext(Dispatchers.IO) {
            produced.map { f ->
                val stored = store.create(folder, Names.sanitize(f.name))
                store.open(stored.ref).use { dst ->
                    FileInputStream(f).channel.use { src ->
                        var pos = 0L
                        val size = src.size()
                        while (pos < size) pos += src.transferTo(pos, size - pos, dst)
                    }
                }
                val ref = store.finish(stored.ref)
                MediaFile(ref, stored.name, f.length()).also { f.delete() }
            }
        }
        dir.deleteRecursively()
        return out
    }
}
