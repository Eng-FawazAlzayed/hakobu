package app.hakobu.android

import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import app.hakobu.core.FileStore
import app.hakobu.core.StoredFile
import java.io.IOException
import java.nio.channels.FileChannel

/**
 * Writes downloads straight into the public Download/Hakobu folder through MediaStore, so no storage
 * permission is needed and files show up in the Files app. Unfinished files stay "pending" (hidden).
 */
class MediaStoreFileStore(context: Context, private val root: String = "Hakobu") : FileStore {
    private val resolver = context.contentResolver
    private val collection: Uri = MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)

    fun mimeType(name: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase()) ?: "application/octet-stream"

    override fun create(folder: String, name: String): StoredFile {
        val relative = listOf(Environment.DIRECTORY_DOWNLOADS, root, folder).filter { it.isNotEmpty() }.joinToString("/") + "/"
        val values = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.RELATIVE_PATH, relative)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeType(name))
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }
        val uri = resolver.insert(collection, values) ?: throw IOException("Couldn't create $name in Downloads")
        // MediaStore renames clashes to "name (1).ext"; report the name it actually used.
        return StoredFile(uri.toString(), displayName(uri) ?: name)
    }

    private fun displayName(uri: Uri): String? =
        resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst()) c.getString(0) else null
        }

    override fun open(ref: String): FileChannel {
        val pfd = resolver.openFileDescriptor(Uri.parse(ref), "rw") ?: throw IOException("Couldn't open the download file")
        // Closing the channel closes the stream, which closes the descriptor.
        return ParcelFileDescriptor.AutoCloseOutputStream(pfd).channel
    }

    override fun exists(ref: String): Boolean = try {
        resolver.query(Uri.parse(ref), arrayOf(MediaStore.MediaColumns._ID), null, null, null)?.use { it.count > 0 } ?: false
    } catch (e: Exception) {
        false
    }

    override fun finish(ref: String): String {
        resolver.update(Uri.parse(ref), ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        return ref
    }

    override fun delete(ref: String) {
        runCatching { resolver.delete(Uri.parse(ref), null, null) }
    }
}
