package app.hakobu.android.ui

import android.content.Context
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RangeSlider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableDoubleStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import app.hakobu.android.Hakobu
import app.hakobu.core.MediaFormats
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Streams a track's audio so the user can hear where the trim handles are. */
private class ClipPlayer(context: Context) {
    private val exo = ExoPlayer.Builder(context).build()
    var playing by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
    val prepared get() = exo.mediaItemCount > 0
    val position get() = exo.currentPosition / 1000.0

    init {
        exo.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                playing = isPlaying
            }

            override fun onPlayerError(e: PlaybackException) {
                error = "Can't play a preview: ${e.errorCodeName}"
            }
        })
    }

    fun prepare(url: String, headers: Map<String, String>) {
        val ua = headers.entries.firstOrNull { it.key.equals("User-Agent", true) }?.value
        val http = DefaultHttpDataSource.Factory()
            .setAllowCrossProtocolRedirects(true)
            .setDefaultRequestProperties(headers.filterKeys { !it.equals("User-Agent", true) })
            .apply { if (ua != null) setUserAgent(ua) }
        exo.setMediaSource(DefaultMediaSourceFactory(http).createMediaSource(MediaItem.fromUri(url)))
        exo.prepare()
    }

    fun seek(sec: Double) = exo.seekTo((sec * 1000).toLong())
    fun play(fromSec: Double) {
        seek(fromSec)
        exo.play()
    }

    fun pause() = exo.pause()
    fun release() = exo.release()
}

/** "1:15", "1:02:05" or plain seconds -> seconds. */
private fun parseClock(text: String): Double? {
    val parts = text.trim().split(":")
    if (parts.isEmpty() || parts.size > 3) return null
    return parts.fold(0.0) { acc, p -> acc * 60 + (p.trim().toDoubleOrNull() ?: return null) }
}

/** MP3 only: download the whole track or a chosen part, with a preview to find the cut points. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrimCard(hakobu: Hakobu, url: String, durationSec: Int, state: MediaState) {
    val dur = durationSec.toFloat()
    var editing by remember { mutableStateOf<Boolean?>(null) } // true = start, false = end
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.surfaceContainerLowest).padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(MaterialTheme.colorScheme.surfaceContainer).padding(3.dp)) {
            listOf(false to "Whole track", true to "Choose a part").forEach { (on, label) ->
                val selected = state.trim == on
                Box(
                    Modifier.weight(1f).height(36.dp).clip(RoundedCornerShape(10.dp))
                        .background(if (selected) MaterialTheme.colorScheme.primaryContainer else Color.Transparent)
                        .clickable { state.trim = on },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(label, style = MaterialTheme.typography.labelLarge, color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
        if (!state.trim) return@Column

        val context = LocalContext.current
        val scope = rememberCoroutineScope()
        val player = remember(url) { ClipPlayer(context) }
        DisposableEffect(player) { onDispose { player.release() } }
        var loading by remember(url) { mutableStateOf(false) }
        var playhead by remember(url) { mutableDoubleStateOf(-1.0) }
        val range = state.clip ?: 0f..dur
        val start = range.start
        val end = range.endInclusive

        // Follow the playhead and stop at the end handle.
        LaunchedEffect(player.playing) {
            while (player.playing) {
                playhead = player.position
                if (playhead >= (state.clip?.endInclusive ?: dur)) player.pause()
                delay(50)
            }
        }

        fun setRange(s: Float, e: Float) {
            val ns = s.coerceIn(0f, dur - 1f)
            val ne = e.coerceIn(ns + 1f, dur)
            val startMoved = ns != start
            state.clip = ns..ne
            // Dragging a handle while playing jumps playback to it (a few seconds before the end handle).
            if (player.playing) player.seek(if (startMoved) ns.toDouble() else maxOf(ns.toDouble(), ne - 3.0))
        }

        Row(verticalAlignment = Alignment.CenterVertically) {
            FilledTonalButton(
                onClick = {
                    when {
                        player.playing -> player.pause()
                        player.prepared -> player.play(if (playhead in start.toDouble()..<end.toDouble()) playhead else start.toDouble())
                        else -> scope.launch {
                            loading = true
                            player.error = null
                            try {
                                val (stream, headers) = hakobu.media.audioStream(url)
                                player.prepare(stream, headers)
                                player.play(start.toDouble())
                            } catch (e: Exception) {
                                if (e is kotlinx.coroutines.CancellationException) throw e
                                player.error = MediaFormats.friendlyError(e.message)
                            } finally {
                                loading = false
                            }
                        }
                    }
                },
                enabled = !loading,
                shape = RoundedCornerShape(14.dp),
            ) {
                if (loading) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                else Icon(if (player.playing) Icons.Filled.Pause else Icons.Filled.PlayArrow, null, Modifier.size(20.dp))
                Spacer(Modifier.width(6.dp))
                Text(if (player.playing) "Pause" else "Preview")
            }
            Spacer(Modifier.weight(1f))
            Text("Length ${MediaFormats.clock((end - start).toDouble())}", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        player.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }

        RangeSlider(value = range, onValueChange = { setRange(it.start, it.endInclusive) }, valueRange = 0f..dur)

        // Selected part and playhead on the whole track.
        val sel = MaterialTheme.colorScheme.primary
        val track = MaterialTheme.colorScheme.surfaceContainerHighest
        val head = MaterialTheme.colorScheme.onSurface
        Canvas(Modifier.fillMaxWidth().height(10.dp)) {
            val r = CornerRadius(size.height / 2)
            drawRoundRect(track, cornerRadius = r)
            drawRoundRect(sel.copy(alpha = 0.55f), topLeft = Offset(size.width * start / dur, 0f), size = Size(size.width * (end - start) / dur, size.height), cornerRadius = r)
            if (playhead >= 0) {
                val x = (size.width * playhead / dur).toFloat().coerceIn(0f, size.width)
                drawRect(head, topLeft = Offset(x - 1.5f, -4f), size = Size(3f, size.height + 8f))
            }
        }

        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            HandleControls("Start", start, onTap = { editing = true }) { d -> setRange(start + d, end) }
            Spacer(Modifier.weight(1f))
            HandleControls("End", end, onTap = { editing = false }) { d -> setRange(start, end + d) }
        }
    }

    editing?.let { isStart ->
        val current = (state.clip ?: 0f..dur).let { if (isStart) it.start else it.endInclusive }
        var text by remember(isStart) { mutableStateOf(MediaFormats.clock(current.toDouble())) }
        val value = parseClock(text)
        AlertDialog(
            onDismissRequest = { editing = null },
            title = { Text(if (isStart) "Start at" else "End at") },
            text = {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    singleLine = true,
                    isError = value == null || value > durationSec,
                    supportingText = { Text("m:ss, up to ${MediaFormats.clock(durationSec.toDouble())}") },
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
            },
            confirmButton = {
                TextButton(enabled = value != null && value <= durationSec, onClick = {
                    val v = value!!.toFloat()
                    val r = state.clip ?: 0f..dur
                    val ns = if (isStart) v.coerceIn(0f, dur - 1f) else r.start
                    val ne = if (isStart) r.endInclusive else v
                    state.clip = ns.coerceAtMost(dur - 1f)..ne.coerceIn(ns + 1f, dur)
                    editing = null
                }) { Text("Set") }
            },
            dismissButton = { TextButton(onClick = { editing = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun HandleControls(label: String, sec: Float, onTap: () -> Unit, onNudge: (Float) -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = { onNudge(-1f) }) { Text("−1s") }
        Column(Modifier.clip(RoundedCornerShape(8.dp)).clickable(onClick = onTap).padding(horizontal = 8.dp, vertical = 2.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(MediaFormats.clock(sec.toDouble()), style = MaterialTheme.typography.titleMedium)
        }
        TextButton(onClick = { onNudge(1f) }) { Text("+1s") }
    }
}
