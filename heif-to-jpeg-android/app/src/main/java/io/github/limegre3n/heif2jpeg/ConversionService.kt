package io.github.limegre3n.heif2jpeg

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Runs the conversion queue in the background (foreground service, so it keeps going
 * when the user leaves the app) and shows a progress notification.
 */
class ConversionService : Service() {

    private val handler = Handler(Looper.getMainLooper())
    private var worker: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null

    private val ticker = object : Runnable {
        override fun run() {
            val job = JobTracker.state.value ?: return
            if (job.finished) return
            notificationManager().notify(PROGRESS_ID, progressNotification(job))
            handler.postDelayed(this, 1000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            JobTracker.update { it.copy(stopRequested = true) }
            return START_NOT_STICKY
        }
        val job = JobTracker.state.value
        if (job == null || job.finished || worker != null) {
            if (worker == null) stopSelf()
            return START_NOT_STICKY
        }
        createChannels()
        ServiceCompat.startForeground(
            this, PROGRESS_ID, progressNotification(job),
            if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC else 0,
        )
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "heif2jpeg:convert")
            .apply { acquire(6 * 60 * 60 * 1000L) }
        handler.postDelayed(ticker, 1000)
        worker = Thread({ runJob() }, "converter").apply { start() }
        return START_NOT_STICKY
    }

    private fun runJob() {
        val start = JobTracker.state.value ?: return
        val existing = runCatching { FolderAccess.list(contentResolver, start.treeUri).allNames }.getOrDefault(emptySet())
        val converter = PhotoConverter(contentResolver, start.treeUri, existing)

        for (index in start.items.indices) {
            val job = JobTracker.state.value ?: break
            if (job.stopRequested) break
            val photo = job.items[index].photo
            val t0 = System.currentTimeMillis()
            JobTracker.update { s ->
                s.copy(
                    currentIndex = index, currentStartedAtMs = t0,
                    items = s.items.mapIndexed { i, it -> if (i == index) it.copy(status = ItemStatus.Active) else it },
                )
            }
            val r = converter.convert(photo, job.settings)
            val seconds = (System.currentTimeMillis() - t0) / 1000.0
            JobTracker.update { s ->
                val m = s.measured.toMutableMap()
                if (r.ok) {
                    val (ps, pmb) = m[photo.kind] ?: (0.0 to 0.0)
                    m[photo.kind] = (ps + seconds) to (pmb + photo.size / 1e6)
                }
                s.copy(
                    measured = m,
                    items = s.items.mapIndexed { i, it ->
                        if (i != index) it else it.copy(
                            status = if (r.ok) ItemStatus.Done else ItemStatus.Failed,
                            outName = r.outName, outBytes = r.outBytes, note = r.note,
                            originalDeleted = r.originalDeleted,
                        )
                    },
                )
            }
            handler.post { JobTracker.state.value?.let { notificationManager().notify(PROGRESS_ID, progressNotification(it)) } }
        }

        JobTracker.update { s ->
            s.copy(
                finished = true, endedAtMs = System.currentTimeMillis(), currentIndex = -1,
                items = s.items.map { if (it.status == ItemStatus.Waiting || it.status == ItemStatus.Active) it.copy(status = ItemStatus.Skipped) else it },
            )
        }
        handler.post { finish() }
    }

    private fun finish() {
        handler.removeCallbacks(ticker)
        val job = JobTracker.state.value
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        if (job != null) notificationManager().notify(DONE_ID, doneNotification(job))
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        worker = null
        stopSelf()
    }

    override fun onDestroy() {
        handler.removeCallbacks(ticker)
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }

    private fun notificationManager() = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this, 0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun progressNotification(job: JobState): Notification {
        val est = JobTracker.estimate(job, System.currentTimeMillis())
        val stop = PendingIntent.getService(
            this, 1, Intent(this, ConversionService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val left = job.remaining
        val text = if (job.stopRequested) "Stopping after the current photo…"
        else "${job.processed} done · $left left · about ${formatDuration(est.secondsLeft)}"
        return NotificationCompat.Builder(this, CHANNEL_PROGRESS)
            .setSmallIcon(R.drawable.ic_stat_convert)
            .setContentTitle("Converting ${job.total} photos")
            .setContentText(text)
            .setSubText("${(est.overall * 100).toInt()}%")
            .setProgress(1000, (est.overall * 1000).toInt(), false)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setContentIntent(openAppIntent())
            .addAction(0, "Stop", stop)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    private fun doneNotification(job: JobState): Notification {
        val secs = (job.endedAtMs - job.startedAtMs) / 1000.0
        val title = when {
            job.skipped > 0 -> "Stopped: ${job.done} of ${job.total} converted"
            job.failed > 0 -> "${job.done} converted, ${job.failed} failed"
            else -> "${job.done} photos converted"
        }
        return NotificationCompat.Builder(this, CHANNEL_DONE)
            .setSmallIcon(R.drawable.ic_stat_convert)
            .setContentTitle(title)
            .setContentText("${formatBytes(job.outBytes)} · took ${formatDuration(secs)}")
            .setAutoCancel(true)
            .setContentIntent(openAppIntent())
            .build()
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = notificationManager()
        nm.createNotificationChannel(NotificationChannel(CHANNEL_PROGRESS, "Conversion progress", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(CHANNEL_DONE, "Conversion finished", NotificationManager.IMPORTANCE_DEFAULT))
    }

    companion object {
        private const val CHANNEL_PROGRESS = "progress"
        private const val CHANNEL_DONE = "done"
        private const val PROGRESS_ID = 1
        private const val DONE_ID = 2
        private const val ACTION_STOP = "io.github.limegre3n.heif2jpeg.STOP"

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, ConversionService::class.java))
        }

        fun stop(context: Context) {
            context.startService(Intent(context, ConversionService::class.java).setAction(ACTION_STOP))
        }
    }
}
