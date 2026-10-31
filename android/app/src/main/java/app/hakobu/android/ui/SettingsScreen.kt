@file:OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)

package app.hakobu.android.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.hakobu.android.BuildConfig
import app.hakobu.android.Hakobu
import app.hakobu.core.MediaFormats
import app.hakobu.core.Route
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

@Composable
fun SettingsScreen(hakobu: Hakobu, modifier: Modifier) {
    val s by hakobu.settings.collectAsState()
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Settings", style = MaterialTheme.typography.headlineMedium)

        Section("Media") {
            Text("Default format", style = MaterialTheme.typography.labelLarge)
            val formats = listOf("mp4" to "Video · MP4", "mp3" to "Audio · MP3")
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                formats.forEachIndexed { i, (f, label) ->
                    SegmentedButton(
                        selected = s.ytFormat == f,
                        onClick = { hakobu.updateSettings { it.copy(ytFormat = f) } },
                        shape = SegmentedButtonDefaults.itemShape(i, formats.size),
                    ) { Text(label) }
                }
            }
            ChoiceRow("Video quality", MediaFormats.VIDEO_QUALITIES, s.ytVideoQuality, MediaFormats::videoLabel) { q -> hakobu.updateSettings { it.copy(ytVideoQuality = q) } }
            ChoiceRow("Audio quality", MediaFormats.AUDIO_QUALITIES, s.ytAudioQuality, { "$it kbps" }) { q -> hakobu.updateSettings { it.copy(ytAudioQuality = q) } }
            YtDlpRow(hakobu)
        }

        Section("Debrid") {
            Text(
                "TorBox and Real-Debrid download torrents and hoster links in the cloud, then Hakobu fetches the files directly. Keys are encrypted on this phone and only sent to the provider.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            KeyField("TorBox API key", s.torboxKey, Route.TORBOX, hakobu) { v -> hakobu.updateSettings { it.copy(torboxKey = v) } }
            KeyField("Real-Debrid API token", s.realdebridToken, Route.REALDEBRID, hakobu) { v -> hakobu.updateSettings { it.copy(realdebridToken = v) } }
            Text("Preferred service", style = MaterialTheme.typography.labelLarge)
            val choices = listOf(Route.TORBOX, Route.REALDEBRID)
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                choices.forEachIndexed { i, r ->
                    SegmentedButton(
                        selected = s.preferredDebrid == r,
                        onClick = { hakobu.updateSettings { it.copy(preferredDebrid = r) } },
                        shape = SegmentedButtonDefaults.itemShape(i, choices.size),
                    ) { Text(r.label) }
                }
            }
        }

        Section("Downloads") {
            SliderSetting("Connections per download", s.connectionsPerDownload, 1..16) { v -> hakobu.updateSettings { it.copy(connectionsPerDownload = v) } }
            SliderSetting("Downloads at once", s.maxActive, 1..6) { v -> hakobu.updateSettings { it.copy(maxActive = v) } }
            var limit by remember { mutableStateOf(if (s.speedLimitKB > 0) s.speedLimitKB.toString() else "") }
            OutlinedTextField(
                value = limit,
                onValueChange = { v ->
                    limit = v.filter(Char::isDigit).take(7)
                    hakobu.updateSettings { it.copy(speedLimitKB = limit.toIntOrNull() ?: 0) }
                },
                label = { Text("Speed limit (KB/s, empty = unlimited)") },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true,
                modifier = Modifier.fillMaxWidth(),
            )
            Text(
                "Files are saved to Download/Hakobu. Unfinished downloads that sit paused for more than a week may be cleaned up by Android.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }

        Section("About") {
            Text("Hakobu ${BuildConfig.VERSION_NAME} for Android", style = MaterialTheme.typography.bodyMedium)
            Text(
                "Videos and music via yt-dlp, plus direct links, hoster links and torrents through TorBox or Real-Debrid. P2P torrents are coming.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ChoiceRow(label: String, options: List<String>, selected: String, display: (String) -> String, onPick: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEach { o ->
                FilterChip(selected = o == selected, onClick = { onPick(o) }, label = { Text(display(o)) })
            }
        }
    }
}

@Composable
private fun YtDlpRow(hakobu: Hakobu) {
    var version by remember { mutableStateOf<String?>(null) }
    var status by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(Unit) {
        version = runCatching { hakobu.media.ensureReady(); hakobu.media.version() }.getOrNull()
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Text("yt-dlp ${version ?: ""}".trim(), style = MaterialTheme.typography.bodyMedium)
            Text(status ?: "Updated automatically once a day", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        OutlinedButton(onClick = {
            status = "Updating…"
            scope.launch {
                status = try {
                    version = hakobu.media.update(force = true)
                    "Up to date"
                } catch (e: Exception) {
                    "Update failed: ${e.message?.take(80)}"
                }
            }
        }) { Text("Update") }
    }
}

@Composable
private fun Section(title: String, content: @Composable () -> Unit) {
    Card(
        shape = androidx.compose.foundation.shape.RoundedCornerShape(18.dp),
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerHigh),
    ) {
        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun KeyField(label: String, value: String, route: Route, hakobu: Hakobu, onChange: (String) -> Unit) {
    var text by remember { mutableStateOf(value) }
    var result by remember { mutableStateOf<String?>(null) }
    var ok by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        OutlinedTextField(
            value = text,
            onValueChange = {
                text = it.trim()
                result = null
                onChange(text)
            },
            label = { Text(label) },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            modifier = Modifier.fillMaxWidth(),
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            OutlinedButton(enabled = text.isNotBlank(), onClick = {
                result = "Checking…"
                scope.launch {
                    val r = runCatching { hakobu.provider(route, hakobu.settings.value).user() }
                    ok = r.isSuccess && r.getOrNull()?.premium == true
                    result = r.fold(
                        onSuccess = { u ->
                            val who = u.username ?: "your account"
                            if (u.premium) "Signed in as $who · Premium" + (u.expires?.let { " until ${it.take(10)}" } ?: "")
                            else "Signed in as $who, but the account isn't premium"
                        },
                        onFailure = { it.message ?: "Couldn't sign in" },
                    )
                }
            }) { Text("Test") }
            result?.let {
                Text(
                    it,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (ok || it == "Checking…") MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                )
            }
        }
    }
}

@Composable
private fun SliderSetting(label: String, value: Int, range: IntRange, onChange: (Int) -> Unit) {
    var v by remember(value) { mutableStateOf(value.toFloat()) }
    Column {
        Text("$label: ${v.roundToInt()}", style = MaterialTheme.typography.labelLarge)
        Slider(
            value = v,
            onValueChange = { v = it },
            onValueChangeFinished = { onChange(v.roundToInt()) },
            valueRange = range.first.toFloat()..range.last.toFloat(),
            steps = range.last - range.first - 1,
        )
    }
}
