package expo.modules.backgroundbackup

import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.CancellationSignal
import androidx.core.content.ContextCompat
import okhttp3.Call
import org.json.JSONArray
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

internal class BackupWork(
  val userId: String, val generation: Long, val job: BackupJob, val store: BackupStore
) {
  @Volatile var networkInterrupted = false
  @Volatile var cleanup = false
}

/** A process-scoped, single native worker; the React runtime is not involved in its lifetime. */
internal class BackupEngine private constructor(private val context: Context) {
  private val lock = Any()
  private val executor = Executors.newSingleThreadScheduledExecutor()
  private val connectivity = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
  private var config: BackupConfig? = null
  private var store: BackupStore? = null
  private var jobs = linkedMapOf<String, BackupJob>()
  private var generation = 0L
  private var service: BackupService? = null
  private var callbackRegistered = false
  private var scheduled = false
  private var suspended = false
  private var active: BackupWork? = null
  private var activeCall: Call? = null
  private var activeNetwork: Network? = null
  private var sourceSignal: CancellationSignal? = null
  private var lastProgressAt = 0L
  private val retryAfter = mutableMapOf<String, Long>()
  private val networkAttempts = mutableMapOf<String, Int>()

  private val callback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) = networkChanged()
    override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) = networkChanged()
    override fun onLost(network: Network) = networkChanged(network)
  }

  @Synchronized fun configure(raw: String): Long {
    val incoming = BackupConfig.parse(raw)
    synchronized(lock) {
      if (config != null && config?.userId != incoming.userId) {
        // A reloaded React runtime may sign into a different account while native work is alive.
        config = null
        interruptLocked("Account changed. Sign into this account again to resume its backup.")
      }
      val previous = config
      if (previous == null) {
        // Load before publishing credentials: corrupt/unreadable checkpoints must never be silently discarded.
        val loadedStore = BackupStore(context, incoming.userId)
        val loadedJobs = loadedStore.load()
        store = loadedStore
        jobs = loadedJobs
        retryAfter.clear()
        networkAttempts.clear()
      } else if (previous.apiUrl != incoming.apiUrl || previous.blobHost != incoming.blobHost) {
        interruptLocked("Backup destination changed. Resuming with a new reservation.")
        for (job in jobs.values.filter { !it.terminal }) {
          job.resetTicket()
          persistLocked(job)
        }
      }
      config = incoming
      suspended = false
      if (activeNetwork?.let { !isAllowed(it, incoming) } == true) interruptNetworkLocked()
    }
    return synchronized(lock) { generation }
  }

  @Synchronized fun startConfigured(userId: String, configuredGeneration: Long) {
    synchronized(lock) {
      requireAccount(userId)
      require(generation == configuredGeneration) { "This native backup configuration was stopped." }
    }
    startFromForeground()
  }

  @Synchronized fun enqueue(userId: String, raw: String) {
    synchronized(lock) {
      requireAccount(userId)
      val input = JSONArray(raw)
      val additions = (0 until input.length()).map { BackupJob.incoming(input.getJSONObject(it)) }
      for (job in additions) {
        val existing = jobs[job.id]
        if (existing != null) {
          for (field in listOf("key", "name", "contentType", "uri", "assetId")) {
            require(existing.json.optionalString(field) == job.json.optionalString(field)) {
              "A native backup ID cannot be reused for a different original."
            }
          }
        } else {
          persistLocked(job)
        }
      }
      suspended = false
    }
    startFromForeground()
  }

  fun snapshot(userId: String): String = synchronized(lock) {
    requireAccount(userId)
    val retainedSnapshot = jobs.values.any { it.status == "error" && store!!.hasStaging(it) }
    JSONArray(jobs.values.map { job ->
      job.snapshot().also {
        if (retainedSnapshot && job.status == "queued") {
          it.put("error", "Backup paused to retain a failed original's resumable snapshot. Retry or Cancel that item to continue.")
        }
      }
    }).toString()
  }

  @Synchronized fun cancel(userId: String, id: String) {
    synchronized(lock) {
      requireAccount(userId)
      val job = jobs[id] ?: return
      if (job.status == "done" || job.status == "cancelled") return
      if (active?.job?.id == id) {
        active?.cleanup = true
        interruptLocked("Backup cancelled.")
      }
      job.status = "cancelled"
      job.clearError()
      persistLocked(job)
      if (active?.job?.id != id) {
        try { store!!.cleanStaging(job) }
        catch (_: IOException) {
          job.json.put("error", "Backup cancelled, but private staging cleanup failed. Acknowledge to try cleanup again.")
          persistLocked(job)
        }
      }
      retryAfter.remove(id)
      networkAttempts.remove(id)
      scheduleLocked()
    }
  }

  @Synchronized fun retry(userId: String, raw: String) {
    synchronized(lock) {
      requireAccount(userId)
      for (id in ids(raw)) {
        val job = jobs[id] ?: continue
        // Cancelled originals have deliberately lost their staging. Use a new ID to enqueue them again.
        if (job.status != "error") continue
        job.status = "queued"
        job.clearError()
        persistLocked(job)
        retryAfter.remove(id)
        networkAttempts.remove(id)
      }
      suspended = false
    }
    startFromForeground()
  }

  @Synchronized fun setMobile(userId: String, allowMobile: Boolean) {
    synchronized(lock) {
      requireAccount(userId)
      val current = requireNotNull(config)
      config = BackupConfig(current.userId, current.apiUrl, current.blobHost, current.token, allowMobile)
      if (activeNetwork?.let { !isAllowed(it, requireNotNull(config)) } == true) interruptNetworkLocked()
      scheduleLocked()
    }
  }

  @Synchronized fun acknowledge(userId: String, raw: String) {
    synchronized(lock) {
      requireAccount(userId)
      for (id in ids(raw)) {
        val job = jobs[id] ?: continue
        if (!job.terminal) continue
        require(!(job.status == "error" && job.json.optInt("httpStatus") == 507)) {
          "Retry or cancel the quota-blocked backup before acknowledging it."
        }
        // The worker may still be closing file descriptors after cancellation. Its finally block cleans staging.
        if (active?.job?.id == id) throw IllegalStateException("Backup is still stopping. Acknowledge again after it stops.")
        store!!.remove(job)
        jobs.remove(id)
      }
      scheduleLocked()
    }
  }

  @Synchronized fun stop(userId: String) {
    synchronized(lock) {
      if (config?.userId != userId) return
      // Clear credentials and invalidate/cancel every registered request before returning.
      // registerCall checks the generation under this same lock, including calls not yet executed.
      config = null
      suspended = true
      try { interruptLocked("Backup paused. Open Syncachu to resume.") }
      finally { service?.finish() }
    }
  }

  fun pauseFromNotification() {
    synchronized(lock) {
      suspended = true
      config = null
      try { interruptForServiceLocked("Backup stopped from the notification. Open Syncachu to resume.") }
      finally { service?.finish() }
    }
  }

  fun timeout(owner: BackupService) {
    synchronized(lock) {
      if (service !== owner) return
      suspended = true
      try { interruptForServiceLocked("Android paused long-running backup. Open Syncachu to resume.") }
      finally { owner.finish() }
    }
  }

  fun attach(owner: BackupService): Boolean = synchronized(lock) {
    if (config == null || suspended || jobs.values.none { it.status == "queued" || it.status == "working" }) return false
    service = owner
    if (!callbackRegistered) {
      connectivity.registerNetworkCallback(
        NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(), callback
      )
      callbackRegistered = true
    }
    scheduleLocked()
    true
  }

  fun detach(owner: BackupService) {
    synchronized(lock) {
      if (service !== owner) return
      service = null
      interruptForServiceLocked("Native backup service stopped. Open Syncachu to resume.")
      if (callbackRegistered) {
        connectivity.unregisterNetworkCallback(callback)
        callbackRegistered = false
      }
    }
  }

  fun serviceFailure(message: String) {
    synchronized(lock) {
      suspended = true
      interruptForServiceLocked(message)
      try {
        for (job in jobs.values.filter { it.status == "queued" }.toList()) {
          job.fail(message)
          persistLocked(job)
        }
      } catch (_: IOException) {
        // persistLocked has retained a visible storage error and suspended the worker.
      } finally {
        service?.finish()
      }
    }
  }

  fun configuration(work: BackupWork): BackupConfig = synchronized(lock) {
    checkLocked(work)
    requireNotNull(config)
  }

  fun check(work: BackupWork) {
    synchronized(lock) {
      checkLocked(work)
      service?.keepAwake()
    }
  }

  fun network(work: BackupWork): Network = synchronized(lock) {
    checkLocked(work)
    if (work.networkInterrupted) throw NetworkUnavailable()
    allowedNetwork() ?: throw NetworkUnavailable()
  }

  fun checkNetwork(work: BackupWork, network: Network) {
    synchronized(lock) {
      checkLocked(work)
      if (work.networkInterrupted || !isAllowed(network, requireNotNull(config))) throw NetworkUnavailable()
    }
  }

  fun registerCall(work: BackupWork, network: Network, call: Call) {
    synchronized(lock) {
      checkNetwork(work, network)
      activeCall = call
      activeNetwork = network
    }
  }

  fun unregisterCall(call: Call) {
    synchronized(lock) {
      if (activeCall === call) { activeCall = null; activeNetwork = null }
    }
  }

  fun registerSource(work: BackupWork, signal: CancellationSignal) {
    synchronized(lock) { checkLocked(work); sourceSignal = signal }
  }

  fun unregisterSource(signal: CancellationSignal) {
    synchronized(lock) { if (sourceSignal === signal) sourceSignal = null }
  }

  fun checkpoint(work: BackupWork, job: BackupJob) {
    synchronized(lock) {
      checkLocked(work)
      persistLocked(job.copy())
    }
  }

  fun progress(work: BackupWork, job: BackupJob, progress: Double) {
    synchronized(lock) {
      checkLocked(work)
      job.progress = progress
      if (System.currentTimeMillis() - lastProgressAt < 750) return
      lastProgressAt = System.currentTimeMillis()
      persistLocked(job.copy())
      service?.update("Backing up ${job.name}", job.progress)
    }
  }

  fun warning(work: BackupWork, message: String) {
    synchronized(lock) {
      if (active !== work || generation != work.generation) return
      val job = jobs[work.job.id] ?: return
      job.json.put("error", message)
      persistLocked(job)
    }
  }

  private fun requireAccount(userId: String) {
    require(config?.userId == userId) { "This native backup account is no longer active." }
  }

  private fun checkLocked(work: BackupWork) {
    if (generation != work.generation || config?.userId != work.userId || active !== work ||
      suspended || jobs[work.job.id]?.status != "working") throw WorkInterrupted()
  }

  private fun persistLocked(job: BackupJob) {
    jobs[job.id] = job
    try { requireNotNull(store).save(job) }
    catch (error: IOException) {
      job.fail("Native backup state could not be saved. Free device storage and retry.")
      suspended = true
      generation++
      activeCall?.cancel()
      sourceSignal?.cancel()
      service?.finish()
      throw error
    }
  }

  private fun interruptLocked(message: String) {
    generation++
    activeCall?.cancel()
    sourceSignal?.cancel()
    active?.let { work ->
      val job = jobs[work.job.id]
      if (job?.status == "working") {
        job.status = "queued"
        job.json.put("error", message)
        persistLocked(job)
      }
    }
  }

  private fun interruptForServiceLocked(message: String) {
    try { interruptLocked(message) }
    catch (_: IOException) {
      // Lifecycle callbacks cannot reject a JS promise. persistLocked exposes the error in snapshot instead.
    }
  }

  private fun interruptNetworkLocked() {
    active?.networkInterrupted = true
    activeCall?.cancel()
  }

  private fun networkChanged(lost: Network? = null) {
    synchronized(lock) {
      val current = config ?: return
      val network = activeNetwork
      if (network != null && (network == lost || !isAllowed(network, current))) interruptNetworkLocked()
      scheduleLocked()
    }
  }

  private fun isAllowed(network: Network, config: BackupConfig): Boolean {
    val caps = connectivity.getNetworkCapabilities(network) ?: return false
    if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) ||
      !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) return false
    // VPN or mixed-transport networks cannot prove they are not using a cellular underlay.
    return config.allowMobile || (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
      !caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) && !caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN))
  }

  private fun allowedNetwork(): Network? {
    val current = config ?: return null
    return connectivity.activeNetwork?.takeIf { isAllowed(it, current) }
  }

  private fun ids(raw: String): List<String> {
    val array = JSONArray(raw)
    return (0 until array.length()).map { array.getString(it) }
  }

  private fun startFromForeground() {
    synchronized(lock) {
      if (config == null || suspended || jobs.values.none { it.status == "queued" || it.status == "working" }) return
      if (service != null && service?.finishing == false) { scheduleLocked(); return }
      try {
        ContextCompat.startForegroundService(context, Intent(context, BackupService::class.java))
      } catch (_: RuntimeException) {
        val message = "Android could not start background backup. Keep Syncachu open and retry; check notification and battery settings."
        serviceFailure(message)
        throw IllegalStateException(message)
      }
    }
  }

  private fun scheduleLocked(delay: Long = 0) {
    if (scheduled || active != null || service == null || service?.finishing == true || suspended || config == null) return
    scheduled = true
    executor.schedule({ pump() }, delay, TimeUnit.MILLISECONDS)
  }

  private fun pump() {
    var work: BackupWork? = null
    try {
      synchronized(lock) {
        scheduled = false
        if (service == null || service?.finishing == true || config == null || suspended) return
        val pending = jobs.values.filter { it.status == "queued" }
        if (pending.isEmpty()) { service?.finish(); return }
        val quota = jobs.values.any { it.status == "error" && it.json.optInt("httpStatus") == 507 }
        val auth = jobs.values.any { it.status == "error" && it.json.optionalString("error") == SIGN_IN_ERROR }
        val retainedSnapshot = jobs.values.any { it.status == "error" && store!!.hasStaging(it) }
        if (quota || auth || retainedSnapshot) {
          val message = if (quota) "Storage full — retry or cancel the quota item in Syncachu."
            else if (auth) SIGN_IN_ERROR
            else "Backup paused. Retry or cancel the failed item to retain resumability without filling device storage."
          service?.update(message, null)
          scheduleLocked(30_000)
          return
        }
        if (allowedNetwork() == null) {
          val message = if (config!!.allowMobile) "Waiting for an internet connection." else "Waiting for validated Wi-Fi."
          service?.update(message, null)
          scheduleLocked(15_000)
          return
        }
        // A retried snapshot owns the staging budget, even while backing off.
        val staged = pending.filter { store!!.hasStaging(it) }
        val candidates = if (staged.isNotEmpty()) staged else pending
        val job = candidates.firstOrNull { (retryAfter[it.id] ?: 0) <= System.currentTimeMillis() }
        if (job == null) { scheduleLocked(5_000); return }
        job.status = "working"
        job.clearError()
        persistLocked(job)
        work = BackupWork(config!!.userId, generation, job.copy(), store!!)
        active = work
        service?.keepAwake()
        service?.update("Backing up ${job.name}", job.progress)
      }
      val current = requireNotNull(work)
      val result = BackupUploader(context, this, current).upload(current.job)
      synchronized(lock) {
        checkLocked(current)
        current.job.status = "done"
        current.job.progress = 1.0
        current.job.clearError()
        current.job.json.put("media", result)
        persistLocked(current.job)
        current.cleanup = true
        retryAfter.remove(current.job.id)
        networkAttempts.remove(current.job.id)
      }
    } catch (_: WorkInterrupted) {
      // The caller already durably checkpointed the queued/cancelled state before invalidating this work.
    } catch (error: Exception) {
      synchronized(lock) {
        val current = work
        if (current == null) {
          serviceFailure("Native backup could not read or persist its queue. Reopen Syncachu and retry.")
        } else if (current.generation == generation && config?.userId == current.userId) {
          val job = jobs[current.job.id] ?: current.job
          val offline = current.networkInterrupted || error is NetworkUnavailable || allowedNetwork() == null
          if (error is IOException && (offline || (networkAttempts[job.id] ?: 0) < 3)) {
            val count = if (offline) 0 else (networkAttempts[job.id] ?: 0) + 1
            networkAttempts[job.id] = count
            retryAfter[job.id] = System.currentTimeMillis() + if (offline) 15_000 else 5_000L * (1 shl count)
            job.status = "queued"
            job.json.put("error", "Waiting for a stable permitted network. Saved upload progress will resume.")
          } else {
            when (error) {
              is BackupFailure -> job.fail(error.message ?: "Backup failed. Retry.", error.status)
              is IOException -> job.fail("Backup I/O failed. Check local free space and connectivity, then retry.")
              is SecurityException -> job.fail("Android denied access. Restore photo/network permission and retry.")
              else -> job.fail("Native backup failed (${error.javaClass.simpleName}). Retry or select the original again.")
            }
          }
          persistLocked(job)
        }
      }
    } finally {
      synchronized(lock) {
        val current = work
        if (current != null && active === current) {
          active = null
          activeCall = null
          activeNetwork = null
          sourceSignal = null
          if (current.cleanup) {
            try { current.store.cleanStaging(current.job) }
            catch (_: IOException) {
              if (config?.userId == current.userId) {
                jobs[current.job.id]?.let {
                  it.json.put("error", "Private staging cleanup failed. Reopen Syncachu to retry cleanup.")
                  persistLocked(it)
                }
              }
            }
          }
        }
        service?.releaseWakeLock()
        scheduleLocked()
      }
    }
  }

  companion object {
    @Volatile private var instance: BackupEngine? = null
    fun get(context: Context): BackupEngine = instance ?: synchronized(this) {
      instance ?: BackupEngine(context.applicationContext).also { instance = it }
    }
  }
}
