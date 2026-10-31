package app.hakobu.core

import app.hakobu.core.debrid.RealDebrid
import app.hakobu.core.debrid.TorBox
import app.hakobu.core.debrid.TorrentJob
import app.hakobu.core.debrid.fileKey
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class DebridTest {
    private val server = MockWebServer()
    private val client = OkHttpClient()
    private val log = mutableListOf<String>()

    @AfterTest
    fun tearDown() = server.shutdown()

    private fun serve(handler: (RecordedRequest) -> String?) {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                synchronized(log) { log.add("${request.method} ${request.path}") }
                val body = handler(request) ?: return MockResponse().setResponseCode(404).setBody("""{"error":"nope"}""")
                return MockResponse().setHeader("Content-Type", "application/json").setBody(body)
            }
        }
        server.start()
    }

    @Test
    fun torBoxTorrentWithFileSelection() = runBlocking {
        var polls = 0
        serve { r ->
            assertEquals("Bearer key", r.getHeader("Authorization"))
            val p = r.path!!
            when {
                p.startsWith("/torrents/createtorrent") -> {
                    assertTrue(r.body.readUtf8().contains("magnet:?xt=urn:btih:abc"))
                    """{"success":true,"data":{"torrent_id":7}}"""
                }
                p.startsWith("/torrents/mylist") -> if (++polls < 2)
                    """{"success":true,"data":{"download_state":"downloading","progress":0.4,"download_speed":100,"name":"Pack"}}"""
                else """{"success":true,"data":{"download_finished":true,"files":[
                        {"id":1,"short_name":"a.mkv","size":10},{"id":2,"short_name":"b.nfo","size":2}]}}"""
                p.startsWith("/torrents/requestdl") -> {
                    assertTrue("file_id=1" in p && "torrent_id=7" in p)
                    """{"success":true,"data":"https://cdn.example/a.mkv"}"""
                }
                else -> null
            }
        }
        val tb = TorBox("key", client, server.url("").toString().trimEnd('/'), pollMs = 10)
        val ids = mutableListOf<String>()
        val progress = mutableListOf<Double>()
        val files = tb.resolveTorrent(TorrentJob(magnet = "magnet:?xt=urn:btih:abc", wanted = setOf(fileKey("x/a.mkv", 10))), { ids.add(it) }, { progress.add(it.progress) })
        assertEquals(listOf("7"), ids)
        assertEquals(listOf(0.4), progress)
        assertEquals(1, files.size)
        assertEquals("https://cdn.example/a.mkv", files[0].url)
        assertEquals("a.mkv", files[0].filename)
    }

    @Test
    fun torBoxErrorsAreReadable() = runBlocking {
        serve { """{"success":false,"detail":"Bad token"}""" }
        val tb = TorBox("key", client, server.url("").toString().trimEnd('/'))
        val e = runCatching { tb.user() }.exceptionOrNull()
        assertEquals("TorBox: Bad token (200)", e?.message)
    }

    @Test
    fun realDebridMagnetFlow() = runBlocking {
        var info = 0
        serve { r ->
            val p = r.path!!
            when {
                p == "/torrents/addMagnet" -> """{"id":"RD1"}"""
                p == "/torrents/info/RD1" -> when (++info) {
                    1 -> """{"status":"waiting_files_selection","files":[{"id":1,"path":"/d/a.mkv","bytes":10},{"id":2,"path":"/d/b.nfo","bytes":2}]}"""
                    2 -> """{"status":"downloading","progress":50,"speed":5}"""
                    else -> """{"status":"downloaded","links":["https://rd/l1"]}"""
                }
                p == "/torrents/selectFiles/RD1" -> {
                    assertEquals("files=1", r.body.readUtf8())
                    ""
                }
                p == "/unrestrict/link" -> """{"download":"https://cdn.rd/a.mkv","filename":"a.mkv","filesize":10}"""
                else -> null
            }
        }
        val rd = RealDebrid("tok", client, server.url("").toString().trimEnd('/'), pollMs = 10)
        val files = rd.resolveTorrent(TorrentJob(magnet = "magnet:?xt=urn:btih:abc", wanted = setOf("a.mkv|10")), {}, {})
        assertEquals(listOf("https://cdn.rd/a.mkv"), files.map { it.url })
        assertTrue(log.contains("POST /torrents/selectFiles/RD1"))
    }
}
