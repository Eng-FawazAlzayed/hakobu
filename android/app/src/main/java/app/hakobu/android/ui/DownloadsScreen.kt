package app.hakobu.android.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.offset
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import kotlin.math.roundToInt
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ClearAll
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.hakobu.android.Hakobu
import app.hakobu.core.DownloadItem
import app.hakobu.core.Route
import app.hakobu.core.Status
import coil3.compose.AsyncImage
import kotlinx.coroutines.launch

@Composable
fun DownloadsScreen(hakobu: Hakobu, modifier: Modifier, onAddLinks: () -> Unit) {
    val items by hakobu.manager.itemsFlow.collectAsState()
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    var confirmRemove by remember { mutableStateOf<DownloadItem?>(null) }
    var detailsId by remember { mutableStateOf<String?>(null) }
    val snackbars = remember { SnackbarHostState() }

    fun open(item: DownloadItem) {
        val ref = item.storeRef ?: return
        val intent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(Uri.parse(ref), hakobu.store.mimeType(item.name))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        try {
            context.startActivity(Intent.createChooser(intent, item.name))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(context, "No app can open this file", Toast.LENGTH_SHORT).show()
        }
    }

    // Finished items ask what to do with the file; anything still going is simply cancelled.
    fun trash(item: DownloadItem) {
        if (item.status == Status.COMPLETED || item.status == Status.HANDED_OFF) confirmRemove = item
        else scope.launch { hakobu.manager.remove(item.id, false) }
    }

    Box(modifier.fillMaxSize()) { Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Downloads", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
            val anyRunning = items.any { it.status == Status.ACTIVE || it.status == Status.QUEUED || it.status == Status.RESOLVING }
            val anyPaused = items.any { it.status == Status.PAUSED }
            if (anyRunning) IconButton(onClick = { scope.launch { hakobu.manager.pauseAll() } }) { Icon(Icons.Filled.Pause, "Pause all") }
            else if (anyPaused) IconButton(onClick = { scope.launch { hakobu.manager.resumeAll() } }) { Icon(Icons.Filled.PlayArrow, "Resume all") }
            if (items.any { it.status == Status.COMPLETED || it.status == Status.HANDED_OFF }) {
                IconButton(onClick = { scope.launch { hakobu.manager.clearFinished() } }) { Icon(Icons.Filled.ClearAll, "Clear finished") }
            }
        }

        if (items.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(32.dp), contentAlignment = Alignment.Center) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("Nothing here yet", style = MaterialTheme.typography.titleMedium)
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Files are saved to Download/Hakobu.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(16.dp))
                    Button(onClick = onAddLinks) { Text("Add links") }
                }
            }
        } else {
            LazyColumn(
                Modifier.fillMaxSize().padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
                contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 8.dp),
            ) {
                items(items, key = { it.id }) { item ->
                    SwipeToReveal(onTrash = { trash(item) }) {
                        DownloadRow(
                            item = item,
                            onPause = { scope.launch { hakobu.manager.pause(item.id) } },
                            onResume = { scope.launch { hakobu.manager.resume(item.id) } },
                            onOpen = { open(item) },
                            onDetails = { detailsId = item.id },
                        )
                    }
                }
            }
        }
    }
        SnackbarHost(snackbars, Modifier.align(Alignment.BottomCenter))
    }

    items.firstOrNull { it.id == detailsId }?.let { item ->
        DownloadSheet(
            item = item,
            onOpenFile = { open(item) },
            onRemove = {
                detailsId = null
                trash(item)
            },
            onDismiss = { detailsId = null },
        )
    }

    confirmRemove?.let { item ->
        AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text("Remove download?") },
            text = { Text(item.name, maxLines = 2, overflow = TextOverflow.Ellipsis) },
            confirmButton = {
                Column(horizontalAlignment = Alignment.End) {
                    TextButton(onClick = {
                        confirmRemove = null
                        scope.launch {
                            hakobu.manager.remove(item.id, false)
                            if (snackbars.showSnackbar("Removed from the list", "Undo", duration = SnackbarDuration.Short) == SnackbarResult.ActionPerformed) {
                                hakobu.manager.restore(item)
                            }
                        }
                    }) { Text("Remove from list") }
                    if (item.storeRef != null) {
                        TextButton(onClick = {
                            confirmRemove = null
                            scope.launch { hakobu.manager.remove(item.id, true) }
                        }) { Text("Also delete the file", color = MaterialTheme.colorScheme.error) }
                    }
                    TextButton(onClick = { confirmRemove = null }) { Text("Cancel") }
                }
            },
        )
    }
}

/** Swipe the card left to uncover a trash button. The swipe alone never removes anything. */
@Composable
private fun SwipeToReveal(onTrash: () -> Unit, content: @Composable () -> Unit) {
    val scope = rememberCoroutineScope()
    val width = with(LocalDensity.current) { 88.dp.toPx() }
    val offset = remember { Animatable(0f) }
    Box(Modifier.fillMaxWidth().height(IntrinsicSize.Min)) {
        if (offset.value < 0f) {
            Box(
                Modifier.matchParentSize().clip(RoundedCornerShape(18.dp)).background(MaterialTheme.colorScheme.errorContainer),
                contentAlignment = Alignment.CenterEnd,
            ) {
                IconButton(
                    onClick = {
                        onTrash()
                        scope.launch { offset.animateTo(0f) }
                    },
                    modifier = Modifier.width(88.dp).fillMaxHeight(),
                ) { Icon(Icons.Filled.Delete, "Remove", tint = MaterialTheme.colorScheme.onErrorContainer) }
            }
        }
        Box(
            Modifier
                .offset { IntOffset(offset.value.roundToInt(), 0) }
                .draggable(
                    orientation = Orientation.Horizontal,
                    state = rememberDraggableState { delta -> scope.launch { offset.snapTo((offset.value + delta).coerceIn(-width, 0f)) } },
                    onDragStopped = { scope.launch { offset.animateTo(if (offset.value < -width / 2) -width else 0f) } },
                ),
        ) { content() }
    }
}

@Composable
private fun DownloadRow(item: DownloadItem, onPause: () -> Unit, onResume: () -> Unit, onOpen: () -> Unit, onDetails: () -> Unit) {
    val dim = item.status == Status.HANDED_OFF
    Card(
        onClick = onDetails,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        colors = CardDefaults.cardColors(
            containerColor = if (dim) MaterialTheme.colorScheme.surfaceContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
        ),
    ) {
        Column(Modifier.padding(start = 14.dp, end = 4.dp, top = 10.dp, bottom = 10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (item.via == Route.YTDLP) {
                    Box(Modifier.padding(end = 12.dp).width(64.dp).height(40.dp).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceContainerHighest)) {
                        if (item.thumbnail != null) AsyncImage(model = item.thumbnail, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                    }
                }
                Column(Modifier.weight(1f)) {
                    Text(item.name, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
                    Text(
                        statusLine(item),
                        style = MaterialTheme.typography.bodySmall,
                        color = if (item.status == Status.FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                when (item.status) {
                    Status.ACTIVE, Status.QUEUED, Status.RESOLVING -> IconButton(onClick = onPause) { Icon(Icons.Filled.Pause, "Pause") }
                    Status.PAUSED -> IconButton(onClick = onResume) { Icon(Icons.Filled.PlayArrow, "Resume") }
                    Status.FAILED -> IconButton(onClick = onResume) { Icon(Icons.Filled.Refresh, "Retry") }
                    Status.COMPLETED -> IconButton(onClick = onOpen) { Icon(Icons.AutoMirrored.Filled.OpenInNew, "Open") }
                    Status.HANDED_OFF -> {}
                }
            }
            if (item.status == Status.ACTIVE || item.status == Status.RESOLVING || item.status == Status.PAUSED) {
                Spacer(Modifier.height(6.dp))
                val unknown = item.status == Status.ACTIVE && (item.size ?: 0) <= 0
                if (unknown) LinearProgressIndicator(Modifier.fillMaxWidth().padding(end = 10.dp))
                else LinearProgressIndicator(progress = { item.progress.toFloat() }, modifier = Modifier.fillMaxWidth().padding(end = 10.dp))
            }
        }
    }
}

private fun statusLine(item: DownloadItem): String {
    if (item.via == Route.YTDLP) return mediaStatus(item)
    val pct = "${(item.progress * 100).toInt()}%"
    return when (item.status) {
        Status.QUEUED -> "Waiting" + (item.size?.let { " · ${formatBytes(it)}" } ?: "")
        Status.ACTIVE -> buildList {
            if ((item.size ?: 0) > 0) add(pct)
            add(if ((item.size ?: 0) > 0) "${formatBytes(item.downloaded)} of ${formatBytes(item.size)}" else formatBytes(item.downloaded))
            if (item.speed > 0) add(formatSpeed(item.speed))
            item.size?.let { formatEta(it - item.downloaded, item.speed) }?.let { add(it) }
        }.joinToString(" · ")
        Status.RESOLVING -> "${item.via.label}: ${item.remoteState ?: "starting"}" + (if (item.remoteProgress > 0) " · $pct" else "") +
            (if (item.speed > 0) " · ${formatSpeed(item.speed)}" else "")
        Status.PAUSED -> "Paused" + (if ((item.size ?: 0) > 0) " · $pct of ${formatBytes(item.size)}" else "")
        Status.COMPLETED -> formatBytes(item.size) + " · Saved to Download/Hakobu"
        Status.FAILED -> item.error ?: "Failed"
        Status.HANDED_OFF -> "${item.via.label} finished · ${item.childIds.size} file${if (item.childIds.size == 1) "" else "s"} sent to downloads"
    }
}
