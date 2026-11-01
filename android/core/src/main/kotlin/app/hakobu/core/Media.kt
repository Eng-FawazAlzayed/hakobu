package app.hakobu.core

/** What the media screen shows before downloading. */
data class MediaInfo(
    val title: String,
    val uploader: String?,
    val thumbnail: String?,
    val durationSec: Int?,
    val site: String?,
    val isPlaylist: Boolean,
    val entries: Int?,
    /** A post with only photos; downloaded with mediaFormat = [MediaFormats.PHOTO]. */
    val photoCount: Int = 0,
)

data class MediaProgress(
    /** 0..1 */
    val fraction: Double,
    val speed: Long = 0,
    val etaSec: Long? = null,
    val totalBytes: Long? = null,
    /** "Merging audio & video", "Item 3 of 12"... */
    val stage: String? = null,
)

/** A finished file, already in the download store. */
data class MediaFile(val ref: String, val name: String, val size: Long?)

/** YouTube and ~1,800 other sites, through yt-dlp. The Android app provides the implementation. */
interface MediaEngine {
    suspend fun info(url: String, playlist: Boolean): MediaInfo

    /** Downloads [item] and moves the result into the store. Cancel the coroutine to pause. */
    suspend fun download(item: DownloadItem, onProgress: (MediaProgress) -> Unit): List<MediaFile>

    /** Throw away what an unfinished download of [id] left behind. */
    fun discard(id: String) {}
}

object MediaFormats {
    const val PHOTO = "photo"
    const val X_LOGIN_REQUIRED = "x-login-required"
    const val X_NO_MEDIA = "x-no-media"
    const val X_GONE = "x-gone"
    const val X_SIGNIN_REJECTED = "x-signin-rejected"
    private const val X_SIGN_IN_MESSAGE = "X only shows this post to signed-in accounts, usually because it's age-restricted. Sign in to X to download it."
    private const val X_REJECTED_MESSAGE = "X still won't show this post. Your sign-in may have expired, or it's an age-restricted post with only photos, which Hakobu can't fetch yet. Try signing in again."

    /** An error the "Sign in to X" button can help with. */
    fun needsXSignIn(error: String?) = error == X_SIGN_IN_MESSAGE || error == X_REJECTED_MESSAGE

    val VIDEO_QUALITIES = listOf("2160", "1440", "1080", "720", "480")
    val AUDIO_QUALITIES = listOf("320", "256", "192", "128")

    fun videoLabel(q: String) = if (q == "2160") "4K" else "${q}p"

    /** yt-dlp options for a format choice (same choices as the desktop app). */
    fun args(format: String, quality: String): List<String> = if (format == "mp3") {
        listOf("-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", "${quality}K")
    } else {
        val h = if (quality == "best") "" else "[height<=$quality]"
        listOf("-f", "bv*$h[ext=mp4]+ba[ext=m4a]/bv*$h+ba/b$h/b", "--merge-output-format", "mp4")
    }

    /** 75.5 -> "1:15", 3725 -> "1:02:05". */
    fun clock(sec: Double): String {
        val t = sec.coerceAtLeast(0.0).toLong()
        val h = t / 3600
        return if (h > 0) "%d:%02d:%02d".format(h, t % 3600 / 60, t % 60) else "%d:%02d".format(t / 60, t % 60)
    }

    /** "0:30–0:45" for a valid section, else null (whole track). */
    fun clipLabel(start: Double?, end: Double?): String? =
        if (start == null || end == null || start < 0 || end <= start) null else "${clock(start)}–${clock(end)}"

    /** yt-dlp options that cut the download to [start]..[end] seconds; empty for the whole track. */
    fun sectionArgs(start: Double?, end: Double?): List<String> {
        if (clipLabel(start, end) == null) return emptyList()
        fun s(v: Double) = "%.3f".format(java.util.Locale.ROOT, v).trimEnd('0').trimEnd('.')
        return listOf("--download-sections", "*${s(start!!)}-${s(end!!)}", "--force-keyframes-at-cuts")
    }

    private val YOUTUBE = Regex("""^https?://([\w-]+\.)*(youtube\.com|youtu\.be|youtube-nocookie\.com)/""", RegexOption.IGNORE_CASE)
    private val NETWORK_ERROR = Regex("""timed out|timeout|Unable to download (JSON metadata|webpage)|connection reset|Remote end closed|getaddrinfo|Name or service not known|Temporary failure in name|No address associated|Network is unreachable""", RegexOption.IGNORE_CASE)

    /**
     * The preview only needs the title, picture and length. YouTube's VR client gives those in about 4 s instead of
     * 15-25 s, because it needs no player code solved. Its format list is short, so downloads use the full lookup.
     */
    fun fastLookupArgs(url: String, playlist: Boolean): List<String> =
        if (!playlist && YOUTUBE.containsMatchIn(url)) listOf("--extractor-args", "youtube:player_client=android_vr") else emptyList()

    /** A failure worth one quiet retry: the site was out of reach, not refusing. */
    fun isNetworkError(message: String?) = NETWORK_ERROR.containsMatchIn(message.orEmpty())

    private val PP_LABEL = mapOf(
        "ExtractAudio" to "Converting to MP3",
        "Merger" to "Merging audio & video",
        "EmbedThumbnail" to "Adding cover art",
        "ThumbnailsConvertor" to "Preparing cover art",
        "Metadata" to "Writing tags",
        "MoveFiles" to "Finishing",
        "VideoRemuxer" to "Remuxing",
        "FixupM3u8" to "Fixing stream",
    )

    /** "[Merger] Merging formats into ..." -> "Merging audio & video". */
    fun stageOf(line: String): String? {
        val tag = Regex("""^\[(?:FFmpeg)?(\w+)]""").find(line)?.groupValues?.get(1) ?: return null
        return PP_LABEL[tag]
    }

    private val SIZE = Regex("""of\s+~?\s*([\d.]+)\s*([KMGT]?i?B)""")
    private val SPEED = Regex("""at\s+([\d.]+)\s*([KMGT]?i?B)/s""")
    private val ITEM = Regex("""Downloading (?:item|video) (\d+) of (\d+)""")

    private fun bytes(n: String, unit: String): Long? {
        val v = n.toDoubleOrNull() ?: return null
        val mult = when (unit.uppercase().first()) {
            'K' -> 1024.0
            'M' -> 1024.0 * 1024
            'G' -> 1024.0 * 1024 * 1024
            'T' -> 1024.0 * 1024 * 1024 * 1024
            else -> 1.0
        }
        return (v * mult).toLong()
    }

    fun speedOf(line: String): Long? = SPEED.find(line)?.let { bytes(it.groupValues[1], it.groupValues[2]) }
    fun totalOf(line: String): Long? = SIZE.find(line)?.let { bytes(it.groupValues[1], it.groupValues[2]) }
    fun itemOf(line: String): String? = ITEM.find(line)?.let { "Item ${it.groupValues[1]} of ${it.groupValues[2]}" }

    private val RULES = listOf(
        Regex("$X_LOGIN_REQUIRED|NSFW tweet requires authentication") to X_SIGN_IN_MESSAGE,
        Regex("$X_SIGNIN_REJECTED|Could not authenticate you", RegexOption.IGNORE_CASE) to X_REJECTED_MESSAGE,
        Regex(X_NO_MEDIA) to "This X post has no video or photos to download.",
        Regex(X_GONE) to "This X post is gone: it was deleted, or the link is wrong.",
        Regex("confirm you.?re not a bot|sign in to confirm", RegexOption.IGNORE_CASE) to "YouTube is asking to confirm you're not a bot (too many downloads from this connection). Wait a while and retry.",
        Regex("HTTP Error 429|Too Many Requests", RegexOption.IGNORE_CASE) to "YouTube is rate-limiting this connection (HTTP 429). Wait a bit and retry.",
        Regex("Private video", RegexOption.IGNORE_CASE) to "This video is private.",
        Regex("members-only|join this channel", RegexOption.IGNORE_CASE) to "This video is for channel members only.",
        Regex("age.?restricted|confirm your age|inappropriate for some users", RegexOption.IGNORE_CASE) to "This video is age-restricted.",
        Regex("Video unavailable|This video is not available|has been removed", RegexOption.IGNORE_CASE) to "This video is unavailable (removed, blocked in your country, or the link is wrong).",
        Regex("No video could be found in this tweet|Requested tweet is unavailable", RegexOption.IGNORE_CASE) to "X didn't give us a video for this post. It may only have text, or X may only show it to signed-in accounts (age-restricted, protected or deleted posts).",
        Regex("Unsupported URL", RegexOption.IGNORE_CASE) to "This site isn't supported.",
        Regex("""getaddrinfo|Unable to download (webpage|JSON metadata).*(timed out|resolve)|No address associated|Network is unreachable""", RegexOption.IGNORE_CASE) to "Can't reach the site: check your internet connection.",
        Regex("Requested format is not available", RegexOption.IGNORE_CASE) to "That quality isn't available for this video.",
        Regex("n challenge|signature (extraction|solving) failed|js runtime", RegexOption.IGNORE_CASE) to "YouTube changed something. Update yt-dlp in Settings and retry.",
    )

    /** Raw yt-dlp errors -> plain language. Port of media.js friendlyError. */
    fun friendlyError(raw: String?): String {
        val s = raw.orEmpty()
        RULES.firstOrNull { it.first.containsMatchIn(s) }?.let { return it.second }
        val lines = s.lines().filter { it.isNotBlank() }
        val line = lines.lastOrNull { "ERROR:" in it } ?: lines.lastOrNull() ?: "Download failed"
        return line.replace(Regex("""^.*?ERROR:\s*"""), "").replace(Regex("""^\[[^\]]+]\s*[\w-]+:\s*"""), "").take(300)
    }
}
