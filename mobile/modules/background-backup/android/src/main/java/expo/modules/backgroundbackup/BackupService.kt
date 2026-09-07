package expo.modules.backgroundbackup

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import androidx.core.app.NotificationCompat

class BackupService : Service() {
  private val main = Handler(Looper.getMainLooper())
  private val engine by lazy { BackupEngine.get(this) }
  private val notifications by lazy { getSystemService(NOTIFICATION_SERVICE) as NotificationManager }
  private val wakeLock by lazy {
    (getSystemService(POWER_SERVICE) as PowerManager).newWakeLock(
      PowerManager.PARTIAL_WAKE_LOCK, "$packageName:SyncachuBackup"
    ).apply { setReferenceCounted(false) }
  }
  @Volatile internal var finishing = false
    private set
  private var latestStartId = 0

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= 26) {
      notifications.createNotificationChannel(NotificationChannel(
        CHANNEL, "Photo and video backup", NotificationManager.IMPORTANCE_LOW
      ).apply {
        description = "Progress of backups started in Syncachu"
        setShowBadge(false)
      })
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    latestStartId = startId
    finishing = false
    if (intent?.action == ACTION_STOP) {
      engine.pauseFromNotification()
      finish()
      return START_NOT_STICKY
    }
    try {
      // POST_NOTIFICATIONS is requested by the UI. If denied, Android still shows this FGS in Task Manager.
      val notification = notification("Preparing saved backups…", null)
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      } else startForeground(NOTIFICATION_ID, notification)
      if (!engine.attach(this)) finish()
    } catch (_: RuntimeException) {
      engine.serviceFailure("Android could not run background backup. Keep Syncachu open, check notifications, and retry.")
      finish()
    }
    return START_NOT_STICKY
  }

  internal fun update(message: String, progress: Double?) {
    if (!finishing) notifications.notify(NOTIFICATION_ID, notification(message, progress))
  }

  internal fun keepAwake() {
    if (!finishing && !wakeLock.isHeld) wakeLock.acquire(10 * 60_000L)
  }

  internal fun releaseWakeLock() {
    if (wakeLock.isHeld) wakeLock.release()
  }

  internal fun finish() {
    if (finishing) return
    finishing = true
    val stopId = latestStartId
    releaseWakeLock()
    main.post {
      // Do not stop a more recent foreground start delivered while this stop was being posted.
      if (stopSelfResult(stopId)) stopForeground(STOP_FOREGROUND_REMOVE)
    }
  }

  override fun onTimeout(startId: Int, fgsType: Int) {
    engine.timeout(this)
    finish()
  }

  override fun onDestroy() {
    try { engine.detach(this) }
    finally {
      releaseWakeLock()
      super.onDestroy()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun notification(message: String, progress: Double?): Notification {
    val stop = PendingIntent.getService(this, 0,
      Intent(this, BackupService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val builder = NotificationCompat.Builder(this, CHANNEL)
      .setSmallIcon(R.drawable.syncachu_backup)
      .setContentTitle("Syncachu backup")
      .setContentText(message)
      .setStyle(NotificationCompat.BigTextStyle().bigText(message))
      .setCategory(NotificationCompat.CATEGORY_PROGRESS)
      .setOnlyAlertOnce(true)
      .setOngoing(true)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
      .setProgress(100, ((progress ?: 0.0) * 100).toInt(), progress == null)
      .addAction(R.drawable.syncachu_backup, "Stop backup", stop)
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      builder.setContentIntent(PendingIntent.getActivity(this, 1, it,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    }
    return builder.build()
  }

  companion object {
    private const val CHANNEL = "syncachu-background-backup"
    private const val NOTIFICATION_ID = 0x5342
    private const val ACTION_STOP = "expo.modules.backgroundbackup.STOP"
  }
}
