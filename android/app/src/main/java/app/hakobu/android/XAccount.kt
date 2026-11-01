package app.hakobu.android

import android.content.Context
import android.webkit.CookieManager
import app.hakobu.core.XCookies
import app.hakobu.core.XPosts
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

/** The X login cookies, encrypted with the Keystore. They're only ever on disk in the clear for one yt-dlp run. */
class XAccount(context: Context) {
    private val sealed = File(context.filesDir, "x-cookies.enc")
    private val tempDir = File(context.cacheDir, "x-cookies")
    private val _signedIn = MutableStateFlow(sealed.isFile)
    val signedIn: StateFlow<Boolean> = _signedIn.asStateFlow()

    init {
        tempDir.deleteRecursively() // left behind if the app was killed mid-run
    }

    fun save(cookies: Map<String, String>) {
        sealed.writeText(SecretBox.encrypt(XCookies.netscape(cookies, System.currentTimeMillis() / 1000)))
        _signedIn.value = true
    }

    fun signOut() {
        sealed.delete()
        tempDir.deleteRecursively()
        CookieManager.getInstance().apply {
            removeAllCookies(null)
            flush()
        }
        _signedIn.value = false
    }

    /** A cookie file for one yt-dlp run on an X link, or null for other sites or when signed out. The caller deletes it. */
    fun tempCookies(url: String): File? {
        if (!XPosts.isXUrl(url) || !sealed.isFile) return null
        val plain = SecretBox.decrypt(sealed.readText())
        if (plain.isEmpty()) {
            // The Keystore key is gone (e.g. restored to a new phone): the user signs in again.
            signOut()
            return null
        }
        tempDir.mkdirs()
        return File.createTempFile("x-cookies", ".txt", tempDir).apply { writeText(plain) }
    }
}
