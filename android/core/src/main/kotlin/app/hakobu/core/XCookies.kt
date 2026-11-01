package app.hakobu.core

/** The login cookies yt-dlp needs to see age-restricted X posts. */
object XCookies {
    private val KEEP = listOf("auth_token", "ct0", "twid")
    private val DOMAINS = listOf(".x.com", ".twitter.com")
    private const val YEAR_SEC = 365 * 24 * 3600L

    /** The ones worth keeping from a "a=b; c=d" Cookie header. */
    fun fromHeader(header: String?): Map<String, String> =
        header.orEmpty().split(';').mapNotNull { part ->
            val eq = part.indexOf('=')
            if (eq <= 0) null else part.substring(0, eq).trim() to part.substring(eq + 1).trim()
        }.filter { (name, value) -> name in KEEP && value.isNotEmpty() }.toMap()

    fun isSignedIn(cookies: Map<String, String>) = !cookies["auth_token"].isNullOrBlank() && !cookies["ct0"].isNullOrBlank()

    /** A Netscape cookie file, the format yt-dlp's --cookies reads. */
    fun netscape(cookies: Map<String, String>, nowSec: Long): String = buildString {
        append("# Netscape HTTP Cookie File\n")
        for (domain in DOMAINS) for ((name, value) in cookies) {
            append(listOf(domain, "TRUE", "/", "TRUE", (nowSec + YEAR_SEC).toString(), name, value).joinToString("\t")).append('\n')
        }
    }

    /** yt-dlp options for [url]: the cookies go to X links and nowhere else. */
    fun args(url: String, cookieFile: String?): List<String> =
        if (cookieFile != null && XPosts.isXUrl(url)) listOf("--cookies", cookieFile) else emptyList()
}
