package app.hakobu.core.debrid

import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** TorBox API client. Docs: https://api-docs.torbox.app/ (port of src/debrid/torbox.js). */
class TorBox(
    private val key: String,
    private val client: OkHttpClient,
    private val base: String = "https://api.torbox.app/v1/api",
    private val pollMs: Long = 3000,
) : DebridProvider {
    override val name = "TorBox"

    private suspend fun req(method: String, path: String, query: Map<String, String> = emptyMap(), form: Map<String, Any>? = null): JsonElement? {
        if (key.isBlank()) throw DebridException("TorBox API key is not set (Settings → Debrid)")
        val url = (base + path).toHttpUrl().newBuilder().apply { query.forEach { (k, v) -> addQueryParameter(k, v) } }.build()
        val body = form?.let {
            MultipartBody.Builder().setType(MultipartBody.FORM).apply {
                for ((k, v) in it) {
                    if (v is ByteArray) addFormDataPart(k, "file.torrent", v.toRequestBody("application/x-bittorrent".toMediaType()))
                    else addFormDataPart(k, v.toString())
                }
            }.build()
        }
        val (code, text) = client.call(Request.Builder().url(url).header("Authorization", "Bearer $key").method(method, body).build())
        val data = parseJson(text)
        if (code !in 200..299 || data["success"].bool == false) {
            throw DebridException("TorBox: ${data["detail"].str ?: data["error"].str ?: "request failed"} ($code)")
        }
        return data["data"]
    }

    override suspend fun user(): DebridUser {
        val u = req("GET", "/user/me")
        return DebridUser(u["email"].str, (u["plan"].long ?: 0) > 0, u["premium_expires_at"].str)
    }

    /** infoHash -> cached in TorBox's cloud. */
    suspend fun checkCached(hashes: List<String>): Map<String, Boolean> {
        if (hashes.isEmpty()) return emptyMap()
        val data = req("GET", "/torrents/checkcached", mapOf("hash" to hashes.joinToString(","), "format" to "object", "list_files" to "false"))
        return hashes.associateWith { data[it] != null }
    }

    override suspend fun resolveTorrent(job: TorrentJob, onRemoteId: (String) -> Unit, onProgress: (RemoteProgress) -> Unit): List<RemoteFile> {
        var id = job.remoteId
        if (id == null) {
            val form: Map<String, Any> = if (job.torrent != null) mapOf("file" to job.torrent) else mapOf("magnet" to job.magnet!!)
            id = req("POST", "/torrents/createtorrent", form = form)["torrent_id"].str ?: throw DebridException("TorBox: no torrent id returned")
            onRemoteId(id)
        }
        return pollUntilReady("torrents", "torrent_id", id, job.wanted, onProgress)
    }

    override suspend fun resolveLink(link: String, remoteId: String?, onRemoteId: (String) -> Unit, onProgress: (RemoteProgress) -> Unit): List<RemoteFile> {
        var id = remoteId
        if (id == null) {
            id = req("POST", "/webdl/createwebdownload", form = mapOf("link" to link))["webdownload_id"].str
                ?: throw DebridException("TorBox: no web download id returned")
            onRemoteId(id)
        }
        return pollUntilReady("webdl", "web_id", id, null, onProgress)
    }

    private suspend fun pollUntilReady(kind: String, idParam: String, id: String, wanted: Set<String>?, onProgress: (RemoteProgress) -> Unit): List<RemoteFile> {
        while (true) {
            var item = req("GET", "/$kind/mylist", mapOf("id" to id, "bypass_cache" to "true"))
            if (item is JsonArray) item = item.firstOrNull()
            val state = item["download_state"].str.orEmpty()
            if (item["download_finished"].bool == true || item["download_present"].bool == true) {
                var files = (item["files"] as? JsonArray)?.filterIsInstance<JsonObject>().orEmpty()
                fun fname(f: JsonObject) = f["short_name"].str ?: f["name"].str?.split('/')?.last()
                if (wanted != null) {
                    val picked = files.filter { fileKey(fname(it) ?: "", it["size"].long) in wanted }
                    if (picked.isNotEmpty()) files = picked
                }
                val out = files.map { f ->
                    val url = req("GET", "/$kind/requestdl", mapOf("token" to key, idParam to id, "file_id" to (f["id"].str ?: ""), "zip_link" to "false")).str
                        ?: throw DebridException("TorBox: no download link for ${fname(f)}")
                    RemoteFile(url, fname(f), f["size"].long)
                }
                if (out.isEmpty()) throw DebridException("TorBox: finished but returned no files")
                return out
            }
            if (Regex("error|failed", RegexOption.IGNORE_CASE).containsMatchIn(state)) throw DebridException("TorBox: $state")
            onProgress(
                RemoteProgress(
                    progress = item["progress"].double ?: 0.0,
                    state = state.ifEmpty { "queued" },
                    speed = item["download_speed"].long ?: 0,
                    seeders = item["seeds"].long?.toInt(),
                    name = item["name"].str,
                )
            )
            delay(pollMs)
        }
    }
}
