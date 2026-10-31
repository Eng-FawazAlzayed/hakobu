package app.hakobu.core

import app.hakobu.core.debrid.RealDebrid
import app.hakobu.core.debrid.get
import app.hakobu.core.debrid.long
import app.hakobu.core.debrid.str
import app.hakobu.core.debrid.bool
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

enum class LinkStatus { ONLINE, OFFLINE, UNKNOWN, HOSTER, PAGE, UNSUPPORTED }

data class LinkCheck(
    val status: LinkStatus,
    val filename: String? = null,
    val size: Long? = null,
    val host: String? = null,
    val error: String? = null,
    val route: Route? = null,
) {
    val autoPackage get() = filename?.let { Names.packageName(it) }
}

/** LinkGrabber online check: real name and size before downloading. Port of src/engine/linkcheck.js. */
class LinkChecker(private val engine: HttpEngine, private val rdCheck: RealDebrid, private val hosters: HosterRegistry) {

    suspend fun check(url: String, route: Route, settings: Settings): LinkCheck {
        val providers = hosters.providersFor(url)
        suspend fun viaRealDebrid(): LinkCheck = try {
            val d = withTimeout(15_000) { rdCheck.checkLink(url) }
            if (d == null) LinkCheck(LinkStatus.OFFLINE, error = "File unavailable", route = route)
            else LinkCheck(
                if (d["supported"].bool == true) LinkStatus.ONLINE else LinkStatus.UNKNOWN,
                d["filename"].str, d["filesize"].long?.takeIf { it > 0 }, d["host"].str, route = route,
            )
        } catch (e: Exception) {
            LinkCheck(LinkStatus.UNKNOWN, error = e.message, route = route)
        }

        if (providers.any { it.provider == Route.REALDEBRID }) return viaRealDebrid()
        if (providers.isNotEmpty()) return LinkCheck(LinkStatus.HOSTER, host = providers[0].name, route = route)
        if (LinkParser.isHoster(url)) {
            if (hosters.data.updated > 0) {
                val host = url.toHttpUrlOrNull()?.host?.removePrefix("www.") ?: url
                return LinkCheck(LinkStatus.UNSUPPORTED, host = host, error = "$host isn't supported by TorBox or Real-Debrid.", route = route)
            }
            return viaRealDebrid()
        }
        return try {
            val p = withTimeout(15_000) { engine.probe(url) }
            LinkCheck(LinkStatus.ONLINE, p.filename, p.size, route = route)
        } catch (e: PageException) {
            LinkCheck(LinkStatus.PAGE, error = "Web page, not a file. This host isn't supported by your debrid services.", route = route)
        } catch (e: HttpStatusException) {
            LinkCheck(if (e.code == 404 || e.code == 410) LinkStatus.OFFLINE else LinkStatus.UNKNOWN, error = e.message, route = route)
        } catch (e: Exception) {
            LinkCheck(LinkStatus.UNKNOWN, error = if (e is kotlinx.coroutines.TimeoutCancellationException) "Timed out" else e.message, route = route)
        }
    }

    /** Check many links, a few at a time. */
    suspend fun checkAll(urls: List<Pair<String, Route>>, settings: Settings, concurrency: Int = 6): List<LinkCheck> = coroutineScope {
        val sem = Semaphore(concurrency)
        urls.map { (u, r) -> async { sem.withPermit { check(u, r, settings) } } }.awaitAll()
    }
}
