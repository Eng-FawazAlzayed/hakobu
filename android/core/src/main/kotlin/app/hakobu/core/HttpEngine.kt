package app.hakobu.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import kotlin.coroutines.coroutineContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

const val USER_AGENT = "Mozilla/5.0 (Linux; Android) Hakobu/0.1"
private const val MIN_SEGMENT = 2L * 1024 * 1024

@Serializable
class Segment(val start: Long, val end: Long?) {
    @Volatile
    var done: Long = 0
}

data class ProbeResult(val size: Long?, val resumable: Boolean, val filename: String)

/** Thrown when a "download" link is really a web page (a file host's landing page, a login page...). */
class PageException(message: String) : IOException(message)

class HttpStatusException(val code: Int, message: String) : IOException("HTTP $code $message".trim())

/** Await an OkHttp call; cancelling the coroutine cancels the request. */
suspend fun Call.await(): Response = suspendCancellableCoroutine { cont ->
    cont.invokeOnCancellation { runCatching { cancel() } }
    enqueue(object : Callback {
        override fun onResponse(call: Call, response: Response) = cont.resume(response)
        override fun onFailure(call: Call, e: IOException) {
            if (!cont.isCancelled) cont.resumeWithException(e)
        }
    })
}

fun makeSegments(size: Long?, resumable: Boolean, connections: Int): List<Segment> {
    if (!resumable || size == null || size <= 0) return listOf(Segment(0, size?.let { it - 1 }))
    val n = max(1, min(connections.toLong(), ceil(size.toDouble() / MIN_SEGMENT).toLong()).toInt())
    val step = ceil(size.toDouble() / n).toLong()
    val segs = mutableListOf<Segment>()
    var start = 0L
    while (start < size) {
        segs.add(Segment(start, min(size, start + step) - 1))
        start += step
    }
    return segs
}

/** Segmented, resumable HTTP downloader. Port of src/engine/http.js. */
class HttpEngine(private val client: OkHttpClient, private val limiter: RateLimiter) {

    suspend fun probe(url: String, headers: Map<String, String> = emptyMap()): ProbeResult {
        val req = Request.Builder().url(url).header("User-Agent", USER_AGENT).apply {
            headers.forEach { (k, v) -> header(k, v) }
        }.header("Range", "bytes=0-0").build()
        client.newCall(req).await().use { res ->
            val finalUrl = res.request.url.toString()
            val type = res.header("Content-Type").orEmpty()
            val path = res.request.url.encodedPath
            if (res.isSuccessful && Regex("text/html|application/xhtml", RegexOption.IGNORE_CASE).containsMatchIn(type) &&
                !Regex("""\.x?html?$""", RegexOption.IGNORE_CASE).containsMatchIn(path)
            ) {
                throw PageException("${res.request.url.host} sent a web page, not a file")
            }
            var size: Long? = null
            var resumable = false
            when {
                res.code == 206 -> {
                    Regex("""/(\d+)\s*$""").find(res.header("Content-Range").orEmpty())?.let {
                        size = it.groupValues[1].toLong()
                        resumable = true
                    }
                }
                res.isSuccessful -> size = res.header("Content-Length")?.toLongOrNull()
                else -> throw HttpStatusException(res.code, res.message)
            }
            return ProbeResult(size, resumable, Names.fromResponse(res.header("Content-Disposition"), finalUrl))
        }
    }

    /**
     * Download [item] into [store]. Updates the item's probe fields and segment progress as it goes.
     * Runs until the file is complete; cancel the coroutine to pause (progress is kept for resume).
     */
    suspend fun download(item: DownloadItem, store: FileStore, connections: Int) {
        if (!item.probed || item.storeRef == null || !withContext(Dispatchers.IO) { store.exists(item.storeRef!!) }) {
            val p = withContext(Dispatchers.IO) { probe(item.source, item.headers) }
            val wanted = Names.sanitize(item.suggestedName ?: p.filename)
            val stored = withContext(Dispatchers.IO) { store.create(item.folder, wanted) }
            item.size = p.size
            item.resumable = p.resumable
            item.filename = stored.name
            item.name = stored.name
            item.storeRef = stored.ref
            item.segments = makeSegments(p.size, p.resumable, connections)
            item.probed = true
        }
        if (!item.resumable) item.segments.forEach { it.done = 0 }
        item.downloaded = item.segments.sumOf { it.done }

        val ref = item.storeRef!!
        withContext(Dispatchers.IO) { store.open(ref) }.use { channel ->
            coroutineScope {
                for (seg in item.segments) launch(Dispatchers.IO) { runSegment(item, seg, channel) }
            }
        }
        item.downloaded = item.segments.sumOf { it.done }
        if (item.size == null) item.size = item.downloaded
        item.storeRef = withContext(Dispatchers.IO) { store.finish(ref) }
    }

    private suspend fun runSegment(item: DownloadItem, seg: Segment, channel: FileChannel) {
        var failures = 0
        val buf = ByteArray(64 * 1024)
        while (true) {
            val from = seg.start + seg.done
            if (seg.end != null && from > seg.end) return
            val before = seg.done
            try {
                val req = Request.Builder().url(item.source).header("User-Agent", USER_AGENT).apply {
                    item.headers.forEach { (k, v) -> header(k, v) }
                    if (item.resumable) header("Range", "bytes=$from-${seg.end ?: ""}")
                }.build()
                val call = client.newCall(req)
                val handle = coroutineContext.job.invokeOnCompletion { call.cancel() }
                try {
                    call.await().use { res ->
                        if (if (item.resumable) res.code != 206 else !res.isSuccessful) throw HttpStatusException(res.code, res.message)
                        val body = res.body ?: throw IOException("Empty response")
                        val input = body.byteStream()
                        while (true) {
                            coroutineContext.ensureActive()
                            var n = input.read(buf)
                            if (n < 0) break
                            limiter.take(n)
                            if (seg.end != null) {
                                val remaining = seg.end - (seg.start + seg.done) + 1
                                if (n > remaining) n = remaining.toInt()
                            }
                            val bb = ByteBuffer.wrap(buf, 0, n)
                            var pos = seg.start + seg.done
                            while (bb.hasRemaining()) pos += channel.write(bb, pos)
                            seg.done += n
                            if (seg.end != null && seg.start + seg.done > seg.end) break
                        }
                    }
                } finally {
                    handle.dispose()
                }
                if (seg.end != null && seg.start + seg.done <= seg.end) throw IOException("Connection closed early")
                return
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                coroutineContext.ensureActive()
                // Servers drop connections all the time: keep retrying while data still arrives, give up after 8 dead attempts in a row.
                failures = if (seg.done > before) 1 else failures + 1
                if (failures > 8 || e is HttpStatusException && e.code in listOf(404, 410)) throw e
                if (!item.resumable) seg.done = 0
                delay(min(15_000L, 750L shl (failures - 1)))
            }
        }
    }
}
