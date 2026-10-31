package app.hakobu.core.debrid

import app.hakobu.core.await
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException

data class DebridUser(val username: String?, val premium: Boolean, val expires: String?)

/** A direct link the service produced. */
data class RemoteFile(val url: String, val filename: String?, val size: Long?)

data class RemoteProgress(val progress: Double, val state: String, val speed: Long, val seeders: Int?, val name: String?)

/** [wanted] holds fileKey()s of the files to keep; null = everything. */
class TorrentJob(val magnet: String? = null, val torrent: ByteArray? = null, val remoteId: String? = null, val wanted: Set<String>? = null)

class DebridException(message: String) : IOException(message)

interface DebridProvider {
    val name: String
    suspend fun user(): DebridUser
    suspend fun resolveLink(link: String, remoteId: String?, onRemoteId: (String) -> Unit, onProgress: (RemoteProgress) -> Unit): List<RemoteFile>
    suspend fun resolveTorrent(job: TorrentJob, onRemoteId: (String) -> Unit, onProgress: (RemoteProgress) -> Unit): List<RemoteFile>
}

/** Files are matched across providers by base name + size. */
fun fileKey(path: String, size: Long?) = "${path.split('/', '\\').last()}|$size"

internal val json = Json { ignoreUnknownKeys = true; isLenient = true }

internal suspend fun OkHttpClient.call(req: Request): Pair<Int, String> = withContext(Dispatchers.IO) {
    newCall(req).await().use { it.code to (it.body?.string() ?: "") }
}

internal fun parseJson(text: String): JsonElement? = if (text.isBlank()) null else runCatching { json.parseToJsonElement(text) }.getOrNull()

internal operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)?.takeUnless { it is JsonNull }
internal val JsonElement?.str: String? get() = (this as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content
internal val JsonElement?.long: Long? get() = (this as? JsonPrimitive)?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }
internal val JsonElement?.double: Double? get() = (this as? JsonPrimitive)?.doubleOrNull
internal val JsonElement?.bool: Boolean? get() = (this as? JsonPrimitive)?.let { it.booleanOrNull ?: it.longOrNull?.let { n -> n != 0L } }
