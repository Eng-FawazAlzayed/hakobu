package app.hakobu.android.ui

import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Clear
import androidx.compose.material.icons.filled.CloudDownload
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.Movie
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hakobu.android.Hakobu
import app.hakobu.core.AddRequest
import app.hakobu.core.LinkCheck
import app.hakobu.core.LinkKind
import app.hakobu.core.LinkParser
import app.hakobu.core.LinkStatus
import app.hakobu.core.ParsedLink
import app.hakobu.core.Route
import kotlinx.coroutines.launch

/** One row in the LinkGrabber. */
class GrabbedLink(val link: ParsedLink, val torrentBytes: ByteArray? = null) {
    val key get() = link.infoHash ?: link.source
}

/** LinkGrabber state, kept across tab switches. */
class GrabberState {
    var text by mutableStateOf("")
    val torrents = mutableStateListOf<GrabbedLink>()
    val routes = mutableStateMapOf<String, Route>()
    val checks = mutableStateMapOf<String, LinkCheck>()
    var checking by mutableStateOf(false)

    fun links(): List<GrabbedLink> = torrents + LinkParser.parse(text).map { GrabbedLink(it) }

    fun appendText(t: String) {
        text = if (text.isBlank()) t else text.trimEnd() + "\n" + t
    }

    fun addTorrent(name: String, bytes: ByteArray) {
        if (torrents.any { it.link.source == "file:$name" }) return
        torrents.add(GrabbedLink(ParsedLink(LinkKind.TORRENT, "file:$name", name.removeSuffix(".torrent")), bytes))
    }

    fun clear() {
        text = ""
        torrents.clear()
        routes.clear()
        checks.clear()
    }
}

@Composable
fun GrabberScreen(hakobu: Hakobu, state: GrabberState, modifier: Modifier, readTorrent: (Uri) -> Unit, onStarted: () -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val settings by hakobu.settings.collectAsState()
    val links = remember(state.text, state.torrents.size) { state.links() }
    val pickTorrent = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> uri?.let(readTorrent) }

    fun routeOf(g: GrabbedLink) = state.routes[g.key] ?: Route.AUTO
    fun effectiveRoute(g: GrabbedLink) = routeOf(g).takeIf { it != Route.AUTO } ?: hakobu.manager.defaultRoute(g.link)
    fun blocker(g: GrabbedLink): String? {
        val r = effectiveRoute(g) ?: return hakobu.manager.blocker(g.link, Route.AUTO) ?: "Can't download this link yet."
        return hakobu.manager.blocker(g.link, r)
    }

    Column(modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        Text("Links & torrents", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.padding(top = 16.dp, bottom = 8.dp))
        OutlinedTextField(
            value = state.text,
            onValueChange = { state.text = it },
            modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp, max = 180.dp),
            placeholder = { Text("Paste links, magnets, or any text with links in it") },
        )
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton(onClick = {
                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString()?.let { state.appendText(it) }
            }) {
                Icon(Icons.Filled.ContentPaste, null, Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text("Paste")
            }
            OutlinedButton(onClick = { pickTorrent.launch(arrayOf("application/x-bittorrent", "application/octet-stream")) }) {
                Icon(Icons.Filled.FolderOpen, null, Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(".torrent")
            }
            Spacer(Modifier.weight(1f))
            if (links.isNotEmpty()) IconButton(onClick = { state.clear() }) { Icon(Icons.Filled.Clear, "Clear") }
        }

        if (links.isEmpty()) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text(
                    "Paste direct links, hoster links (Mega, Rapidgator, 1fichier…), magnets, or open a .torrent file.\n\n" +
                        "Hoster links and torrents go through TorBox or Real-Debrid.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else {
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(links, key = { it.key }) { g ->
                    GrabbedRow(
                        g = g,
                        route = routeOf(g),
                        resolved = effectiveRoute(g),
                        check = state.checks[g.key],
                        blocker = blocker(g),
                        hasTorBox = settings.hasTorBox,
                        hasRealDebrid = settings.hasRealDebrid,
                        onRoute = { state.routes[g.key] = it },
                    )
                }
            }
            val ready = links.filter { blocker(it) == null }
            Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                OutlinedButton(
                    enabled = !state.checking && links.any { it.link.kind == LinkKind.HTTP },
                    onClick = {
                        state.checking = true
                        scope.launch {
                            val http = links.filter { it.link.kind == LinkKind.HTTP }
                            val results = hakobu.manager.checker.checkAll(http.map { it.link.source to (effectiveRoute(it) ?: Route.DIRECT) }, settings)
                            http.zip(results).forEach { (g, r) -> state.checks[g.key] = r }
                            state.checking = false
                        }
                    },
                ) {
                    if (state.checking) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Text("Check")
                }
                Button(
                    modifier = Modifier.weight(1f),
                    enabled = ready.isNotEmpty(),
                    onClick = {
                        val requests = ready.map { g ->
                            val check = state.checks[g.key]
                            AddRequest(
                                link = g.link,
                                via = routeOf(g),
                                suggestedName = check?.filename,
                                torrentBytes = g.torrentBytes,
                            )
                        }
                        scope.launch {
                            hakobu.manager.add(requests)
                            ready.forEach { g -> state.torrents.remove(g) }
                            // Keep links that can't be downloaded yet so the user sees why.
                            val keep = links.filter { it !in ready && it.torrentBytes == null }.joinToString("\n") { it.link.source }
                            state.text = keep
                            state.checks.clear()
                            onStarted()
                        }
                    },
                ) { Text(if (ready.size == 1) "Download" else "Download ${ready.size}") }
            }
        }
    }
}

@Composable
private fun GrabbedRow(
    g: GrabbedLink,
    route: Route,
    resolved: Route?,
    check: LinkCheck?,
    blocker: String?,
    hasTorBox: Boolean,
    hasRealDebrid: Boolean,
    onRoute: (Route) -> Unit,
) {
    Card(
        shape = androidx.compose.foundation.shape.RoundedCornerShape(18.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(
                when (g.link.kind) {
                    LinkKind.TORRENT -> Icons.Filled.CloudDownload
                    LinkKind.MEDIA -> Icons.Filled.Movie
                    LinkKind.HTTP -> Icons.Filled.Description
                },
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
            )
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(check?.filename ?: g.link.name, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
                val detail = buildList {
                    if (g.link.hoster) add("Hoster")
                    if (g.torrentBytes != null) add(".torrent file")
                    check?.let { c ->
                        add(
                            when (c.status) {
                                LinkStatus.ONLINE -> "Online"
                                LinkStatus.OFFLINE -> "Offline"
                                LinkStatus.HOSTER -> "Via ${c.host}"
                                LinkStatus.PAGE -> "Web page"
                                LinkStatus.UNSUPPORTED -> "Unsupported host"
                                LinkStatus.UNKNOWN -> "Couldn't check"
                            }
                        )
                        c.size?.let { add(formatBytes(it)) }
                    }
                }.joinToString(" · ")
                if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                val problem = blocker ?: check?.error?.takeIf { check.status != LinkStatus.ONLINE }
                if (problem != null) Text(problem, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            if (g.link.kind != LinkKind.MEDIA) {
                val options = buildList {
                    add(Route.AUTO)
                    if (g.link.kind == LinkKind.HTTP) add(Route.DIRECT)
                    add(Route.TORBOX)
                    add(Route.REALDEBRID)
                }
                RoutePicker(route, resolved, options, hasTorBox, hasRealDebrid, onRoute)
            }
        }
    }
}

@Composable
private fun RoutePicker(route: Route, resolved: Route?, options: List<Route>, hasTorBox: Boolean, hasRealDebrid: Boolean, onRoute: (Route) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        AssistChip(
            onClick = { open = true },
            label = { Text(if (route == Route.AUTO) (resolved?.label ?: "Auto") else route.label) },
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { r ->
                val note = when {
                    r == Route.AUTO -> "Pick for me"
                    r == Route.TORBOX && !hasTorBox -> "No key yet"
                    r == Route.REALDEBRID && !hasRealDebrid -> "No token yet"
                    else -> null
                }
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(r.label)
                            if (note != null) Text(note, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    },
                    onClick = {
                        onRoute(r)
                        open = false
                    },
                )
            }
        }
    }
}
