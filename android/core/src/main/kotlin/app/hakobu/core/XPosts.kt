package app.hakobu.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.math.PI

/** What X's public embed data says about a post that yt-dlp found no video in. */
sealed interface XPost {
    data class Photos(val urls: List<String>, val text: String, val user: String?) : XPost
    /** X hides it from signed-out viewers: age-restricted, or from a protected account. */
    data object LoginRequired : XPost
    data object HasVideo : XPost
    data object NoMedia : XPost
    data object Gone : XPost
}

object XPosts {
    private val X_HOST = Regex("""^https?://([\w-]+\.)*(x|twitter)\.com(/|$)""", RegexOption.IGNORE_CASE)
    private val STATUS_ID = Regex("""/status(?:es)?/(\d+)""")
    private val SHORT_LINK = Regex("""\s*https://t\.co/\S+""")
    private val json = Json { ignoreUnknownKeys = true }

    fun isXUrl(url: String) = X_HOST.containsMatchIn(url)

    fun statusId(url: String): String? = STATUS_ID.find(url)?.groupValues?.get(1)

    /** The address X's own embed widget reads a post from. */
    fun embedUrl(id: String) = "https://cdn.syndication.twimg.com/tweet-result?id=$id&lang=en&token=${token(id)}"

    /** The widget's token: (id / 1e15 * pi) in base 36, without zeros or the point. */
    internal fun token(id: String): String {
        val v = id.toDouble() / 1e15 * PI
        val whole = v.toLong()
        var frac = v - whole
        val out = StringBuilder(whole.toString(36))
        repeat(11) {
            frac *= 36
            val d = frac.toInt()
            out.append(d.toString(36))
            frac -= d
        }
        return out.toString().replace("0", "")
    }

    fun parse(body: String): XPost {
        val o = runCatching { json.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return XPost.Gone
        fun JsonObject.str(k: String) = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val type = o.str("__typename")
        if (type == "TweetTombstone") return XPost.LoginRequired
        if (type != "Tweet" && o["id_str"] == null) return XPost.Gone
        val media = (o["mediaDetails"] as? JsonArray).orEmpty().mapNotNull { it as? JsonObject }
        if (media.any { it.str("type") != "photo" }) return XPost.HasVideo
        val urls = media.mapNotNull { it.str("media_url_https") }.ifEmpty {
            (o["photos"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.str("url") }
        }
        if (urls.isEmpty()) return XPost.NoMedia
        val user = (o["user"] as? JsonObject)?.str("screen_name")
        val text = SHORT_LINK.replace(o.str("text").orEmpty(), "").lineSequence().firstOrNull { it.isNotBlank() }.orEmpty().trim().take(100)
        return XPost.Photos(urls.map { it.substringBefore('?') + "?name=orig" }, text, user)
    }
}
