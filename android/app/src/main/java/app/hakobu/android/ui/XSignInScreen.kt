package app.hakobu.android.ui

import android.annotation.SuppressLint
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import app.hakobu.android.Hakobu
import app.hakobu.core.XCookies
import kotlinx.coroutines.delay

private const val X_LOGIN = "https://x.com/i/flow/login"

/** X's own login page. The app never reads the page or the password, it only watches for the login cookies to appear. */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun XSignInScreen(hakobu: Hakobu, onClose: () -> Unit, onSignedIn: () -> Unit) {
    BackHandler(onBack = onClose)
    LaunchedEffect(Unit) {
        while (true) {
            val cookies = XCookies.fromHeader(CookieManager.getInstance().getCookie("https://x.com"))
            if (XCookies.isSignedIn(cookies)) {
                hakobu.xAccount.save(cookies)
                onSignedIn()
                return@LaunchedEffect
            }
            delay(700)
        }
    }
    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxSize().safeDrawingPadding()) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onClose) { Icon(Icons.Filled.Close, "Close") }
                Text("Sign in to X", style = MaterialTheme.typography.titleMedium)
            }
            AndroidView(
                modifier = Modifier.weight(1f).fillMaxWidth(),
                factory = { context ->
                    WebView(context).apply {
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        // The stock WebView agent marks itself as embedded; X gets a normal mobile Chrome one instead.
                        settings.userAgentString = WebSettings.getDefaultUserAgent(context)
                            .replace("; wv", "")
                            .replace(Regex(""" Version/[\d.]+"""), "")
                        CookieManager.getInstance().setAcceptCookie(true)
                        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
                        webViewClient = WebViewClient()
                        loadUrl(X_LOGIN)
                    }
                },
                onRelease = { it.destroy() },
            )
        }
    }
}
