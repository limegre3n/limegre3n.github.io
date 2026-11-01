package io.github.limegre3n.heif2jpeg

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.DocumentsContract
import android.view.View
import android.view.WindowManager
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.ListView
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.util.concurrent.Executors

class MainActivity : Activity() {

    private data class HeifFile(val uri: Uri, val name: String, val size: Long)

    private lateinit var folderInfo: TextView
    private lateinit var fileList: ListView
    private lateinit var replaceBox: CheckBox
    private lateinit var convertBtn: Button
    private lateinit var progress: ProgressBar
    private lateinit var logView: TextView
    private lateinit var logScroll: ScrollView

    private var treeUri: Uri? = null
    private var files: List<HeifFile> = emptyList()
    private val existingNames = mutableSetOf<String>()
    private val worker = Executors.newSingleThreadExecutor()
    private var busy = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val root = findViewById<View>(R.id.root)
        val pad = root.paddingLeft
        root.setOnApplyWindowInsetsListener { v, insets ->
            @Suppress("DEPRECATION")
            v.setPadding(
                pad + insets.systemWindowInsetLeft, pad + insets.systemWindowInsetTop,
                pad + insets.systemWindowInsetRight, pad + insets.systemWindowInsetBottom
            )
            insets
        }

        folderInfo = findViewById(R.id.folderInfo)
        fileList = findViewById(R.id.fileList)
        replaceBox = findViewById(R.id.replaceOriginals)
        convertBtn = findViewById(R.id.convert)
        progress = findViewById(R.id.progress)
        logView = findViewById(R.id.log)
        logScroll = findViewById(R.id.logScroll)

        findViewById<Button>(R.id.pickFolder).setOnClickListener {
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
            startActivityForResult(intent, REQ_TREE)
        }
        findViewById<Button>(R.id.selectAll).setOnClickListener { setAllChecked(true) }
        findViewById<Button>(R.id.selectNone).setOnClickListener { setAllChecked(false) }
        fileList.setOnItemClickListener { _, _, _, _ -> updateConvertButton() }
        convertBtn.setOnClickListener { onConvertClicked() }

        // Re-open the last folder if we still hold permission for it.
        contentResolver.persistedUriPermissions.lastOrNull { it.isWritePermission }?.let {
            loadFolder(it.uri)
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_TREE && resultCode == RESULT_OK) {
            val uri = data?.data ?: return
            try {
                contentResolver.takePersistableUriPermission(
                    uri, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                )
            } catch (_: SecurityException) {
            }
            loadFolder(uri)
        }
    }

    private fun loadFolder(tree: Uri) {
        treeUri = tree
        val found = mutableListOf<HeifFile>()
        existingNames.clear()
        try {
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(
                tree, DocumentsContract.getTreeDocumentId(tree)
            )
            contentResolver.query(
                children,
                arrayOf(
                    DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                    DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                    DocumentsContract.Document.COLUMN_MIME_TYPE,
                    DocumentsContract.Document.COLUMN_SIZE
                ),
                null, null, null
            )?.use { c ->
                while (c.moveToNext()) {
                    val id = c.getString(0)
                    val name = c.getString(1) ?: continue
                    val mime = c.getString(2) ?: ""
                    existingNames.add(name.lowercase())
                    if (mime == DocumentsContract.Document.MIME_TYPE_DIR) continue
                    val ext = name.substringAfterLast('.', "").lowercase()
                    if (ext in HEIF_EXTENSIONS || mime == "image/heif" || mime == "image/heic") {
                        found += HeifFile(
                            DocumentsContract.buildDocumentUriUsingTree(tree, id), name,
                            if (c.isNull(3)) 0 else c.getLong(3)
                        )
                    }
                }
            }
        } catch (e: Exception) {
            log("Cannot read folder: ${e.message}")
        }
        files = found.sortedBy { it.name.lowercase() }
        val folderName = DocumentsContract.getTreeDocumentId(tree).substringAfterLast(':').ifEmpty { "/" }
        folderInfo.text = "Folder: $folderName  -  ${files.size} HEIF file(s)"
        fileList.adapter = ArrayAdapter(
            this, android.R.layout.simple_list_item_multiple_choice,
            files.map { "${it.name}   (${formatSize(it.size)})" }
        )
        setAllChecked(true)
    }

    private fun setAllChecked(checked: Boolean) {
        for (i in files.indices) fileList.setItemChecked(i, checked)
        updateConvertButton()
    }

    private fun selectedFiles(): List<HeifFile> {
        val checked = fileList.checkedItemPositions
        return files.filterIndexed { i, _ -> checked.get(i) }
    }

    private fun updateConvertButton() {
        val n = selectedFiles().size
        convertBtn.isEnabled = !busy && n > 0
        convertBtn.text = if (n > 0) "Convert $n file(s)" else "Convert"
    }

    private fun onConvertClicked() {
        val selection = selectedFiles()
        if (selection.isEmpty()) return
        val replace = replaceBox.isChecked
        if (replace) {
            AlertDialog.Builder(this)
                .setTitle("Replace originals?")
                .setMessage(
                    "${selection.size} HEIF file(s) will be permanently deleted after each one " +
                        "is converted successfully. Files that fail to convert are kept."
                )
                .setPositiveButton("Convert & replace") { _, _ -> startConversion(selection, true) }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        } else {
            startConversion(selection, false)
        }
    }

    private fun startConversion(selection: List<HeifFile>, replace: Boolean) {
        val tree = treeUri ?: return
        busy = true
        updateConvertButton()
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        progress.visibility = View.VISIBLE
        progress.max = selection.size
        progress.progress = 0
        logView.text = ""

        worker.execute {
            val parent = DocumentsContract.buildDocumentUriUsingTree(
                tree, DocumentsContract.getTreeDocumentId(tree)
            )
            var ok = 0
            var failed = 0
            selection.forEachIndexed { index, f ->
                val t0 = System.currentTimeMillis()
                val result = convertOne(parent, f, replace)
                val secs = (System.currentTimeMillis() - t0) / 1000.0
                if (result.startsWith("OK")) ok++ else failed++
                runOnUiThread {
                    log("${f.name}: $result (%.1fs)".format(secs))
                    progress.progress = index + 1
                }
            }
            runOnUiThread {
                log("Done: $ok converted, $failed failed.")
                busy = false
                progress.visibility = View.GONE
                window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                loadFolder(tree)
            }
        }
    }

    /** Converts one file; returns a human-readable status line. Runs on the worker thread. */
    private fun convertOne(parent: Uri, f: HeifFile, replace: Boolean): String {
        val input = try {
            contentResolver.openInputStream(f.uri)?.use { it.readBytes() }
                ?: return "FAILED - cannot open"
        } catch (e: OutOfMemoryError) {
            return "FAILED - file too large to load"
        } catch (e: Exception) {
            return "FAILED - ${e.message}"
        }

        val targetName = uniqueJpegName(f.name.substringBeforeLast('.'))
        val outUri = try {
            DocumentsContract.createDocument(contentResolver, parent, "image/jpeg", targetName)
        } catch (e: Exception) {
            null
        } ?: return "FAILED - cannot create $targetName"

        val result = try {
            contentResolver.openFileDescriptor(outUri, "w")?.use { pfd ->
                NativeConverter.convert(input, pfd.fd, 100)
            } ?: "ERR|cannot open output"
        } catch (e: Throwable) {
            "ERR|${e.message}"
        }

        if (!result.startsWith("OK|")) {
            runCatching { DocumentsContract.deleteDocument(contentResolver, outUri) }
            return "FAILED - ${result.removePrefix("ERR|")}"
        }
        val parts = result.split('|', limit = 3)
        val savedName = queryName(outUri) ?: targetName
        existingNames.add(savedName.lowercase())
        val sb = StringBuilder("OK -> $savedName (${parts.getOrElse(1) { "" }})")

        if (replace) {
            val outSize = querySize(outUri)
            if (outSize > 0) {
                val deleted = runCatching {
                    DocumentsContract.deleteDocument(contentResolver, f.uri)
                }.getOrDefault(false)
                sb.append(if (deleted) ", original deleted" else ", could NOT delete original")
            } else {
                sb.append(", output looks empty so original was kept")
            }
        }
        parts.getOrNull(2)?.trim()?.takeIf { it.isNotEmpty() }?.let { sb.append("\n   note: ").append(it) }
        return sb.toString()
    }

    private fun uniqueJpegName(base: String): String {
        var name = "$base.jpg"
        var i = 1
        while (name.lowercase() in existingNames) name = "${base}_${i++}.jpg"
        existingNames.add(name.lowercase())
        return name
    }

    private fun queryName(uri: Uri): String? = runCatching {
        contentResolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_DISPLAY_NAME), null, null, null)
            ?.use { if (it.moveToFirst()) it.getString(0) else null }
    }.getOrNull()

    private fun querySize(uri: Uri): Long = runCatching {
        contentResolver.query(uri, arrayOf(DocumentsContract.Document.COLUMN_SIZE), null, null, null)
            ?.use { if (it.moveToFirst() && !it.isNull(0)) it.getLong(0) else 0L }
    }.getOrNull() ?: 0L

    private fun log(line: String) {
        logView.append(line + "\n")
        logScroll.post { logScroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun formatSize(bytes: Long): String =
        if (bytes >= 1 shl 20) "%.1f MB".format(bytes / 1048576.0) else "${bytes / 1024} KB"

    override fun onDestroy() {
        super.onDestroy()
        worker.shutdown()
    }

    companion object {
        private const val REQ_TREE = 1
        private val HEIF_EXTENSIONS = setOf("heic", "heif", "hif")
    }
}
