package app.hakobu.core

import kotlinx.serialization.Serializable
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.URLDecoder

@Serializable
enum class LinkKind { HTTP, TORRENT, MEDIA }

/** One link pulled out of pasted text (LinkGrabber). Port of src/linkparse.js. */
@Serializable
data class ParsedLink(
    val kind: LinkKind,
    val source: String,
    val name: String,
    val infoHash: String? = null,
    val hoster: Boolean = false,
    val playlist: Boolean = false,
)

object LinkParser {
    val HOSTERS = listOf(
        "mega.nz", "mega.co.nz", "rapidgator.net", "rg.to", "1fichier.com", "nitroflare.com", "turbobit.net",
        "katfile.com", "ddownload.com", "filefactory.com", "hitfile.net", "uploadgig.com", "k2s.cc",
        "keep2share.cc", "fikper.com", "mediafire.com", "gofile.io", "uptobox.com", "filespace.com",
        "dailyuploads.net", "usersdrive.com", "clicknupload.click", "hexload.com", "pixeldrain.com",
        "vikingfile.com", "vik1ngfile.site", "akirabox.com", "akirabox.to", "buzzheavier.com", "bzzhr.co", "datavaults.co", "fuckingfast.co",
        "qiwi.gg", "filecrypt.cc", "megaup.net", "send.cm", "krakenfiles.com",
    )

    val MEDIA_SITES = listOf(
        "youtube.com", "youtu.be", "youtube-nocookie.com", "music.youtube.com", "vimeo.com", "soundcloud.com", "twitch.tv", "dailymotion.com",
        "bandcamp.com", "tiktok.com", "x.com", "twitter.com", "instagram.com", "reddit.com", "v.redd.it", "bilibili.com", "nicovideo.jp", "streamable.com",
    )

    // X posts in every form people share them; fxtwitter and friends are embed-fixing mirrors of x.com. A /photo/1 or
    // /video/1 ending is dropped: yt-dlp fails on /video/1 for some posts ("Media #1 is not a video").
    private val X_POST = Regex("""^https?://(?:[\w-]+\.)?(?:x|twitter|fxtwitter|vxtwitter|fixupx|fixvx)\.com/((?:[^/?#]+/){1,2}status(?:es)?/\d+)""", RegexOption.IGNORE_CASE)

    fun normalizeX(url: String): String = X_POST.find(url)?.let { "https://x.com/${it.groupValues[1]}" } ?: url

    private val MAGNET = Regex("""magnet:\?[^\s"'<>]+""", RegexOption.IGNORE_CASE)
    private val URL = Regex("""https?://[^\s"'<>]+""", RegexOption.IGNORE_CASE)
    private val HASH = Regex("""\b[a-f0-9]{40}\b""", RegexOption.IGNORE_CASE)
    private val TRAILING = Regex("""[),.;\]]+$""")
    private val BTIH = Regex("""xt=urn:btih:([a-z0-9]+)""", RegexOption.IGNORE_CASE)

    private fun host(url: String, stripMobile: Boolean = false): String? {
        val h = url.toHttpUrlOrNull()?.host?.lowercase() ?: return null
        return if (stripMobile) h.removePrefix("www.").removePrefix("m.") else h.removePrefix("www.")
    }

    private fun matchesAny(host: String, domains: List<String>) = domains.any { host == it || host.endsWith(".$it") }

    fun isHoster(url: String): Boolean = host(url)?.let { matchesAny(it, HOSTERS) } ?: false

    /** Video/audio sites that go to yt-dlp on desktop. */
    fun isMediaUrl(url: String): Boolean = host(url, stripMobile = true)?.let { matchesAny(it, MEDIA_SITES) } ?: false

    fun infoHashFromMagnet(magnet: String): String? {
        val h = BTIH.find(magnet)?.groupValues?.get(1) ?: return null
        if (h.length == 40 && h.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) return h.lowercase()
        if (h.length == 32) return base32ToHex(h)
        return null
    }

    private fun base32ToHex(s: String): String? {
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        val bits = StringBuilder()
        for (c in s.uppercase()) {
            val v = alphabet.indexOf(c)
            if (v < 0) return null
            bits.append(Integer.toBinaryString(v).padStart(5, '0'))
        }
        val hex = StringBuilder()
        var i = 0
        while (i + 4 <= bits.length) {
            hex.append(Integer.parseInt(bits.substring(i, i + 4), 2).toString(16))
            i += 4
        }
        return hex.toString()
    }

    fun nameFromUrl(url: String): String {
        val u = url.toHttpUrlOrNull() ?: return url
        return u.pathSegments.lastOrNull { it.isNotEmpty() } ?: u.host
    }

    /** The `dn=` display name of a magnet link, if any. */
    fun magnetName(magnet: String): String? {
        val query = magnet.substringAfter('?', "")
        for (part in query.split('&')) {
            val eq = part.indexOf('=')
            if (eq > 0 && part.substring(0, eq).equals("dn", ignoreCase = true)) {
                return runCatching { URLDecoder.decode(part.substring(eq + 1), "UTF-8") }.getOrNull()?.ifBlank { null }
            }
        }
        return null
    }

    fun parse(text: String?): List<ParsedLink> {
        val out = mutableListOf<ParsedLink>()
        val seen = HashSet<String>()
        fun push(entry: ParsedLink) {
            if (seen.add(entry.infoHash ?: entry.source)) out.add(entry)
        }

        var rest = text.orEmpty()

        for (m in MAGNET.findAll(rest)) {
            val magnet = m.value.replace("&amp;", "&")
            val infoHash = infoHashFromMagnet(magnet)
            push(ParsedLink(LinkKind.TORRENT, magnet, magnetName(magnet) ?: infoHash ?: "magnet", infoHash))
        }
        rest = MAGNET.replace(rest, " ")

        for (m in URL.findAll(rest)) {
            // Links copied out of web pages can arrive HTML-escaped.
            val url = normalizeX(TRAILING.replace(m.value.replace("&amp;", "&"), ""))
            val parsed = url.toHttpUrlOrNull() ?: continue
            val isTorrent = parsed.encodedPath.endsWith(".torrent", ignoreCase = true)
            if (!isTorrent && isMediaUrl(url)) {
                val playlist = Regex("[?&]list=").containsMatchIn(url) && !Regex("[?&]v=").containsMatchIn(url)
                push(ParsedLink(LinkKind.MEDIA, url, url, playlist = playlist))
                continue
            }
            push(
                ParsedLink(
                    kind = if (isTorrent) LinkKind.TORRENT else LinkKind.HTTP,
                    source = url,
                    name = nameFromUrl(url),
                    hoster = !isTorrent && isHoster(url),
                )
            )
        }
        rest = URL.replace(rest, " ")

        for (m in HASH.findAll(rest)) {
            val h = m.value.lowercase()
            push(ParsedLink(LinkKind.TORRENT, "magnet:?xt=urn:btih:$h", h, h))
        }
        return out
    }
}
