package app.hakobu.core

import app.hakobu.core.debrid.bool
import app.hakobu.core.debrid.call
import app.hakobu.core.debrid.get
import app.hakobu.core.debrid.json
import app.hakobu.core.debrid.parseJson
import app.hakobu.core.debrid.str
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File

@Serializable
data class HostEntry(val name: String, val domains: List<String>, val up: Boolean = true)

@Serializable
data class HosterLists(
    val torbox: List<HostEntry> = emptyList(),
    val realdebrid: List<HostEntry> = emptyList(),
    val realdebridDomains: List<String> = emptyList(),
    val updated: Long = 0,
)

data class HostSupport(val provider: Route, val name: String, val up: Boolean)

/**
 * Live lists of the file hosts each debrid service supports (both are public, no account needed), used to
 * route hoster links to a service that can unlock them. Port of src/engine/hosters.js.
 */
class HosterRegistry(
    private val client: OkHttpClient,
    private val file: File?,
    private val tbUrl: String = "https://api.torbox.app/v1/api/webdl/hosters",
    private val rdUrl: String = "https://api.real-debrid.com/rest/1.0/hosts",
    private val rdDomainsUrl: String = "https://api.real-debrid.com/rest/1.0/hosts/domains",
) {
    @Volatile
    var data: HosterLists = file?.takeIf { it.exists() }?.let { runCatching { json.decodeFromString<HosterLists>(it.readText()) }.getOrNull() } ?: HosterLists()
        private set

    private suspend fun getJson(url: String): JsonElement {
        var attempt = 1
        while (true) {
            try {
                val (code, text) = client.call(Request.Builder().url(url).build())
                if (code !in 200..299) error("$url → HTTP $code")
                return parseJson(text) ?: error("$url → bad JSON")
            } catch (e: Exception) {
                if (attempt++ >= 4) throw e
                delay(1500L * attempt)
            }
        }
    }

    suspend fun refresh(force: Boolean = false): HosterLists = coroutineScope {
        if (!force && System.currentTimeMillis() - data.updated < 6 * 3600_000 && data.torbox.isNotEmpty()) return@coroutineScope data
        val tb = async { runCatching { getJson(tbUrl) } }
        val rd = async { runCatching { getJson(rdUrl) } }
        val rdDomains = async { runCatching { getJson(rdDomainsUrl) } }
        var next = data
        tb.await().getOrNull()?.let { v ->
            next = next.copy(torbox = (v["data"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
                .filter { it["type"].str == "hoster" }
                .map { h -> HostEntry(h["name"].str ?: "?", (h["domains"] as? JsonArray).orEmpty().mapNotNull { it.str }, h["status"].bool != false) })
        }
        rd.await().getOrNull()?.let { v ->
            next = next.copy(realdebrid = (v as? JsonObject).orEmpty().map { (domain, h) -> HostEntry(h["name"].str ?: domain, listOf(domain)) })
        }
        rdDomains.await().getOrNull()?.let { v -> next = next.copy(realdebridDomains = (v as? JsonArray).orEmpty().mapNotNull { it.str }) }
        if (tb.await().isSuccess || rd.await().isSuccess) {
            next = next.copy(updated = System.currentTimeMillis())
            runCatching { file?.writeText(json.encodeToString(HosterLists.serializer(), next)) }
        }
        data = next
        next
    }

    /** Services that can unlock this URL; ones whose host entry is down come last. */
    fun providersFor(url: String): List<HostSupport> {
        val host = url.toHttpUrlOrNull()?.host?.lowercase()?.removePrefix("www.") ?: return emptyList()
        fun matches(d: String) = host == d || host.endsWith(".$d")
        val out = mutableListOf<HostSupport>()
        data.torbox.find { h -> h.domains.any(::matches) }?.let { out.add(HostSupport(Route.TORBOX, it.name, it.up)) }
        val rdName = data.realdebrid.find { h -> h.domains.any(::matches) }?.name
        if (rdName != null || data.realdebridDomains.any(::matches)) out.add(HostSupport(Route.REALDEBRID, rdName ?: host, true))
        return out.sortedByDescending { it.up }
    }
}
