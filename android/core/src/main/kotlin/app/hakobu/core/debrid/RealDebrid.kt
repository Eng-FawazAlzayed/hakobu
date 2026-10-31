package app.hakobu.core.debrid

import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody

/** Real-Debrid REST client. Docs: https://api.real-debrid.com/ (port of src/debrid/realdebrid.js). */
class RealDebrid(
    private val token: String,
    private val client: OkHttpClient,
    private val base: String = "https://api.real-debrid.com/rest/1.0",
    private val pollMs: Long = 3000,
) : DebridProvider {
    override val name = "Real-Debrid"

    private val failed = setOf("magnet_error", "error", "virus", "dead")

    private suspend fun req(method: String, path: String, form: Map<String, String>? = null, body: RequestBody? = null): JsonElement? {
        if (token.isBlank()) throw DebridException("Real-Debrid API token is not set (Settings → Debrid)")
        val b = body ?: form?.let { FormBody.Builder().apply { it.forEach { (k, v) -> add(k, v) } }.build() }
        val (code, text) = client.call(Request.Builder().url(base + path).header("Authorization", "Bearer $token").method(method, b).build())
        val data = parseJson(text)
        if (code !in 200..299) throw DebridException("Real-Debrid: ${data["error"].str ?: "request failed"} ($code)")
        return data
    }

    override suspend fun user(): DebridUser {
        val u = req("GET", "/user")
        return DebridUser(u["username"].str, u["type"].str == "premium", u["expiration"].str)
    }

    suspend fun unrestrict(link: String): RemoteFile {
        val d = req("POST", "/unrestrict/link", form = mapOf("link" to link))
        return RemoteFile(d["download"].str ?: throw DebridException("Real-Debrid: no download link"), d["filename"].str, d["filesize"].long)
    }

    override suspend fun resolveLink(link: String, remoteId: String?, onRemoteId: (String) -> Unit, onProgress: (RemoteProgress) -> Unit) =
        listOf(unrestrict(link))

    override suspend fun resolveTorrent(job: TorrentJob, onRemoteId: (String) -> Unit, onProgress: (RemoteProgress) -> Unit): List<RemoteFile> {
        var id = job.remoteId
        if (id == null) {
            val added = if (job.torrent != null) req("PUT", "/torrents/addTorrent", body = job.torrent.toRequestBody("application/x-bittorrent".toMediaType()))
            else req("POST", "/torrents/addMagnet", form = mapOf("magnet" to job.magnet!!))
            id = added["id"].str ?: throw DebridException("Real-Debrid: no torrent id returned")
            onRemoteId(id)
        }
        while (true) {
            val info = req("GET", "/torrents/info/$id")
            val status = info["status"].str.orEmpty()
            when {
                status == "waiting_files_selection" -> {
                    var files = "all"
                    if (job.wanted != null) {
                        val ids = (info["files"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
                            .filter { fileKey(it["path"].str ?: "", it["bytes"].long) in job.wanted }
                            .mapNotNull { it["id"].str }
                        if (ids.isNotEmpty()) files = ids.joinToString(",")
                    }
                    req("POST", "/torrents/selectFiles/$id", form = mapOf("files" to files))
                }
                status == "downloaded" -> return (info["links"] as? JsonArray).orEmpty().mapNotNull { it.str }.map { unrestrict(it) }
                status in failed -> throw DebridException("Real-Debrid: torrent $status")
            }
            onProgress(
                RemoteProgress(
                    progress = (info["progress"].double ?: 0.0) / 100,
                    state = status,
                    speed = info["speed"].long ?: 0,
                    seeders = info["seeders"].long?.toInt(),
                    name = info["filename"].str,
                )
            )
            if (status != "waiting_files_selection") delay(pollMs)
        }
    }

    /** Free (no account) existence check for a hoster link. */
    suspend fun checkLink(link: String): JsonElement? {
        val (code, text) = client.call(
            Request.Builder().url("$base/unrestrict/check").post(FormBody.Builder().add("link", link).build()).build()
        )
        val d = parseJson(text)
        if (code == 503 || d["error_code"].long == 24L) return null
        if (code !in 200..299) throw DebridException(d["error"].str ?: "check failed ($code)")
        return d
    }
}
