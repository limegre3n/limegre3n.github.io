package io.github.limegre3n.heif2jpeg

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document

/** Storage Access Framework helpers for a folder (tree) the user picked. */
object FolderAccess {
    private val EXTENSIONS = mapOf("heic" to PhotoKind.HEIF, "heif" to PhotoKind.HEIF, "hif" to PhotoKind.HEIF, "arw" to PhotoKind.RAW)
    private val MIMES = mapOf("image/heif" to PhotoKind.HEIF, "image/heic" to PhotoKind.HEIF, "image/x-sony-arw" to PhotoKind.RAW)

    data class Listing(val photos: List<Photo>, val allNames: Set<String>)

    fun folderName(tree: Uri): String =
        DocumentsContract.getTreeDocumentId(tree).substringAfterLast(':').substringAfterLast('/').ifEmpty { "Storage" }

    fun parentUri(tree: Uri): Uri =
        DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))

    fun list(resolver: ContentResolver, tree: Uri): Listing {
        val photos = mutableListOf<Photo>()
        val names = mutableSetOf<String>()
        val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
        resolver.query(
            children,
            arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE),
            null, null, null,
        )?.use { c ->
            while (c.moveToNext()) {
                val id = c.getString(0) ?: continue
                val name = c.getString(1) ?: continue
                val mime = c.getString(2) ?: ""
                names.add(name.lowercase())
                if (mime == Document.MIME_TYPE_DIR) continue
                val kind = EXTENSIONS[name.substringAfterLast('.', "").lowercase()] ?: MIMES[mime] ?: continue
                photos += Photo(
                    DocumentsContract.buildDocumentUriUsingTree(tree, id), name,
                    if (c.isNull(3)) 0 else c.getLong(3), kind,
                )
            }
        }
        return Listing(photos.sortedBy { it.name.lowercase() }, names)
    }

    fun queryName(resolver: ContentResolver, uri: Uri): String? = runCatching {
        resolver.query(uri, arrayOf(Document.COLUMN_DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null }
    }.getOrNull()

    fun querySize(resolver: ContentResolver, uri: Uri): Long = runCatching {
        resolver.query(uri, arrayOf(Document.COLUMN_SIZE), null, null, null)
            ?.use { if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else 0L }
    }.getOrNull() ?: 0L
}

/** Converts one photo into the picked folder. Runs on a worker thread. */
class PhotoConverter(private val resolver: ContentResolver, tree: Uri, existingNames: Set<String>) {
    private val parent = FolderAccess.parentUri(tree)
    private val taken = existingNames.toMutableSet()

    data class Result(val ok: Boolean, val outName: String?, val outBytes: Long, val note: String?, val originalDeleted: Boolean)

    fun convert(photo: Photo, settings: Settings): Result {
        val format = settings.format
        val preset = settings.preset
        val input = try {
            resolver.openInputStream(photo.uri)?.use { it.readBytes() } ?: return fail("Can't open the file")
        } catch (e: OutOfMemoryError) {
            return fail("File too large to load")
        } catch (e: Exception) {
            return fail(e.message ?: "Can't read the file")
        }

        val base = photo.name.substringBeforeLast('.')
        val target = uniqueName(base, format.extension)
        val outUri = runCatching {
            DocumentsContract.createDocument(resolver, parent, format.mime, target)
        }.getOrNull() ?: runCatching {
            // Some providers don't know image/avif: fall back to a generic type.
            DocumentsContract.createDocument(resolver, parent, "application/octet-stream", target)
        }.getOrNull() ?: return fail("Can't create $target")

        val result = try {
            resolver.openFileDescriptor(outUri, "w")?.use { pfd ->
                NativeConverter.convert(input, pfd.fd, format.nativeId, preset.quality, preset.subsample420, settings.keepMetadata)
            } ?: "ERR|Can't open the output file"
        } catch (e: Throwable) {
            "ERR|${e.message}"
        }
        if (!result.startsWith("OK|")) {
            runCatching { DocumentsContract.deleteDocument(resolver, outUri) }
            return fail(result.removePrefix("ERR|"))
        }

        var finalUri = outUri
        var savedName = FolderAccess.queryName(resolver, outUri) ?: target
        if (!savedName.endsWith(".${format.extension}", ignoreCase = true)) {
            runCatching { DocumentsContract.renameDocument(resolver, outUri, target) }.getOrNull()?.let {
                finalUri = it
                savedName = target
            }
        }
        taken.add(savedName.lowercase())
        val outBytes = FolderAccess.querySize(resolver, finalUri)

        var deleted = false
        var note = result.split('|', limit = 3).getOrNull(2)?.trim()?.ifEmpty { null }
        if (settings.replaceOriginals) {
            if (outBytes > 0) {
                deleted = runCatching { DocumentsContract.deleteDocument(resolver, photo.uri) }.getOrDefault(false)
                if (!deleted) note = listOfNotNull(note, "Couldn't delete the original.").joinToString(" ")
            } else {
                note = listOfNotNull(note, "Output looked empty, so the original was kept.").joinToString(" ")
            }
        }
        return Result(true, savedName, outBytes, note, deleted)
    }

    private fun uniqueName(base: String, ext: String): String {
        var name = "$base.$ext"
        var i = 1
        while (name.lowercase() in taken) name = "${base}_${i++}.$ext"
        taken.add(name.lowercase())
        return name
    }

    private fun fail(msg: String) = Result(false, null, 0, msg, false)
}
