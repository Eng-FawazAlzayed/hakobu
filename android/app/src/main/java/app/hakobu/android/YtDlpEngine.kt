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
import app.hakobu.core.XCookies
import app.hakobu.core.XPost
import app.hakobu.core.XPosts
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
import java.io.IOException
import java.util.Collections
import kotlin.coroutines.coroutineContext
import okhttp3.OkHttpClient
import okhttp3.Request

private const val SYNDICATION = "twitter:api=syndication"
private val X_NO_VIDEO = Regex("No video could be found in this tweet", RegexOption.IGNORE_CASE)
private val TIMED_OUT = Regex("timed out|timeout", RegexOption.IGNORE_CASE)
private val X_REFUSED = Regex("HTTP Error 40[13]|Could not authenticate", RegexOption.IGNORE_CASE)

/** yt-dlp (with its own Python, ffmpeg and QuickJS) running on the phone. */
class YtDlpEngine(private val context: Context, private val store: MediaStoreFileStore, private val client: OkHttpClient, private val xAccount: XAccount) : MediaEngine {
    private val mutex = Mutex()
    @Volatile
    private var ready = false
    private val json = Json { ignoreUnknownKeys = true }

    // X links whose lookup only worked through the syndication API, so their download uses it too.
    private val useSyndication: MutableSet<String> = Collections.synchronizedSet(HashSet())
    private fun isX(url: String) = XPosts.isXUrl(url)

    private fun YoutubeDLRequest.xCookies(url: String, file: File?) = apply {
        XCookies.args(url, file?.absolutePath).takeIf { it.isNotEmpty() }?.let { (flag, path) -> addOption(flag, path) }
    }

    // Once X's guest API has stalled, later X links go straight to syndication instead of waiting for it to time out again.
    @Volatile
    private var xGuestApiStalled = false
    private fun viaSyndication(url: String) = url in useSyndication || (xGuestApiStalled && isX(url))

    /** X's embed data for a post, or null if it couldn't be read. */
    private suspend fun xPost(url: String): XPost? {
        val id = XPosts.statusId(url) ?: return null
        return try {
            runInterruptible(Dispatchers.IO) {
                client.newCall(Request.Builder().url(XPosts.embedUrl(id)).build()).execute().use { r ->
                    when {
                        r.code == 404 -> XPost.Gone
                        r.isSuccessful -> XPosts.parse(r.body?.string().orEmpty())
                        else -> null
                    }
                }
            }
        } catch (e: IOException) {
            Log.w("Hakobu", "Couldn't read X's embed data", e)
            null
        }
    }

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
        val cookies = xAccount.tempCookies(url)
        try {
            return lookup(url, playlist, cookies)
        } finally {
            cookies?.delete()
        }
    }

    private suspend fun lookup(url: String, playlist: Boolean, cookies: File?): MediaInfo {
        fun request(syndication: Boolean) = YoutubeDLRequest(url)
            .addOption("--dump-single-json")
            .addOption("--flat-playlist")
            .addOption("--no-warnings")
            .addOption("--socket-timeout", if (isX(url)) "10" else "20")
            .apply { if (isX(url)) addOption("--extractor-retries", "1") }
            .addOption(if (playlist) "--yes-playlist" else "--no-playlist")
            .xCookies(url, cookies)
            // The embed API can't use a login, so a signed-in lookup stays on the main one.
            .apply { if (syndication) addOption("--extractor-args", SYNDICATION) }
        val out = try {
            runInterruptible(Dispatchers.IO) { YoutubeDL.execute(request(viaSyndication(url) && cookies == null), null, false, null).out }
        } catch (e: Exception) {
            if (e is CancellationException || !isX(url)) throw e
            Log.w("Hakobu", "X lookup failed: ${e.message?.take(200)}")
            // Photo posts and posts hidden behind X's login all land here; the embed data says which it is.
            if (X_NO_VIDEO.containsMatchIn(e.message.orEmpty())) {
                when (val post = xPost(url)) {
                    is XPost.Photos -> return MediaInfo(post.text.ifBlank { url }, post.user, post.urls.first(), null, "Twitter", false, null, post.urls.size)
                    XPost.LoginRequired -> throw IllegalStateException(if (cookies != null) MediaFormats.X_SIGNIN_REJECTED else MediaFormats.X_LOGIN_REQUIRED)
                    XPost.NoMedia -> throw IllegalStateException(MediaFormats.X_NO_MEDIA)
                    XPost.Gone -> throw IllegalStateException(MediaFormats.X_GONE)
                    XPost.HasVideo, null -> Unit
                }
            }
            if (cookies != null && X_REFUSED.containsMatchIn(e.message.orEmpty())) throw IllegalStateException(MediaFormats.X_SIGNIN_REJECTED, e)
            if (cookies != null || viaSyndication(url)) throw e
            if (TIMED_OUT.containsMatchIn(e.message.orEmpty())) xGuestApiStalled = true
            // X often stalls its guest API; its public embed (syndication) API still serves most posts.
            runInterruptible(Dispatchers.IO) { YoutubeDL.execute(request(true), null, false, null).out }.also { useSyndication += url }
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
        val cookies = xAccount.tempCookies(url)
        val req = YoutubeDLRequest(url)
            .xCookies(url, cookies)
            .addOption("-j")
            .addOption("-f", "bestaudio/best")
            .addOption("--no-playlist")
            .addOption("--no-warnings")
            .addOption("--socket-timeout", "20")
            .apply { if (viaSyndication(url) && cookies == null) addOption("--extractor-args", SYNDICATION) }
        val out = try {
            runInterruptible(Dispatchers.IO) { YoutubeDL.execute(req, null, false, null).out }
        } finally {
            cookies?.delete()
        }
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

    /** A photo post: yt-dlp only handles video, so fetch the images from the addresses in X's embed data. */
    private suspend fun downloadPhotos(item: DownloadItem, onProgress: (MediaProgress) -> Unit): List<MediaFile> {
        val post = xPost(item.source) as? XPost.Photos ?: throw IllegalStateException("Couldn't get this post's photos from X. Try again.")
        val dir = File(context.cacheDir, "media/${item.id}").apply { mkdirs() }
        val base = listOfNotNull(post.user, XPosts.statusId(item.source)).joinToString(" ")
        val files = post.urls.mapIndexed { i, url ->
            val ext = url.substringBefore('?').substringAfterLast('.', "jpg")
            val file = File(dir, if (post.urls.size > 1) "$base ${i + 1}.$ext" else "$base.$ext")
            runInterruptible(Dispatchers.IO) {
                client.newCall(Request.Builder().url(url).build()).execute().use { r ->
                    if (!r.isSuccessful) throw IOException("HTTP ${r.code} for photo ${i + 1}")
                    file.outputStream().use { out -> r.body!!.byteStream().copyTo(out) }
                }
            }
            onProgress(MediaProgress((i + 1.0) / post.urls.size, stage = "Photo ${i + 1} of ${post.urls.size}"))
            file
        }
        return moveToStore(item, dir, files)
    }

    override suspend fun download(item: DownloadItem, onProgress: (MediaProgress) -> Unit): List<MediaFile> {
        if (item.mediaFormat == MediaFormats.PHOTO) return downloadPhotos(item, onProgress)
        ensureReady()
        // Work in a private folder per item, so a paused download resumes from yt-dlp's .part files.
        val dir = File(context.cacheDir, "media/${item.id}").apply { mkdirs() }
        val cookies = xAccount.tempCookies(item.source)
        val req = YoutubeDLRequest(item.source)
            .xCookies(item.source, cookies)
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
            .apply { if (viaSyndication(item.source) && cookies == null) addOption("--extractor-args", SYNDICATION) }
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
            cookies?.delete()
        }

        val leftovers = setOf("part", "ytdl", "jpg", "jpeg", "webp", "png", "temp")
        val produced = dir.listFiles()?.filter { it.isFile && it.extension.lowercase() !in leftovers }?.sortedBy { it.name }.orEmpty()
        return moveToStore(item, dir, produced)
    }

    /** Move the results into Download/Hakobu (several files get their own folder). */
    private suspend fun moveToStore(item: DownloadItem, dir: File, produced: List<File>): List<MediaFile> {
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
