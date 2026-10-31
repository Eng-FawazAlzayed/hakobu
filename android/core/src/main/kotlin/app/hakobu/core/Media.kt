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
}

object MediaFormats {
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
        Regex("confirm you.?re not a bot|sign in to confirm", RegexOption.IGNORE_CASE) to "YouTube is asking to confirm you're not a bot (too many downloads from this connection). Wait a while and retry.",
        Regex("HTTP Error 429|Too Many Requests", RegexOption.IGNORE_CASE) to "YouTube is rate-limiting this connection (HTTP 429). Wait a bit and retry.",
        Regex("Private video", RegexOption.IGNORE_CASE) to "This video is private.",
        Regex("members-only|join this channel", RegexOption.IGNORE_CASE) to "This video is for channel members only.",
        Regex("age.?restricted|confirm your age|inappropriate for some users", RegexOption.IGNORE_CASE) to "This video is age-restricted.",
        Regex("Video unavailable|This video is not available|has been removed", RegexOption.IGNORE_CASE) to "This video is unavailable (removed, blocked in your country, or the link is wrong).",
        Regex("Unsupported URL", RegexOption.IGNORE_CASE) to "This site isn't supported.",
        Regex("""getaddrinfo|Unable to download webpage.*(timed out|resolve)|No address associated|Network is unreachable""", RegexOption.IGNORE_CASE) to "Can't reach the site: check your internet connection.",
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
