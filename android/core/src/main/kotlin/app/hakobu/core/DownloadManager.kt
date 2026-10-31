package app.hakobu.core

import app.hakobu.core.debrid.DebridProvider
import app.hakobu.core.debrid.RealDebrid
import app.hakobu.core.debrid.TorBox
import app.hakobu.core.debrid.TorrentJob
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.Base64
import java.util.UUID

/** What the LinkGrabber hands the manager. */
data class AddRequest(
    val link: ParsedLink,
    val via: Route = Route.AUTO,
    val folder: String = "",
    val packageName: String? = null,
    val suggestedName: String? = null,
    val torrentBytes: ByteArray? = null,
    val headers: Map<String, String> = emptyMap(),
    /** Only for torrents sent to debrid: fileKey()s to keep. */
    val wantedFiles: Set<String>? = null,
    /** Media links: "mp4"/"mp3" and quality; null = the defaults from Settings. */
    val mediaFormat: String? = null,
    val mediaQuality: String? = null,
    val thumbnail: String? = null,
    val uploader: String? = null,
)

@Serializable
private data class SavedState(val items: List<DownloadItem>)

/**
 * Queue + scheduler that ties the HTTP engine and the debrid services together. Port of the core of
 * src/engine/manager.js. All state lives on one single-threaded dispatcher; transfers run on IO.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class DownloadManager(
    private val client: OkHttpClient,
    private val store: FileStore,
    private val stateFile: File?,
    val hosters: HosterRegistry,
    initialSettings: Settings = Settings(),
    private val providerFactory: (Route, Settings) -> DebridProvider = { r, s ->
        if (r == Route.TORBOX) TorBox(s.torboxKey, client) else RealDebrid(s.realdebridToken, client)
    },
    private val onFinished: (DownloadItem) -> Unit = {},
    private val mediaEngine: MediaEngine? = null,
    private val tickMs: Long = 500,
) {
    private val state = Dispatchers.IO.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + state)
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    private val limiter = RateLimiter(initialSettings.speedLimitKB * 1024L)
    private val engine = HttpEngine(client, limiter)
    private val items = LinkedHashMap<String, DownloadItem>()
    private val jobs = HashMap<String, Job>()
    private val wanted = HashMap<String, Set<String>>()
    private var dirty = false
    private var lastSave = 0L

    var settings: Settings = initialSettings
        private set

    private val _items = MutableStateFlow<List<DownloadItem>>(emptyList())

    /** Snapshot of every item, newest first, refreshed every tick. */
    val itemsFlow: StateFlow<List<DownloadItem>> = _items.asStateFlow()

    val checker by lazy { LinkChecker(engine, RealDebrid("", client), hosters) }

    suspend fun start() = withContext(state) {
        stateFile?.takeIf { it.exists() }?.let { f ->
            runCatching { json.decodeFromString<SavedState>(f.readText()) }.getOrNull()?.items?.forEach { items[it.id] = it }
        }
        for (it in items.values) {
            if (it.status == Status.ACTIVE || it.status == Status.RESOLVING) it.status = Status.QUEUED
            it.speed = 0
        }
        publish()
        schedule()
        scope.launch { ticker() }
        scope.launch(Dispatchers.IO) { runCatching { hosters.refresh() } }
    }

    fun close() {
        scope.cancel()
        runCatching { save() }
    }

    suspend fun updateSettings(transform: (Settings) -> Settings) = withContext(state) {
        settings = transform(settings)
        limiter.setRate(settings.speedLimitKB * 1024L)
        schedule()
    }

    // ---------- routing ----------

    /** How a link is downloaded when the user didn't pick explicitly. Null = not possible yet on Android. */
    fun defaultRoute(link: ParsedLink): Route? {
        val s = settings
        return when (link.kind) {
            LinkKind.MEDIA -> if (mediaEngine != null) Route.YTDLP else null
            LinkKind.TORRENT -> if (s.torrentRoute == Route.AUTO || s.torrentRoute == Route.P2P) s.configuredDebrid() else s.torrentRoute
            LinkKind.HTTP -> {
                if (s.httpRoute != Route.AUTO) return s.httpRoute
                val configured = hosters.providersFor(link.source).filter {
                    (it.provider == Route.TORBOX && s.hasTorBox) || (it.provider == Route.REALDEBRID && s.hasRealDebrid)
                }
                if (configured.isNotEmpty()) {
                    return (configured.find { it.provider == s.preferredDebrid && it.up } ?: configured.find { it.up } ?: configured[0]).provider
                }
                if ((link.hoster || LinkParser.isHoster(link.source)) && hosters.data.updated == 0L) s.configuredDebrid() ?: Route.DIRECT else Route.DIRECT
            }
        }
    }

    /** Why a link can't be downloaded with the current setup, or null when it can. */
    fun blocker(link: ParsedLink, via: Route): String? = when {
        link.kind == LinkKind.MEDIA && mediaEngine == null -> "YouTube and media sites aren't supported in this build."
        link.kind == LinkKind.MEDIA -> null
        via == Route.TORBOX && !settings.hasTorBox -> "Add your TorBox API key in Settings."
        via == Route.REALDEBRID && !settings.hasRealDebrid -> "Add your Real-Debrid token in Settings."
        link.kind == LinkKind.TORRENT && !via.isDebrid -> "Torrents need TorBox or Real-Debrid for now (P2P is coming). Add a key in Settings."
        else -> null
    }

    // ---------- adding / controls ----------

    suspend fun add(requests: List<AddRequest>): List<DownloadItem> = withContext(state) {
        val added = mutableListOf<DownloadItem>()
        for (r in requests) {
            val via = if (r.via == Route.AUTO || r.link.kind == LinkKind.MEDIA) defaultRoute(r.link) else r.via
            val fmt = if (r.link.kind == LinkKind.MEDIA) r.mediaFormat ?: settings.ytFormat else null
            val quality = if (fmt == null) null else r.mediaQuality ?: if (fmt == "mp3") settings.ytAudioQuality else settings.ytVideoQuality
            val item = DownloadItem(
                id = UUID.randomUUID().toString(),
                kind = r.link.kind,
                via = via ?: Route.DIRECT,
                source = r.link.source,
                name = r.link.name,
                folder = r.folder,
                packageName = r.packageName,
                suggestedName = r.suggestedName,
                headers = r.headers,
                torrentB64 = r.torrentBytes?.let { Base64.getEncoder().encodeToString(it) },
                mediaFormat = fmt,
                mediaQuality = quality,
                thumbnail = r.thumbnail,
                uploader = r.uploader,
                playlist = r.link.playlist,
            )
            val problem = if (via == null) blocker(r.link, Route.AUTO) ?: "Can't download this link." else blocker(r.link, via)
            if (problem != null) {
                item.status = Status.FAILED
                item.error = problem
            }
            r.wantedFiles?.let { wanted[item.id] = it }
            items[item.id] = item
            added.add(item)
        }
        dirty = true
        schedule()
        publish()
        added
    }

    suspend fun pause(id: String) = withContext(state) {
        val it = items[id] ?: return@withContext
        if (it.status in setOf(Status.COMPLETED, Status.HANDED_OFF, Status.FAILED)) return@withContext
        it.status = Status.PAUSED // set first so the cancelled job knows it was a pause
        jobs.remove(id)?.cancelAndJoin()
        it.speed = 0
        if (it.via == Route.DIRECT) it.downloaded = it.segments.sumOf { s -> s.done }
        dirty = true
        schedule()
        publish()
    }

    suspend fun resume(id: String) = withContext(state) {
        val it = items[id] ?: return@withContext
        if (it.status != Status.PAUSED && it.status != Status.FAILED) return@withContext
        it.status = Status.QUEUED
        it.error = null
        dirty = true
        schedule()
        publish()
    }

    suspend fun pauseAll() = withContext(state) {
        items.values.filter { it.status == Status.QUEUED || it.status == Status.ACTIVE || it.status == Status.RESOLVING }.map { it.id }
    }.forEach { pause(it) }

    suspend fun resumeAll() = withContext(state) { items.values.filter { it.status == Status.PAUSED }.map { it.id } }.forEach { resume(it) }

    suspend fun remove(id: String, deleteFile: Boolean) = withContext(state) {
        val it = items[id] ?: return@withContext
        val finished = it.status == Status.COMPLETED
        it.status = Status.PAUSED
        jobs.remove(id)?.cancelAndJoin()
        val ref = it.storeRef
        if (ref != null && (deleteFile || !finished)) {
            // An unfinished partial file is useless on its own, so it goes too.
            withContext(Dispatchers.IO) { runCatching { store.delete(ref) } }
        }
        items.remove(id)
        wanted.remove(id)
        dirty = true
        schedule()
        publish()
    }

    suspend fun clearFinished() = withContext(state) {
        items.values.removeAll { it.status == Status.COMPLETED || it.status == Status.HANDED_OFF }
        dirty = true
        publish()
    }

    // ---------- scheduling ----------

    private fun schedule() {
        val all = items.values.sortedBy { it.createdAt }
        var active = all.count { it.status == Status.ACTIVE && !it.via.isDebrid }
        for (it in all) {
            if (it.status != Status.QUEUED) continue
            if (it.via.isDebrid) startDebrid(it)
            else if (active < settings.maxActive) {
                active++
                if (it.via == Route.YTDLP) startMedia(it) else startHttp(it)
            }
        }
    }

    private fun startHttp(it: DownloadItem) {
        it.status = Status.ACTIVE
        it.error = null
        jobs[it.id] = scope.launch {
            try {
                engine.download(it, store, settings.connectionsPerDownload)
                it.status = Status.COMPLETED
                it.finishedAt = System.currentTimeMillis()
                it.speed = 0
                runCatching { onFinished(it.copy()) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(it, e)
            } finally {
                if (jobs[it.id] == coroutineContext[Job]) jobs.remove(it.id)
                dirty = true
                schedule()
                publish()
            }
        }
    }

    private fun startMedia(it: DownloadItem) {
        val engine = mediaEngine ?: return fail(it, IllegalStateException("Media downloads aren't available in this build."))
        it.status = Status.ACTIVE
        it.error = null
        jobs[it.id] = scope.launch {
            try {
                val files = engine.download(it) { p ->
                    // Progress arrives on yt-dlp's reader thread: apply it on the state thread.
                    scope.launch {
                        if (it.status != Status.ACTIVE) return@launch
                        it.remoteProgress = p.fraction
                        it.speed = p.speed
                        it.remoteState = p.stage
                        p.totalBytes?.let { t -> it.size = t; it.downloaded = (t * p.fraction).toLong() }
                    }
                }
                if (files.isEmpty()) throw IllegalStateException("yt-dlp finished without a file")
                it.storeRef = files[0].ref
                it.fileCount = files.size
                if (files.size == 1) {
                    it.filename = files[0].name
                    it.name = files[0].name
                }
                it.size = files.sumOf { f -> f.size ?: 0 }.takeIf { s -> s > 0 }
                it.downloaded = it.size ?: 0
                it.remoteProgress = 1.0
                it.remoteState = null
                it.status = Status.COMPLETED
                it.finishedAt = System.currentTimeMillis()
                it.speed = 0
                runCatching { onFinished(it.copy()) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(it, e)
                it.error = MediaFormats.friendlyError(e.message)
            } finally {
                if (jobs[it.id] == coroutineContext[Job]) jobs.remove(it.id)
                dirty = true
                schedule()
                publish()
            }
        }
    }

    /** Title, thumbnail and length of a media link for the media screen. */
    suspend fun mediaInfo(url: String, playlist: Boolean): MediaInfo {
        val engine = mediaEngine ?: throw IllegalStateException("Media downloads aren't available in this build.")
        return try {
            engine.info(url, playlist)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw IllegalStateException(MediaFormats.friendlyError(e.message), e)
        }
    }

    private fun startDebrid(it: DownloadItem) {
        it.status = Status.RESOLVING
        it.error = null
        jobs[it.id] = scope.launch {
            try {
                val provider = providerFactory(it.via, settings)
                val onRemoteId = { id: String -> it.remoteId = id; dirty = true }
                val onProgress = { p: app.hakobu.core.debrid.RemoteProgress ->
                    it.remoteProgress = p.progress
                    it.remoteState = p.state
                    it.speed = p.speed
                    if (p.name != null && (it.name == it.source || it.name == LinkParser.infoHashFromMagnet(it.source))) it.name = p.name
                }
                val files = if (it.kind == LinkKind.TORRENT) {
                    val bytes = it.torrentB64?.let { b -> Base64.getDecoder().decode(b) }
                        ?: if (it.source.startsWith("http", ignoreCase = true)) fetchBytes(it.source) else null
                    provider.resolveTorrent(TorrentJob(magnet = it.source.takeIf { bytes == null }, torrent = bytes, remoteId = it.remoteId, wanted = wanted[it.id]), onRemoteId, onProgress)
                } else {
                    provider.resolveLink(it.source, it.remoteId, onRemoteId, onProgress)
                }
                val pkg = Names.sanitize(it.packageName ?: it.name)
                val folder = if (files.size > 1) listOf(it.folder, pkg).filter { f -> f.isNotEmpty() }.joinToString("/") else it.folder
                val children = files.map { f ->
                    DownloadItem(
                        id = UUID.randomUUID().toString(),
                        kind = LinkKind.HTTP,
                        via = Route.DIRECT,
                        source = f.url,
                        name = f.filename ?: LinkParser.nameFromUrl(f.url),
                        folder = folder,
                        packageName = pkg,
                        suggestedName = f.filename,
                        size = f.size,
                        parentId = it.id,
                    )
                }
                children.forEach { c -> items[c.id] = c }
                it.childIds = children.map { c -> c.id }
                it.status = Status.HANDED_OFF
                it.remoteProgress = 1.0
                it.speed = 0
                it.finishedAt = System.currentTimeMillis()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(it, e)
            } finally {
                if (jobs[it.id] == coroutineContext[Job]) jobs.remove(it.id)
                dirty = true
                schedule()
                publish()
            }
        }
    }

    private suspend fun fetchBytes(url: String): ByteArray = withContext(Dispatchers.IO) {
        client.newCall(Request.Builder().url(url).header("User-Agent", USER_AGENT).build()).await().use { res ->
            if (!res.isSuccessful) throw HttpStatusException(res.code, res.message)
            res.body!!.bytes()
        }
    }

    private fun fail(it: DownloadItem, e: Exception) {
        it.status = Status.FAILED
        it.speed = 0
        it.error = e.message ?: e.javaClass.simpleName
    }

    // ---------- progress / persistence ----------

    private suspend fun ticker() {
        val lastBytes = HashMap<String, Long>()
        var lastTime = System.nanoTime()
        while (scope.isActive) {
            delay(tickMs)
            val now = System.nanoTime()
            val secs = (now - lastTime) / 1e9
            lastTime = now
            for (it in items.values) {
                if (it.status != Status.ACTIVE || it.via != Route.DIRECT) continue
                it.downloaded = it.segments.sumOf { s -> s.done }
                val prev = lastBytes[it.id]
                if (prev != null && secs > 0) {
                    val inst = ((it.downloaded - prev) / secs).toLong().coerceAtLeast(0)
                    it.speed = if (it.speed == 0L) inst else (it.speed * 0.6 + inst * 0.4).toLong()
                }
                lastBytes[it.id] = it.downloaded
                dirty = true
            }
            lastBytes.keys.retainAll { id -> items[id]?.status == Status.ACTIVE }
            if (items.values.any { it.status == Status.ACTIVE }) dirty = true
            publish()
            if (dirty && System.currentTimeMillis() - lastSave > 2000) save()
        }
    }

    private fun publish() {
        _items.value = items.values.map { it.copy() }.sortedByDescending { it.createdAt }
    }

    private fun save() {
        dirty = false
        lastSave = System.currentTimeMillis()
        val f = stateFile ?: return
        val tmp = File(f.path + ".tmp")
        tmp.writeText(json.encodeToString(SavedState.serializer(), SavedState(items.values.toList())))
        if (!tmp.renameTo(f)) {
            f.delete()
            tmp.renameTo(f)
        }
    }

    /** Persist now (the app calls this when it goes to the background). */
    suspend fun flush() = withContext(state) { save() }
}
