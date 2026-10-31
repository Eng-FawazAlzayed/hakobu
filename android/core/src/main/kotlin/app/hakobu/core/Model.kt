package app.hakobu.core

import kotlinx.serialization.Serializable

/** How an item is fetched. AUTO is only used when adding; items always store the resolved route. */
@Serializable
enum class Route { AUTO, DIRECT, TORBOX, REALDEBRID, P2P, YTDLP;

    val isDebrid get() = this == TORBOX || this == REALDEBRID
    val label get() = when (this) {
        AUTO -> "Auto"
        DIRECT -> "Direct"
        TORBOX -> "TorBox"
        REALDEBRID -> "Real-Debrid"
        P2P -> "P2P"
        YTDLP -> "Media"
    }
}

@Serializable
enum class Status { QUEUED, ACTIVE, RESOLVING, PAUSED, COMPLETED, FAILED, HANDED_OFF }

@Serializable
data class DownloadItem(
    val id: String,
    val kind: LinkKind,
    var via: Route,
    val source: String,
    var name: String,
    /** Subfolder under the download root ("" = the root). */
    val folder: String = "",
    val packageName: String? = null,
    val suggestedName: String? = null,
    val headers: Map<String, String> = emptyMap(),
    /** A .torrent file's bytes (base64) for debrid upload. */
    val torrentB64: String? = null,
    var filename: String? = null,
    var storeRef: String? = null,
    var size: Long? = null,
    var downloaded: Long = 0,
    /** 0..1 progress of the cloud side for debrid items. */
    var remoteProgress: Double = 0.0,
    var remoteState: String? = null,
    var remoteId: String? = null,
    var speed: Long = 0,
    var status: Status = Status.QUEUED,
    var error: String? = null,
    var resumable: Boolean = false,
    var probed: Boolean = false,
    var segments: List<Segment> = emptyList(),
    val parentId: String? = null,
    var childIds: List<String> = emptyList(),
    val createdAt: Long = System.currentTimeMillis(),
    var finishedAt: Long? = null,
    /** Media (yt-dlp) items: "mp4" or "mp3", and the height or kbps. */
    val mediaFormat: String? = null,
    val mediaQuality: String? = null,
    val thumbnail: String? = null,
    val uploader: String? = null,
    val playlist: Boolean = false,
    var fileCount: Int = 0,
) {
    val progress: Double
        get() = when {
            status == Status.COMPLETED || status == Status.HANDED_OFF -> 1.0
            via.isDebrid || via == Route.YTDLP -> remoteProgress
            size != null && size!! > 0 -> (downloaded.toDouble() / size!!).coerceIn(0.0, 1.0)
            else -> 0.0
        }
}

@Serializable
data class Settings(
    val maxActive: Int = 3,
    val connectionsPerDownload: Int = 8,
    /** Global download limit in KB/s, 0 = unlimited. */
    val speedLimitKB: Int = 0,
    /** Route for links with no explicit choice: AUTO picks a debrid service for hoster links. */
    val httpRoute: Route = Route.AUTO,
    /** Torrents need a debrid service until P2P lands on Android; AUTO = the preferred configured one. */
    val torrentRoute: Route = Route.AUTO,
    val preferredDebrid: Route = Route.TORBOX,
    val torboxKey: String = "",
    val realdebridToken: String = "",
    /** Media defaults: "mp4" or "mp3", video height, audio kbps. */
    val ytFormat: String = "mp4",
    val ytVideoQuality: String = "1080",
    val ytAudioQuality: String = "192",
) {
    val hasTorBox get() = torboxKey.isNotBlank()
    val hasRealDebrid get() = realdebridToken.isNotBlank()

    /** The preferred debrid service that has a key, else any configured one. */
    fun configuredDebrid(): Route? = when {
        preferredDebrid == Route.TORBOX && hasTorBox -> Route.TORBOX
        preferredDebrid == Route.REALDEBRID && hasRealDebrid -> Route.REALDEBRID
        hasTorBox -> Route.TORBOX
        hasRealDebrid -> Route.REALDEBRID
        else -> null
    }
}
