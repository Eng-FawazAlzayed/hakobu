package app.hakobu.core

import java.io.File
import java.io.RandomAccessFile
import java.nio.channels.FileChannel

/** A file the engine is writing. [ref] is opaque to the engine (a path on the JVM, a content URI on Android). */
data class StoredFile(val ref: String, val name: String)

/**
 * Where downloads are written. The engine only needs positional writes, so the Android app can write
 * straight into MediaStore's Downloads collection instead of a private folder.
 */
interface FileStore {
    /** Reserve a new partial file named [name] (or a free variant) in [folder], relative to the download root. */
    fun create(folder: String, name: String): StoredFile

    /** Channel for positional writes into the partial file; the caller closes it. */
    fun open(ref: String): FileChannel

    fun exists(ref: String): Boolean

    /** Turn the partial file into the finished one. Returns a ref that opens the finished file. */
    fun finish(ref: String): String

    fun delete(ref: String)
}

/** Plain directory store: writes "name.part" and renames it when done. Used by tests and desktop JVMs. */
class LocalFileStore(private val root: File) : FileStore {
    private fun dir(folder: String): File {
        val d = if (folder.isEmpty()) root else File(root, folder)
        val canonicalRoot = root.canonicalFile
        require(d.canonicalFile == canonicalRoot || d.canonicalFile.startsWith(canonicalRoot)) { "Refusing path outside download folder: $folder" }
        return d
    }

    @Synchronized
    override fun create(folder: String, name: String): StoredFile {
        val d = dir(folder).apply { mkdirs() }
        val unique = Names.uniqueName(name) { File(d, it).exists() || File(d, "$it.part").exists() }
        val part = File(d, "$unique.part")
        part.createNewFile()
        return StoredFile(part.path, unique)
    }

    override fun open(ref: String): FileChannel = RandomAccessFile(ref, "rw").channel

    override fun exists(ref: String) = File(ref).exists()

    override fun finish(ref: String): String {
        val part = File(ref)
        val done = File(ref.removeSuffix(".part"))
        if (part.path != done.path && !part.renameTo(done)) error("Couldn't rename ${part.name}")
        return done.path
    }

    override fun delete(ref: String) {
        File(ref).delete()
    }
}
