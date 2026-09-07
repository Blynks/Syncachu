import ExpoModulesCore
import BackgroundTasks
import UIKit

public final class BackgroundBackupModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SyncachuBackgroundBackup")

    AsyncFunction("configure") { (configJson: String, promise: Promise) in
      BackgroundBackupEngine.shared.configure(configJson, promise: promise)
    }
    AsyncFunction("setMobile") { (userId: String, allowMobile: Bool, promise: Promise) in
      BackgroundBackupEngine.shared.setMobile(userId, allowMobile: allowMobile, promise: promise)
    }
    AsyncFunction("enqueue") { (userId: String, jobsJson: String, promise: Promise) in
      BackgroundBackupEngine.shared.enqueue(userId, json: jobsJson, promise: promise)
    }
    AsyncFunction("snapshot") { (userId: String, promise: Promise) in
      BackgroundBackupEngine.shared.snapshot(userId, promise: promise)
    }
    AsyncFunction("cancel") { (userId: String, id: String, promise: Promise) in
      BackgroundBackupEngine.shared.cancel(userId, id: id, promise: promise)
    }
    AsyncFunction("retry") { (userId: String, idsJson: String, promise: Promise) in
      BackgroundBackupEngine.shared.retry(userId, json: idsJson, promise: promise)
    }
    AsyncFunction("acknowledge") { (userId: String, idsJson: String, promise: Promise) in
      BackgroundBackupEngine.shared.acknowledge(userId, json: idsJson, promise: promise)
    }
    AsyncFunction("stop") { (userId: String, promise: Promise) in
      BackgroundBackupEngine.shared.stop(userId, promise: promise)
    }
  }
}

public final class BackgroundBackupAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let engine = BackgroundBackupEngine.shared
    let registered = BGTaskScheduler.shared.register(
      forTaskWithIdentifier: BackgroundBackupEngine.processingIdentifier, using: nil
    ) { task in
      guard let task = task as? BGProcessingTask else {
        task.setTaskCompleted(success: false)
        return
      }
      engine.processing(task)
    }
    engine.launched(processingRegistered: registered)
    return true
  }

  public func applicationDidBecomeActive(_ application: UIApplication) {
    BackgroundBackupEngine.shared.foreground()
  }

  public func applicationDidEnterBackground(_ application: UIApplication) {
    BackgroundBackupEngine.shared.background()
  }

  public func application(
    _ application: UIApplication,
    handleEventsForBackgroundURLSession identifier: String,
    completionHandler: @escaping () -> Void
  ) {
    guard BackgroundBackupEngine.sessionIdentifiers.contains(identifier) else {
      completionHandler()
      return
    }
    BackgroundBackupEngine.shared.backgroundEvents(identifier, completion: completionHandler)
  }
}
