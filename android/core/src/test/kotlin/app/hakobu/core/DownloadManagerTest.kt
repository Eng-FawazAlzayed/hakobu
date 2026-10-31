package app.hakobu.core

import app.hakobu.core.debrid.DebridProvider
import app.hakobu.core.debrid.DebridUser
import app.hakobu.core.debrid.RemoteFile
import app.hakobu.core.debrid.RemoteProgress
import app.hakobu.core.debrid.TorrentJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import kotlin.random.Random
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DownloadManagerTest {
    private val payload = Random(1).nextBytes(12 * 1024 * 1024)
    private val server = MockWebServer()
    private var rangeRequests = 0
    private lateinit var tmp: File
    private val client = OkHttpClient()

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    @BeforeTest
    fun setUp() {
        tmp = Files.createTempDirectory("hakobu-test").toFile()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                val path = request.path.orEmpty()
                if (path.startsWith("/page")) return MockResponse().setHeader("Content-Type", "text/html").setBody("<html></html>")
                if (path.startsWith("/missing")) return MockResponse().setResponseCode(404)
                if (path.startsWith("/noname")) {
                    return MockResponse().setHeader("Content-Disposition", "attachment; filename=\"named by server.bin\"")
                        .setBody(Buffer().write(payload))
                }
                val m = Regex("""bytes=(\d+)-(\d*)""").find(request.getHeader("Range").orEmpty())
                    ?: return MockResponse().setBody(Buffer().write(payload))
                synchronized(this@DownloadManagerTest) { rangeRequests++ }
                val start = m.groupValues[1].toInt()
                val end = m.groupValues[2].takeIf { it.isNotEmpty() }?.toInt() ?: (payload.size - 1)
                return MockResponse().setResponseCode(206)
                    .setHeader("Content-Range", "bytes $start-$end/${payload.size}")
                    .setBody(Buffer().write(payload, start, end - start + 1))
                    .throttleBody(256 * 1024, 20, java.util.concurrent.TimeUnit.MILLISECONDS)
            }
        }
        server.start()
    }

    @AfterTest
    fun tearDown() {
        server.shutdown()
        tmp.deleteRecursively()
    }

    private fun manager(provider: DebridProvider? = null, settings: Settings = Settings(connectionsPerDownload = 4), media: MediaEngine? = null) = DownloadManager(
        client = client,
        store = LocalFileStore(File(tmp, "dl")),
        stateFile = File(tmp, "state.json"),
        hosters = HosterRegistry(client, null, tbUrl = server.url("/x").toString(), rdUrl = server.url("/x").toString(), rdDomainsUrl = server.url("/x").toString()),
        initialSettings = settings,
        providerFactory = { _, _ -> provider ?: error("no provider") },
        tickMs = 50,
        mediaEngine = media,
    )

    private suspend fun DownloadManager.waitFor(what: String, ms: Long = 30_000, cond: (List<DownloadItem>) -> Boolean) {
        try {
            withTimeout(ms) { while (!cond(itemsFlow.value)) delay(25) }
        } catch (e: Exception) {
            throw AssertionError("Timed out waiting for $what: ${itemsFlow.value}")
        }
    }

    private fun link(path: String) = ParsedLink(LinkKind.HTTP, server.url(path).toString(), path.trimStart('/'))

    @Test
    fun segmentedDownloadPausesAndResumes() = runBlocking {
        val m = manager()
        m.start()
        val item = m.add(listOf(AddRequest(link("/file.bin"))))[0]
        m.waitFor("progress") { it[0].downloaded > 1_000_000 }
        m.pause(item.id)
        val paused = m.itemsFlow.value[0]
        assertEquals(Status.PAUSED, paused.status)
        assertTrue(paused.downloaded < payload.size, "paused before the end")
        assertEquals(4, paused.segments.size)
        m.resume(item.id)
        m.waitFor("completion") { it[0].status == Status.COMPLETED }
        val done = File(tmp, "dl/file.bin")
        assertEquals(sha(payload), sha(done.readBytes()))
        assertTrue(!File(tmp, "dl/file.bin.part").exists())
        m.close()
        // State survives a restart.
        val m2 = manager()
        m2.start()
        assertEquals(Status.COMPLETED, m2.itemsFlow.value[0].status)
        m2.close()
    }

    @Test
    fun usesServerFilenameAndAvoidsClashes() = runBlocking {
        val m = manager()
        m.start()
        m.add(listOf(AddRequest(link("/noname"))))
        m.waitFor("first") { it.all { i -> i.status == Status.COMPLETED } }
        m.add(listOf(AddRequest(link("/noname"))))
        m.waitFor("second") { it.size == 2 && it.all { i -> i.status == Status.COMPLETED } }
        assertTrue(File(tmp, "dl/named by server.bin").exists())
        assertTrue(File(tmp, "dl/named by server (1).bin").exists())
        m.close()
    }

    @Test
    fun webPagesAndMissingFilesFail() = runBlocking {
        val m = manager()
        m.start()
        m.add(listOf(AddRequest(link("/page")), AddRequest(link("/missing"))))
        m.waitFor("failures") { it.size == 2 && it.all { i -> i.status == Status.FAILED } }
        val errors = m.itemsFlow.value.map { it.error.orEmpty() }
        assertTrue(errors.any { "web page" in it }, errors.toString())
        assertTrue(errors.any { "404" in it }, errors.toString())
        m.close()
    }

    @Test
    fun debridHandsOffDirectLinks() = runBlocking {
        val fake = object : DebridProvider {
            override val name = "Fake"
            var gotWanted: Set<String>? = null
            override suspend fun user() = DebridUser("me", true, null)
            override suspend fun resolveLink(link: String, remoteId: String?, onRemoteId: (String) -> Unit, onProgress: (RemoteProgress) -> Unit) =
                listOf(RemoteFile(server.url("/a.bin").toString(), "a.bin", payload.size.toLong()))
            override suspend fun resolveTorrent(job: TorrentJob, onRemoteId: (String) -> Unit, onProgress: (RemoteProgress) -> Unit): List<RemoteFile> {
                gotWanted = job.wanted
                onRemoteId("42")
                onProgress(RemoteProgress(0.5, "downloading", 1000, 3, "Linux ISO"))
                delay(100)
                return listOf(
                    RemoteFile(server.url("/one.bin").toString(), "one.bin", payload.size.toLong()),
                    RemoteFile(server.url("/two.bin").toString(), "two.bin", payload.size.toLong()),
                )
            }
        }
        val m = manager(fake, Settings(torboxKey = "k", connectionsPerDownload = 2))
        m.start()
        val magnet = LinkParser.parse("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567")[0]
        val parent = m.add(listOf(AddRequest(magnet, wantedFiles = setOf("one.bin|1"))))[0]
        assertEquals(Route.TORBOX, parent.via)
        m.waitFor("hand-off and children") { list ->
            list.find { it.id == parent.id }?.status == Status.HANDED_OFF &&
                list.count { it.parentId == parent.id && it.status == Status.COMPLETED } == 2
        }
        val p = m.itemsFlow.value.first { it.id == parent.id }
        assertEquals("Linux ISO", p.name)
        assertEquals("42", p.remoteId)
        assertEquals(setOf("one.bin|1"), fake.gotWanted)
        // Several files go into a package folder named after the torrent.
        assertEquals(sha(payload), sha(File(tmp, "dl/Linux ISO/one.bin").readBytes()))
        assertTrue(File(tmp, "dl/Linux ISO/two.bin").exists())
        m.close()
    }

    @Test
    fun routing() = runBlocking {
        val m = manager(settings = Settings())
        val magnet = LinkParser.parse("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567")[0]
        val yt = LinkParser.parse("https://youtu.be/dQw4w9WgXcQ")[0]
        val mega = LinkParser.parse("https://mega.nz/file/abc")[0]
        assertEquals(null, m.defaultRoute(magnet))
        assertEquals(null, m.defaultRoute(yt))
        assertEquals(Route.DIRECT, m.defaultRoute(mega))
        m.updateSettings { it.copy(realdebridToken = "t") }
        assertEquals(Route.REALDEBRID, m.defaultRoute(magnet))
        assertEquals(Route.REALDEBRID, m.defaultRoute(mega))
        m.start()
        val added = m.add(listOf(AddRequest(yt)))
        assertEquals(Status.FAILED, added[0].status)
        m.close()
    }

    @Test
    fun mediaGoesThroughTheEngine() = runBlocking {
        var seen: DownloadItem? = null
        val engine = object : MediaEngine {
            override suspend fun info(url: String, playlist: Boolean) = MediaInfo("Title", "Chan", null, 60, "YouTube", false, null)
            override suspend fun download(item: DownloadItem, onProgress: (MediaProgress) -> Unit): List<MediaFile> {
                seen = item
                onProgress(MediaProgress(0.5, 1000, 3, 2000, "Merging audio & video"))
                delay(200)
                if (item.mediaFormat == "mp3") throw RuntimeException("ERROR: [youtube] abc: Private video")
                return listOf(MediaFile("ref://1", "Title.mp4", 2000))
            }
        }
        val m = manager(settings = Settings(ytVideoQuality = "720"), media = engine)
        m.start()
        val yt = LinkParser.parse("https://youtu.be/dQw4w9WgXcQ")[0]
        val item = m.add(listOf(AddRequest(yt, thumbnail = "https://img/x.jpg")))[0]
        assertEquals(Route.YTDLP, item.via)
        assertEquals("mp4", item.mediaFormat)
        assertEquals("720", item.mediaQuality)
        m.waitFor("progress") { it[0].remoteState == "Merging audio & video" }
        assertEquals(0.5, m.itemsFlow.value[0].progress)
        m.waitFor("done") { it[0].status == Status.COMPLETED }
        val done = m.itemsFlow.value[0]
        assertEquals("Title.mp4", done.name)
        assertEquals("ref://1", done.storeRef)
        assertEquals("https://img/x.jpg", seen?.thumbnail)
        m.add(listOf(AddRequest(yt, mediaFormat = "mp3", mediaQuality = "320")))
        m.waitFor("failure") { it.any { i -> i.status == Status.FAILED } }
        assertEquals("This video is private.", m.itemsFlow.value.first { it.status == Status.FAILED }.error)
        m.close()
    }

    @Test
    fun mediaErrorsAndProgressLines() {
        assertEquals("That quality isn't available for this video.", MediaFormats.friendlyError("ERROR: [youtube] x: Requested format is not available"))
        assertEquals("Something odd", MediaFormats.friendlyError("WARNING: a\nERROR: [generic] id: Something odd"))
        val line = "[download]  45.3% of ~ 120.00MiB at  2.50MiB/s ETA 00:30"
        assertEquals((2.5 * 1024 * 1024).toLong(), MediaFormats.speedOf(line))
        assertEquals((120.0 * 1024 * 1024).toLong(), MediaFormats.totalOf(line))
        assertEquals("Merging audio & video", MediaFormats.stageOf("[Merger] Merging formats into \"a.mp4\""))
        assertEquals("Converting to MP3", MediaFormats.stageOf("[ExtractAudio] Destination: a.mp3"))
        assertEquals("Item 3 of 12", MediaFormats.itemOf("[download] Downloading item 3 of 12"))
    }
}
