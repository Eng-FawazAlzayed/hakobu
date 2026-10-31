package app.hakobu.core

import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.net.URLDecoder

/** File-name helpers shared by the engine and the file stores. Port of src/util.js and linkcheck.packageName. */
object Names {
    private val ILLEGAL = Regex("""[<>:"/\\|?*\x00-\x1f]""")
    private val TRAILING_DOTS = Regex("""[. ]+$""")

    /** A file name that is safe on Android and Windows. */
    fun sanitize(name: String?): String {
        val clean = ILLEGAL.replace(name.orEmpty(), "_").let { TRAILING_DOTS.replace(it, "") }.trim().take(200)
        return clean.ifEmpty { "download" }
    }

    /** "name (1).ext" style alternative to [name] while [taken] says the name is in use. */
    fun uniqueName(name: String, taken: (String) -> Boolean): String {
        val dot = name.lastIndexOf('.')
        val ext = if (dot > 0) name.substring(dot) else ""
        val base = name.substring(0, name.length - ext.length)
        var candidate = name
        var i = 1
        while (taken(candidate)) candidate = "$base (${i++})$ext"
        return candidate
    }

    private val VOLUME = Regex("""\.part\d+\.rar$|\.(7z|zip|rar|tar)\.\d{2,3}$|\.(r|z)\d{2}$""", RegexOption.IGNORE_CASE)
    private val EXT = Regex("""\.[a-z0-9]{1,5}$""", RegexOption.IGNORE_CASE)
    private val DISC = Regex("""[ ._-]+(cd|disc|disk|part|vol)[ ._-]?\d+$""", RegexOption.IGNORE_CASE)
    private val TRAIL_SEP = Regex("""[ ._-]+$""")

    /** "Show.S01.part03.rar" -> "Show.S01", "Movie.CD2.avi" -> "Movie", "backup.7z.001" -> "backup". */
    fun packageName(filename: String?): String {
        var n = filename.orEmpty().split('/', '\\').last()
        n = if (VOLUME.containsMatchIn(n)) VOLUME.replace(n, "") else EXT.replace(n, "")
        n = TRAIL_SEP.replace(DISC.replace(n, ""), "")
        return n.ifEmpty { filename ?: "Package" }
    }

    private val CD_STAR = Regex("""filename\*\s*=\s*(?:UTF-8'')?([^;]+)""", RegexOption.IGNORE_CASE)
    private val CD_PLAIN = Regex("""filename\s*=\s*"?([^";]+)"?""", RegexOption.IGNORE_CASE)

    /** File name from a Content-Disposition header, falling back to the URL's last path segment. */
    fun fromResponse(contentDisposition: String?, url: String): String {
        val cd = contentDisposition.orEmpty()
        CD_STAR.find(cd)?.let { m ->
            runCatching { return sanitize(URLDecoder.decode(m.groupValues[1].trim().trim('"').replace("+", "%2B"), "UTF-8")) }
        }
        CD_PLAIN.find(cd)?.let { return sanitize(it.groupValues[1]) }
        url.toHttpUrlOrNull()?.pathSegments?.lastOrNull { it.isNotEmpty() }?.let { return sanitize(it) }
        return "download"
    }
}
