package app.hakobu.android.ui

import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.PlaylistPlay
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.MusicNote
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hakobu.android.Hakobu
import app.hakobu.core.AddRequest
import app.hakobu.core.DownloadItem
import app.hakobu.core.LinkKind
import app.hakobu.core.LinkParser
import app.hakobu.core.MediaFormats
import app.hakobu.core.MediaInfo
import app.hakobu.core.ParsedLink
import app.hakobu.core.Route
import app.hakobu.core.Status
import coil3.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Media screen state, kept across tab switches. */
class MediaState {
    var url by mutableStateOf("")
    var info by mutableStateOf<MediaInfo?>(null)
    var infoFor by mutableStateOf<String?>(null)
    var loading by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var format by mutableStateOf<String?>(null)
    var quality by mutableStateOf<String?>(null)
    var attempt by mutableIntStateOf(0)
    // MP3 trimming: off = whole track; clip = chosen part in seconds (null = all of it).
    var trim by mutableStateOf(false)
    var clip by mutableStateOf<ClosedFloatingPointRange<Float>?>(null)

    fun reset() {
        url = ""
        info = null
        infoFor = null
        error = null
        loading = false
        trim = false
        clip = null
    }
}

private fun duration(sec: Int?): String? {
    if (sec == null || sec <= 0) return null
    val h = sec / 3600
    val m = (sec % 3600) / 60
    val s = sec % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

@Composable
fun MediaScreen(hakobu: Hakobu, state: MediaState, modifier: Modifier, onSeeAll: () -> Unit, onFileLink: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val settings by hakobu.settings.collectAsState()
    val items by hakobu.manager.itemsFlow.collectAsState()
    val parsed = remember(state.url) { LinkParser.parse(state.url) }
    val link: ParsedLink? = parsed.firstOrNull()
    val isMedia = link?.kind == LinkKind.MEDIA
    val format = state.format ?: settings.ytFormat
    val quality = state.quality ?: if (format == "mp3") settings.ytAudioQuality else settings.ytVideoQuality

    // Look the video up shortly after a link is pasted or typed.
    LaunchedEffect(link?.source, state.attempt) {
        val l = link
        if (l == null || l.kind != LinkKind.MEDIA || state.infoFor == l.source) return@LaunchedEffect
        delay(350)
        state.loading = true
        state.error = null
        state.info = null
        try {
            state.info = hakobu.manager.mediaInfo(l.source, l.playlist)
            state.trim = false
            state.clip = null
            state.infoFor = l.source
        } catch (e: Exception) {
            if (e is kotlinx.coroutines.CancellationException) throw e
            state.error = e.message ?: "Couldn't read this link"
        } finally {
            state.loading = false
        }
    }

    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Column(Modifier.padding(top = 20.dp)) {
            Text("Hakobu", style = MaterialTheme.typography.headlineMedium)
            Text("Save videos and music from 1,800+ sites", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }

        // Link field
        Row(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(18.dp))
                .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                .border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(18.dp))
                .padding(start = 16.dp, end = 6.dp, top = 6.dp, bottom = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Filled.Link, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(10.dp))
            Box(Modifier.weight(1f).height(44.dp), contentAlignment = Alignment.CenterStart) {
                if (state.url.isEmpty()) Text("Paste a YouTube, TikTok or Instagram link", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                BasicTextField(
                    value = state.url,
                    onValueChange = { state.url = it.trim() },
                    singleLine = true,
                    textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                    cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go),
                    keyboardActions = KeyboardActions(),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            if (state.url.isNotEmpty()) {
                IconButton(onClick = { state.reset() }) { Icon(Icons.Filled.Close, "Clear") }
            } else {
                FilledTonalButton(
                    onClick = {
                        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        cm.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString()?.let { text ->
                            state.url = LinkParser.parse(text).firstOrNull()?.source ?: text.trim()
                        }
                    },
                    shape = RoundedCornerShape(14.dp),
                    modifier = Modifier.height(44.dp),
                ) { Text("Paste") }
            }
        }

        when {
            state.url.isBlank() -> SupportedSites()
            link == null -> Hint("That doesn't look like a link.")
            !isMedia -> {
                Surface(shape = RoundedCornerShape(18.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text("This looks like a file or torrent link", style = MaterialTheme.typography.titleMedium)
                        Text("Files, hoster links and torrents are downloaded from the Links tab.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        FilledTonalButton(onClick = { onFileLink(state.url); state.reset() }) { Text("Open in Links") }
                    }
                }
            }
            else -> PreviewCard(
                hakobu = hakobu,
                url = link.source,
                state = state,
                info = state.info,
                loading = state.loading,
                error = state.error,
                format = format,
                quality = quality,
                onFormat = { f ->
                    state.format = f
                    state.quality = null
                },
                onQuality = { state.quality = it },
                onRetry = { state.infoFor = null; state.attempt++ },
                onDownload = {
                    val l = link ?: return@PreviewCard
                    val info = state.info
                    val clip = state.clip?.takeIf { state.trim && format == "mp3" && info?.isPlaylist != true }
                    scope.launch {
                        hakobu.manager.add(
                            listOf(
                                AddRequest(
                                    link = l.copy(name = info?.title ?: l.name, playlist = info?.isPlaylist ?: l.playlist),
                                    mediaFormat = format,
                                    mediaQuality = quality,
                                    thumbnail = info?.thumbnail,
                                    uploader = info?.uploader,
                                    clipStart = clip?.start?.toDouble(),
                                    clipEnd = clip?.endInclusive?.toDouble(),
                                )
                            )
                        )
                        state.reset()
                    }
                },
            )
        }

        val recent = items.filter { it.via == Route.YTDLP }.take(5)
        if (recent.isNotEmpty()) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("Recent", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = onSeeAll) { Text("See all") }
            }
            recent.forEach { RecentRow(it) }
        }
        Spacer(Modifier.height(12.dp))
    }
}

@Composable
private fun SupportedSites() {
    val sites = listOf("YouTube", "TikTok", "Instagram", "X", "Facebook", "SoundCloud", "Vimeo", "Reddit")
    Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            sites.forEach { s ->
                Surface(shape = RoundedCornerShape(17.dp), color = Color.Transparent, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
                    Text(s, Modifier.padding(horizontal = 12.dp, vertical = 7.dp), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurface)
                }
            }
        }
        Text(
            "Tip: in YouTube or any other app, tap Share and pick Hakobu.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun Hint(text: String) = Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable
private fun PreviewCard(
    hakobu: Hakobu,
    url: String,
    state: MediaState,
    info: MediaInfo?,
    loading: Boolean,
    error: String?,
    format: String,
    quality: String,
    onFormat: (String) -> Unit,
    onQuality: (String) -> Unit,
    onRetry: () -> Unit,
    onDownload: () -> Unit,
) {
    Surface(shape = RoundedCornerShape(22.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh, border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant)) {
        Column {
            Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(MaterialTheme.colorScheme.surfaceContainerHighest), contentAlignment = Alignment.Center) {
                if (info?.thumbnail != null) {
                    AsyncImage(model = info.thumbnail, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                }
                when {
                    loading -> CircularProgressIndicator(Modifier.size(36.dp), strokeWidth = 3.dp)
                    info != null -> Box(Modifier.size(56.dp).clip(CircleShape).background(Color(0xB30B0D12)), contentAlignment = Alignment.Center) {
                        Icon(if (info.isPlaylist) Icons.AutoMirrored.Filled.PlaylistPlay else Icons.Filled.PlayArrow, null, tint = Color.White)
                    }
                }
                val badge = if (info?.isPlaylist == true) info.entries?.let { "$it videos" } else duration(info?.durationSec)
                if (badge != null) {
                    Text(
                        badge,
                        color = Color.White,
                        style = MaterialTheme.typography.labelMedium,
                        modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp).clip(RoundedCornerShape(6.dp)).background(Color(0xD90B0D12)).padding(horizontal = 7.dp, vertical = 3.dp),
                    )
                }
            }
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                when {
                    error != null -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text("Couldn't read this link", style = MaterialTheme.typography.titleMedium)
                        Text(error, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                        TextButton(onClick = onRetry, contentPadding = ButtonDefaults.TextButtonContentPadding) { Text("Try again") }
                    }
                    info == null -> Text(if (loading) "Looking up the video…" else "", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else -> Column {
                        Text(info.title, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        val sub = listOfNotNull(info.uploader, info.site).joinToString(" · ")
                        if (sub.isNotEmpty()) Text(sub, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                    }
                }

                // Video / audio switch
                Row(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(MaterialTheme.colorScheme.surfaceContainerLowest).padding(4.dp),
                ) {
                    listOf("mp4" to "Video · MP4", "mp3" to "Audio · MP3").forEach { (f, label) ->
                        val selected = f == format
                        Box(
                            Modifier.weight(1f).height(40.dp).clip(RoundedCornerShape(11.dp))
                                .background(if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                                .clickable { onFormat(f) },
                            contentAlignment = Alignment.Center,
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (f == "mp3") Icon(Icons.Filled.MusicNote, null, Modifier.size(16.dp), tint = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant)
                                if (f == "mp3") Spacer(Modifier.width(4.dp))
                                Text(
                                    label,
                                    style = MaterialTheme.typography.labelLarge,
                                    color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                }

                // Quality chips
                val qualities = if (format == "mp3") MediaFormats.AUDIO_QUALITIES else MediaFormats.VIDEO_QUALITIES
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    qualities.forEach { q ->
                        val selected = q == quality
                        Surface(
                            onClick = { onQuality(q) },
                            shape = RoundedCornerShape(17.dp),
                            color = if (selected) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.6f) else Color.Transparent,
                            border = BorderStroke(1.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
                        ) {
                            Text(
                                if (format == "mp3") "$q kbps" else MediaFormats.videoLabel(q),
                                Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
                                style = MaterialTheme.typography.labelLarge,
                            )
                        }
                    }
                }

                val dur = info?.durationSec
                if (format == "mp3" && info != null && !info.isPlaylist && dur != null && dur >= 2) TrimCard(hakobu, url, dur, state)

                Button(
                    onClick = onDownload,
                    enabled = !loading,
                    shape = RoundedCornerShape(16.dp),
                    modifier = Modifier.fillMaxWidth().height(50.dp),
                ) {
                    Icon(Icons.Filled.Download, null, Modifier.size(20.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(
                        when {
                            info?.isPlaylist == true -> "Download playlist"
                            format == "mp3" && state.trim -> "Download this part"
                            format == "mp3" -> "Download audio"
                            else -> "Download video"
                        },
                        fontWeight = FontWeight.Bold,
                    )
                }
            }
        }
    }
}

@Composable
private fun RecentRow(item: DownloadItem) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(72.dp).height(44.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceContainerHighest)) {
            if (item.thumbnail != null) AsyncImage(model = item.thumbnail, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
        Column(Modifier.weight(1f).padding(start = 12.dp)) {
            Text(item.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (item.status == Status.ACTIVE || item.status == Status.PAUSED) {
                LinearProgressIndicator(
                    progress = { item.progress.toFloat() },
                    modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp),
                )
            }
            Text(
                mediaStatus(item),
                style = MaterialTheme.typography.bodySmall,
                color = if (item.status == Status.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

fun mediaStatus(item: DownloadItem): String {
    val kind = (item.mediaFormat ?: "mp4").uppercase()
    val q = item.mediaQuality?.let { if (item.mediaFormat == "mp3") "$it kbps" else MediaFormats.videoLabel(it) }
    val clip = MediaFormats.clipLabel(item.clipStart, item.clipEnd)
    return when (item.status) {
        Status.QUEUED -> listOfNotNull(kind, clip, "Waiting").joinToString(" · ")
        Status.ACTIVE -> listOfNotNull(
            kind,
            item.remoteState ?: "${(item.progress * 100).toInt()}%",
            if (item.speed > 0) formatSpeed(item.speed) else null,
        ).joinToString(" · ")
        Status.PAUSED -> "$kind · Paused · ${(item.progress * 100).toInt()}%"
        Status.COMPLETED -> listOfNotNull(kind, q, clip, item.size?.let { formatBytes(it) }, if (item.fileCount > 1) "${item.fileCount} files" else null).joinToString(" · ")
        Status.FAILED -> item.error ?: "Failed"
        else -> kind
    }
}
