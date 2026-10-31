package app.hakobu.android.ui

import android.net.Uri
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.OndemandVideo
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import app.hakobu.android.Hakobu
import app.hakobu.android.Incoming
import app.hakobu.core.LinkKind
import app.hakobu.core.LinkParser
import kotlinx.coroutines.flow.MutableStateFlow

private enum class Tab(val label: String) { MEDIA("Media"), LINKS("Links"), DOWNLOADS("Downloads"), SETTINGS("Settings") }

@Composable
fun HakobuRoot(hakobu: Hakobu, incoming: MutableStateFlow<Incoming?>, readTorrent: (Uri) -> Unit) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val grabber = remember { GrabberState() }
    val media = remember { MediaState() }
    val pending by incoming.collectAsState()

    // Shared video links open on the media screen; everything else lands in Links.
    LaunchedEffect(pending) {
        when (val p = pending) {
            is Incoming.Text -> {
                val links = LinkParser.parse(p.text)
                val first = links.firstOrNull()
                if (links.size == 1 && first?.kind == LinkKind.MEDIA) {
                    media.url = first.source
                    tab = Tab.MEDIA.ordinal
                } else {
                    grabber.appendText(p.text)
                    tab = Tab.LINKS.ordinal
                }
            }
            is Incoming.Torrent -> {
                grabber.addTorrent(p.name, p.bytes)
                tab = Tab.LINKS.ordinal
            }
            null -> return@LaunchedEffect
        }
        incoming.value = null
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
                Tab.entries.forEach { t ->
                    NavigationBarItem(
                        selected = tab == t.ordinal,
                        onClick = { tab = t.ordinal },
                        icon = {
                            Icon(
                                when (t) {
                                    Tab.MEDIA -> Icons.Filled.OndemandVideo
                                    Tab.LINKS -> Icons.Filled.Link
                                    Tab.DOWNLOADS -> Icons.Filled.Download
                                    Tab.SETTINGS -> Icons.Filled.Settings
                                },
                                contentDescription = null,
                            )
                        },
                        label = { Text(t.label) },
                    )
                }
            }
        },
    ) { padding ->
        val modifier = Modifier.padding(padding)
        when (Tab.entries[tab]) {
            Tab.MEDIA -> MediaScreen(
                hakobu, media, modifier,
                onSeeAll = { tab = Tab.DOWNLOADS.ordinal },
                onFileLink = { text ->
                    grabber.appendText(text)
                    tab = Tab.LINKS.ordinal
                },
            )
            Tab.LINKS -> GrabberScreen(hakobu, grabber, modifier, readTorrent, onStarted = { tab = Tab.DOWNLOADS.ordinal })
            Tab.DOWNLOADS -> DownloadsScreen(hakobu, modifier, onAddLinks = { tab = Tab.LINKS.ordinal })
            Tab.SETTINGS -> SettingsScreen(hakobu, modifier)
        }
    }
}
