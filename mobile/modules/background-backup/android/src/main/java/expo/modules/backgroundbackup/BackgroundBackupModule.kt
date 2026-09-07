package expo.modules.backgroundbackup

import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class BackgroundBackupModule : Module() {
  private val engine: BackupEngine
    get() = BackupEngine.get(appContext.reactContext ?: throw Exceptions.ReactContextLost())

  override fun definition() = ModuleDefinition {
    Name("SyncachuBackgroundBackup")

    AsyncFunction("configure") { configJson: String ->
      val userId = BackupConfig.parse(configJson).userId
      val configuredGeneration = engine.configure(configJson)
      engine.startConfigured(userId, configuredGeneration)
    }
    AsyncFunction("enqueue") { userId: String, jobsJson: String -> engine.enqueue(userId, jobsJson) }
    AsyncFunction("snapshot") { userId: String -> engine.snapshot(userId) }
    AsyncFunction("cancel") { userId: String, id: String -> engine.cancel(userId, id) }
    AsyncFunction("retry") { userId: String, idsJson: String -> engine.retry(userId, idsJson) }
    AsyncFunction("acknowledge") { userId: String, idsJson: String -> engine.acknowledge(userId, idsJson) }
    AsyncFunction("setMobile") { userId: String, allowMobile: Boolean -> engine.setMobile(userId, allowMobile) }
    AsyncFunction("stop") { userId: String -> engine.stop(userId) }
  }

}
