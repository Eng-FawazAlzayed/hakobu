package app.hakobu.android.ui

import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.hakobu.core.DownloadItem
import app.hakobu.core.Status
import coil3.compose.AsyncImage

/** A download's details: where it came from, and what can be done with that link and the file. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DownloadSheet(item: DownloadItem, onOpenFile: () -> Unit, onRemove: () -> Unit, onDismiss: () -> Unit) {
    val context = LocalContext.current
    val link = item.source
    val isWebLink = link.startsWith("http://", ignoreCase = true) || link.startsWith("https://", ignoreCase = true)
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (item.thumbnail != null) {
                Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.surfaceContainerHighest)) {
                    AsyncImage(model = item.thumbnail, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                }
            }
            Text(item.name, style = MaterialTheme.typography.titleMedium)
            Column {
                Text("Original link", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                SelectionContainer { Text(link, style = MaterialTheme.typography.bodyMedium) }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (isWebLink) OutlinedButton(onClick = { open(context, link) }, Modifier.weight(1f)) { Text("Open link") }
                OutlinedButton(onClick = { copy(context, link) }, Modifier.weight(1f)) { Text("Copy link") }
                OutlinedButton(onClick = { share(context, link) }, Modifier.weight(1f)) { Text("Share link") }
            }
            if (item.status == Status.COMPLETED && item.storeRef != null) {
                Button(onClick = onOpenFile, Modifier.fillMaxWidth()) { Text("Open file") }
            }
            FilledTonalButton(onClick = onRemove, Modifier.fillMaxWidth()) { Text(if (item.status == Status.COMPLETED) "Remove" else "Cancel download") }
            TextButton(onClick = onDismiss, Modifier.fillMaxWidth()) { Text("Close") }
        }
    }
}

private fun open(context: Context, link: String) {
    try {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link)))
    } catch (e: ActivityNotFoundException) {
        Toast.makeText(context, "No app can open this link", Toast.LENGTH_SHORT).show()
    }
}

private fun copy(context: Context, link: String) {
    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Link", link))
    Toast.makeText(context, "Link copied", Toast.LENGTH_SHORT).show()
}

private fun share(context: Context, link: String) {
    val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, link)
    context.startActivity(Intent.createChooser(send, "Share link"))
}
