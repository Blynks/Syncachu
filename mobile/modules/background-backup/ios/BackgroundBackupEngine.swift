import Foundation
import ExpoModulesCore
import BackgroundTasks
import Network

final class BackgroundBackupEngine: NSObject, @unchecked Sendable {
  static let shared = BackgroundBackupEngine()
  static let processingIdentifier = (Bundle.main.bundleIdentifier ?? "Syncachu") + ".backup-processing"
  static let sessionIdentifiers = [
    (Bundle.main.bundleIdentifier ?? "Syncachu") + ".backup.wifi",
    (Bundle.main.bundleIdentifier ?? "Syncachu") + ".backup.mobile"
  ]

  private let queue = DispatchQueue(label: "Syncachu.background-backup.state")
  private let preparationQueue = DispatchQueue(label: "Syncachu.background-backup.prepare", qos: .utility)
  private let monitor = NWPathMonitor()
  private let delegateQueue: OperationQueue = {
    let queue = OperationQueue()
    queue.name = "Syncachu.background-backup.delegates"
    queue.maxConcurrentOperationCount = 1
    return queue
  }()
  private var sessions: [String: URLSession] = [:]
  private var tasks: [String: URLSessionTask] = [:]
  private var responses: [String: Data] = [:]
  private var invalidResponses: Set<String> = []
  private var completions: [String: [() -> Void]] = [:]
  private var finishedEvents: Set<String> = []
  private var config: BackupConfiguration?
  private var loadedAccount: String?
  private var stoppedUser: String?
  private var state = BackupState()
  private var fatalError: String?
  private var schedulerError: String?
  private var ready = false
  private var reconcilingSessions = 0
  private var pending: [() -> Void] = []
  private var bootstrapCompletions: [(session: String, task: URLSessionTask, error: Error?)] = []
  private var connected = false
  private var wifi = false
  private var expensive = false
  private var constrained = false
  private var active = false
  private var backgroundDeadline: Date?
  private var preparationPaused = false
  private var processingRegistered = false
  private var processingScheduled = false
  private var processingTask: BGProcessingTask?
  private var preparation: (
    account: String, id: String, generation: String,
    cancellation: BackupCancellation, lease: BackupPreparationLease
  )?

  private override init() {
    super.init()
    queue.async { self.bootstrap() }
    monitor.pathUpdateHandler = { [weak self] path in
      guard let self else { return }
      let wasAllowed = self.networkAllowed
      self.connected = path.status == .satisfied
      self.wifi = path.usesInterfaceType(.wifi)
      self.expensive = path.isExpensive
      self.constrained = path.isConstrained
      if self.ready {
        if wasAllowed && !self.networkAllowed { self.requeueForNetwork() }
        self.pump()
      }
    }
    monitor.start(queue: queue)
  }

  private var networkAllowed: Bool {
    guard let config, connected else { return false }
    return config.allowMobile || (wifi && !expensive && !constrained)
  }

  private func bootstrap() {
    do {
      config = try BackupCredentials.read()
      if let config {
        state = try BackupFiles.load(config.account)
        loadedAccount = config.account
      }
    } catch { fatalError = message(error) }
    for (index, identifier) in Self.sessionIdentifiers.enumerated() {
      let policy = URLSessionConfiguration.background(withIdentifier: identifier)
      policy.sessionSendsLaunchEvents = true
      policy.isDiscretionary = false
      policy.waitsForConnectivity = true
      policy.allowsCellularAccess = index == 1
      policy.allowsExpensiveNetworkAccess = index == 1
      policy.allowsConstrainedNetworkAccess = index == 1
      policy.httpShouldSetCookies = false
      policy.httpCookieStorage = nil
      policy.urlCredentialStorage = nil
      policy.urlCache = nil
      policy.requestCachePolicy = .reloadIgnoringLocalCacheData
      policy.httpMaximumConnectionsPerHost = 1
      policy.timeoutIntervalForRequest = 120
      policy.timeoutIntervalForResource = 6 * 60 * 60
      sessions[identifier] = URLSession(configuration: policy, delegate: self, delegateQueue: delegateQueue)
    }
    reconcilingSessions = sessions.count
    for (identifier, session) in sessions {
      session.getAllTasks { list in
        self.queue.async {
          for task in list { self.tasks[self.taskKey(identifier, task.taskIdentifier)] = task }
          self.reconcilingSessions -= 1
          if self.reconcilingSessions == 0 { self.reconcile() }
        }
      }
    }
  }

  private func reconcile() {
    // Completed tasks may no longer appear in getAllTasks. Apply their receipts
    // before treating a missing persisted operation as abandoned.
    let completedTasks = bootstrapCompletions
    bootstrapCompletions.removeAll()
    for completion in completedTasks {
      completed(completion.session, task: completion.task, error: completion.error)
    }
    var live: Set<String> = []
    for (key, task) in tasks {
      guard fatalError == nil, let config, let operation = operation(task),
        operation.account == config.account,
        operation.session == Self.sessionIdentifiers[config.allowMobile ? 1 : 0],
        config.allowMobile || networkAllowed,
        operation.taskID == task.taskIdentifier,
        let index = currentIndex(operation),
        !state.jobs[index].terminal
      else { task.cancel(); continue }
      live.insert(key)
      state.jobs[index].status = "working"
    }
    for index in state.jobs.indices {
      if let operation = state.jobs[index].operation,
        !live.contains(taskKey(operation.session, operation.taskID)) {
        state.jobs[index].operation = nil
        if !state.jobs[index].terminal { state.jobs[index].status = "queued" }
      }
      // Preparation is not an OS URLSession task and must be restarted after termination.
      if state.jobs[index].operation == nil && state.jobs[index].status == "working" {
        state.jobs[index].status = "queued"
      }
    }
    persistOrHalt()
    if fatalError == nil {
      do { try cleanupTerminalStaging() }
      catch { fatalError = message(error) }
    }
    ready = true
    let actions = pending
    pending.removeAll()
    actions.forEach { $0() }
    pump()
  }

  private func whenReady(_ action: @escaping () -> Void) {
    if ready { action() } else { pending.append(action) }
  }

  private func perform(_ promise: Promise, _ action: @escaping () throws -> Any?) {
    queue.async {
      self.whenReady {
        do { promise.resolve(try action()) }
        catch { promise.reject("ERR_BACKGROUND_BACKUP", self.message(error)) }
      }
    }
  }

  private func message(_ error: Error) -> String {
    if let failure = error as? BackupFailure { return failure.localizedDescription }
    if error is DecodingError {
      return "Native backup received an invalid API response or saved checkpoint. Reopen and Retry."
    }
    // NSError descriptions can contain signed URLs and Authorization-bearing requests.
    return "Native backup could not read or persist its private checkpoint (code \((error as NSError).code)). Reopen and Retry."
  }

  private func requireAccount(_ user: String) throws -> BackupConfiguration {
    guard let config, config.userId == user else {
      throw BackupFailure.message("Background account changed or was stopped. Reopen and sign in again.")
    }
    if let fatalError { throw BackupFailure.message(fatalError) }
    return config
  }

  private func save() throws {
    do {
      if let loadedAccount { try BackupFiles.save(state, accountHash: loadedAccount) }
    } catch {
      fatalError = message(error)
      preparation?.cancellation.cancel("Private backup checkpoint could not be saved.")
      tasks.values.forEach { $0.cancel() }
      throw error
    }
  }

  private func persistOrHalt() {
    guard fatalError == nil else { return }
    do { try save() } catch {
      fatalError = message(error)
      preparation?.cancellation.cancel("Private backup checkpoint could not be saved.")
      tasks.values.forEach { $0.cancel() }
    }
  }

  func configure(_ json: String, promise: Promise) {
    perform(promise) {
      let next = try JSONDecoder().decode(BackupConfiguration.self, from: Data(json.utf8))
      try next.validate()
      if self.fatalError != nil {
        if let account = self.loadedAccount ?? self.config?.account {
          // Never overwrite an unreadable checkpoint with an empty in-memory queue.
          let recovered = try BackupFiles.load(account)
          self.state = recovered
          self.loadedAccount = account
          self.invalidateWork("Recovering native backup checkpoints.")
          try self.save()
        }
        self.fatalError = nil
      }
      let previous = self.config
      if previous?.userId != next.userId || previous?.apiUrl != next.apiUrl || previous?.blobHost != next.blobHost {
        try self.stopActive()
        self.state = try BackupFiles.load(next.account)
        self.loadedAccount = next.account
        self.invalidateWork("Resuming saved account checkpoints.")
      } else if previous?.allowMobile != next.allowMobile || previous?.token != next.token {
        self.invalidateWork("Configuration changed. Waiting to resume.")
        try self.save()
      }
      do { try BackupCredentials.write(next) } catch {
        let credentialError = error
        self.config = nil
        self.stoppedUser = previous?.userId
        self.invalidateWork("Secure sign-in storage failed. Background work stopped.")
        self.fatalError = self.message(credentialError)
        try BackupCredentials.clear()
        try self.save()
        throw credentialError
      }
      self.config = next
      self.loadedAccount = next.account
      self.stoppedUser = nil
      self.fatalError = nil
      self.preparationPaused = false
      // Persist the backend pin separately from credentials so stop/reconfigure cannot reuse
      // another deployment's upload IDs, even for the same Google account.
      if self.state.apiURL != next.apiUrl || self.state.blobHost != next.blobHost {
        for index in self.state.jobs.indices { self.resetUpload(index) }
      }
      self.state.apiURL = next.apiUrl
      self.state.blobHost = next.blobHost
      try self.save()
      try self.cleanupTerminalStaging()
      self.pump()
      return nil
    }
  }

  func enqueue(_ user: String, json: String, promise: Promise) {
    perform(promise) {
      _ = try self.requireAccount(user)
      guard json.utf8.count <= 16 * 1024 * 1024 else {
        throw BackupFailure.message("Native backup selection is too large. Select fewer items.")
      }
      let inputs = try JSONDecoder().decode([BackupInput].self, from: Data(json.utf8))
      var ids: Set<String> = []
      for input in inputs {
        try input.validate()
        guard ids.insert(input.id).inserted else {
          throw BackupFailure.message("Duplicate native job identifiers in selection.")
        }
        if let existing = self.state.jobs.first(where: { $0.input.id == input.id }),
          existing.input != input {
          throw BackupFailure.message("A native backup identifier cannot be reused for a different original.")
        }
      }
      for input in inputs where !self.state.jobs.contains(where: { $0.input.id == input.id }) {
        for index in self.state.jobs.indices where self.state.jobs[index].input.key == input.key
          && self.state.jobs[index].status != "done" && self.state.jobs[index].status != "cancelled"
          && self.state.jobs[index].httpStatus != 507 {
          self.invalidate(index, status: "cancelled", reason: "Replaced by a newer selection.")
        }
        self.state.jobs.append(BackupJob(input: input))
      }
      try self.save()
      try self.cleanupTerminalStaging()
      self.pump()
      return nil
    }
  }

  func setMobile(_ user: String, allowMobile: Bool, promise: Promise) {
    perform(promise) {
      guard let current = self.config, current.userId == user else {
        throw BackupFailure.message("Background account changed or was stopped.")
      }
      guard current.allowMobile != allowMobile else { return nil }
      let next = BackupConfiguration(userId: current.userId, apiUrl: current.apiUrl,
                                     blobHost: current.blobHost, token: current.token, allowMobile: allowMobile)
      self.config = next
      // Cancel before any fallible persistence. Subsequent requests use the separately
      // configured Wi-Fi/mobile session, never a session whose cellular policy is stale.
      self.invalidateWork("Network policy changed. Waiting for an allowed network.")
      do {
        try BackupCredentials.write(next)
        try self.save()
      } catch {
        let policyError = error
        self.config = nil
        self.stoppedUser = user
        self.fatalError = self.message(policyError)
        try BackupCredentials.clear()
        throw policyError
      }
      self.pump()
      return nil
    }
  }

  func snapshot(_ user: String, promise: Promise) {
    perform(promise) {
      guard self.config?.userId == user else {
        throw BackupFailure.message("Background account changed or was stopped.")
      }
      let rows = self.state.jobs.map { job -> BackupSnapshot in
        let pending = job.status == "queued" || job.status == "working"
        let waiting = self.state.pause ?? (!self.networkAllowed
          ? "Waiting for an allowed network. Wi-Fi-only backup requires Wi-Fi, not Ethernet."
          : self.schedulerError)
        return BackupSnapshot(id: job.input.id, status: self.fatalError == nil ? job.status : "error",
                              progress: job.progress,
                              error: self.fatalError ?? job.error ?? (pending ? waiting : nil),
                              httpStatus: job.httpStatus ?? (pending ? self.state.pauseStatus : nil),
                              media: job.media)
      }
      return String(decoding: try JSONEncoder().encode(rows), as: UTF8.self)
    }
  }

  func cancel(_ user: String, id: String, promise: Promise) {
    perform(promise) {
      _ = try self.requireAccount(user)
      let clearsPause = self.state.pauseJobID == id || (self.state.pauseStatus == 507
        && self.state.jobs.contains(where: { $0.input.id == id && $0.httpStatus == 507 }))
      if let index = self.state.jobs.firstIndex(where: { $0.input.id == id && $0.status != "done" }) {
        self.invalidate(index, status: "cancelled", reason: nil)
      }
      if clearsPause { self.clearPause() }
      try self.save()
      try self.cleanupTerminalStaging([id])
      self.pump()
      return nil
    }
  }

  func retry(_ user: String, json: String, promise: Promise) {
    perform(promise) {
      _ = try self.requireAccount(user)
      let ids = Set(try JSONDecoder().decode([String].self, from: Data(json.utf8)))
      let clearsQuota = self.state.pauseStatus == 507 && (
        self.state.pauseJobID.map { ids.contains($0) } == true
          || self.state.jobs.contains(where: { ids.contains($0.input.id) && $0.httpStatus == 507 })
      )
      for index in self.state.jobs.indices where ids.contains(self.state.jobs[index].input.id)
        && self.state.jobs[index].status == "error" {
        self.invalidate(index, status: "queued", reason: nil)
        self.state.jobs[index].renewAttempts = 0
        self.state.jobs[index].restarts = 0
        self.state.jobs[index].ticket = nil
        self.state.jobs[index].httpStatus = nil
      }
      // An explicit Resume may have no failed IDs: release preparation/auth waiting
      // without implicitly retrying errors or bypassing an unselected quota failure.
      if self.state.pauseStatus != 507 || clearsQuota { self.clearPause() }
      self.preparationPaused = false
      try self.save()
      self.pump()
      return nil
    }
  }

  func acknowledge(_ user: String, json: String, promise: Promise) {
    perform(promise) {
      let config = try self.requireAccount(user)
      let ids = Set(try JSONDecoder().decode([String].self, from: Data(json.utf8)))
      let removed = self.state.jobs.filter { ids.contains($0.input.id) && $0.canAcknowledge }
      // The caller invokes this only after its JS queue save; retain rows if file cleanup fails.
      for job in removed {
        try BackupFiles.remove(BackupFiles.job(config.account, job.input.id, create: false))
      }
      self.state.jobs.removeAll { ids.contains($0.input.id) && $0.canAcknowledge }
      try self.save()
      return nil
    }
  }

  func stop(_ user: String, promise: Promise) {
    perform(promise) {
      if let active = self.config {
        guard active.userId == user else { return nil }
      } else {
        guard self.stoppedUser == user else { return nil }
      }
      try self.stopActive()
      return nil
    }
  }

  private func clearPause() {
    state.pause = nil
    state.pauseStatus = nil
    state.pauseJobID = nil
  }

  private func cleanupTerminalStaging(_ ids: Set<String>? = nil) throws {
    guard let account = loadedAccount else { return }
    do {
      var changed = false
      for index in state.jobs.indices where state.jobs[index].canAcknowledge
        && (ids?.contains(state.jobs[index].input.id) ?? true) {
        let job = state.jobs[index]
        try BackupFiles.remove(BackupFiles.job(account, job.input.id, create: false))
        if job.original != nil || job.thumbnail != nil || job.sha256 != nil || job.size != nil
          || job.uploadID != nil || job.ticket != nil || !job.blocks.isEmpty || job.operation != nil
          || job.committed || job.thumbnailUploaded || job.renewAttempts != 0 || job.restarts != 0 {
          // Keep the idempotency identity and small receipt, not a second copy of the library.
          state.jobs[index].original = nil
          state.jobs[index].thumbnail = nil
          state.jobs[index].sha256 = nil
          state.jobs[index].size = nil
          state.jobs[index].uploadID = nil
          state.jobs[index].ticket = nil
          state.jobs[index].blocks = []
          state.jobs[index].operation = nil
          state.jobs[index].committed = false
          state.jobs[index].thumbnailUploaded = false
          state.jobs[index].renewAttempts = 0
          state.jobs[index].restarts = 0
          changed = true
        }
      }
      if changed { try save() }
    } catch {
      fatalError = message(error)
      preparation?.cancellation.cancel("Private backup staging could not be cleaned.")
      tasks.values.forEach { $0.cancel() }
      throw error
    }
  }

  private func stopActive() throws {
    if let config { stoppedUser = config.userId }
    config = nil
    invalidateWork("Backup stopped. Reopen and Retry to resume.")
    for index in state.jobs.indices { state.jobs[index].ticket = nil }
    defer {
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.processingIdentifier)
      processingScheduled = false
      finishProcessing(success: true)
    }
    // Delete the bearer before any fallible disk persistence and before resolving stop().
    try BackupCredentials.clear()
    try save()
    stoppedUser = nil
  }

  private func invalidateWork(_ reason: String) {
    preparation?.cancellation.cancel(reason)
    tasks.values.forEach { $0.cancel() }
    for index in state.jobs.indices where !state.jobs[index].terminal {
      invalidate(index, status: "queued", reason: reason)
    }
  }

  private func invalidate(_ index: Int, status: String, reason: String?) {
    if let operation = state.jobs[index].operation {
      tasks[taskKey(operation.session, operation.taskID)]?.cancel()
    }
    if preparation?.id == state.jobs[index].input.id && preparation?.account == loadedAccount {
      preparation?.cancellation.cancel(reason ?? "Backup cancelled.")
    }
    state.jobs[index].generation = UUID().uuidString
    state.jobs[index].operation = nil
    state.jobs[index].status = status
    state.jobs[index].error = reason
    state.jobs[index].httpStatus = nil
    state.jobs[index].ticket = nil
  }

  private func resetUpload(_ index: Int) {
    state.jobs[index].uploadID = nil
    state.jobs[index].ticket = nil
    state.jobs[index].blocks = []
    state.jobs[index].committed = false
    state.jobs[index].thumbnailUploaded = false
  }

  private func requeueForNetwork() {
    for index in state.jobs.indices where state.jobs[index].operation != nil {
      invalidate(index, status: "queued", reason: "Waiting for the allowed network to return.")
    }
    persistOrHalt()
  }

  private func pump() {
    guard ready, fatalError == nil, let config else { finishProcessing(success: fatalError == nil); return }
    if state.pause == nil, let failed = state.jobs.first(where: { $0.status == "error" && $0.original != nil }) {
      state.pause = "Backup paused to retain a failed original's resumable snapshot. Retry or Cancel that item to continue."
      state.pauseJobID = failed.input.id
      persistOrHalt()
    }
    guard state.pause == nil else { finishProcessing(success: false); return }
    guard state.jobs.contains(where: { !$0.terminal }) else {
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.processingIdentifier)
      processingScheduled = false
      finishProcessing(success: true)
      return
    }
    guard preparation == nil else { return }
    guard !state.jobs.contains(where: { $0.operation != nil }) else {
      finishProcessing(success: true)
      return
    }
    guard networkAllowed else { scheduleProcessing(); finishProcessing(success: false); return }
    // Retry All can queue an earlier, unstaged failure. Finish the retained
    // snapshot before allocating another original, regardless of queue order.
    guard let index = state.jobs.firstIndex(where: { !$0.terminal && $0.original != nil })
      ?? state.jobs.firstIndex(where: { !$0.terminal }) else { return }
    do {
      let job = state.jobs[index]
      if let original = job.original, let size = job.size {
        let path = try BackupFiles.owned(original, account: config.account, id: job.input.id)
        let attributes = try BackupFiles.manager.attributesOfItem(atPath: path.path)
        guard (attributes[.size] as? NSNumber)?.int64Value == size else {
          throw BackupFailure.message("Private original snapshot is missing or changed. Select the original again.")
        }
      } else {
        guard !preparationPaused,
          active || processingTask != nil || (backgroundDeadline.map { $0 > Date() } ?? false)
        else {
          state.jobs[index].status = "queued"
          state.jobs[index].error = "Original preparation needs foreground or iOS processing time. Reopen to continue."
          persistOrHalt()
          scheduleProcessing()
          finishProcessing(success: false)
          return
        }
        try cleanInterruptedPreparation(index, account: config.account)
        startPreparation(index, account: config.account)
        return
      }
      if job.uploadID == nil {
        try api(index, kind: "create")
      } else if job.ticket == nil {
        guard job.renewAttempts < 3 else {
          throw BackupFailure.message("iOS delayed the upload until its storage authorization expired. Reopen and Retry.")
        }
        state.jobs[index].renewAttempts += 1
        try api(index, kind: "renew")
      } else {
        guard let size = job.size else { throw BackupFailure.message("Missing private snapshot size.") }
        let count = Int((size + Int64(BackupFiles.blockSize) - 1) / Int64(BackupFiles.blockSize))
        if let block = (0..<count).first(where: { !job.blocks.contains($0) }) {
          try azure(index, kind: "block", block: block)
        } else if !job.committed {
          try azure(index, kind: "commit")
        } else if job.thumbnail != nil && !job.thumbnailUploaded {
          try azure(index, kind: "thumbnail")
        } else {
          try api(index, kind: "complete")
        }
      }
    } catch {
      fail(index, message: message(error))
      persistOrHalt()
      queue.async { self.pump() }
    }
  }

  private func cleanInterruptedPreparation(_ index: Int, account: String) throws {
    let job = state.jobs[index]
    let directory = try BackupFiles.job(account, job.input.id)
    let liveBodies = Set(tasks.values.compactMap { task -> String? in
      guard let operation = operation(task), operation.account == account, operation.jobID == job.input.id else {
        return nil
      }
      return operation.body
    })
    for url in try BackupFiles.manager.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) {
      let name = url.lastPathComponent
      if name.hasPrefix("snapshot-") || (name.hasPrefix("request-") && !liveBodies.contains(name)) {
        try BackupFiles.remove(url)
      }
    }
  }

  private func startPreparation(_ index: Int, account: String) {
    let job = state.jobs[index]
    let cancellation = BackupCancellation()
    let lease = BackupPreparationLease(cancellation)
    preparation = (account, job.input.id, job.generation, cancellation, lease)
    state.jobs[index].status = "working"
    state.jobs[index].error = nil
    persistOrHalt()
    guard fatalError == nil else { preparation = nil; return }
    if processingTask == nil { lease.begin() }
    preparationQueue.async {
      let result = Result {
        try BackupPreparation.prepare(job.input, account: account, cancellation: cancellation)
      }
      self.queue.async {
        lease.finish()
        self.preparation = nil
        guard self.config?.account == account,
          let current = self.state.jobs.firstIndex(where: {
            $0.input.id == job.input.id && $0.generation == job.generation && !$0.terminal
          })
        else {
          if case .success(let prepared) = result {
            do {
              try BackupFiles.remove(BackupFiles.owned(prepared.directory, account: account,
                                                      id: job.input.id, create: false))
            } catch { self.fatalError = self.message(error) }
          }
          self.pump()
          return
        }
        switch result {
        case .success(let prepared):
          self.state.jobs[current].original = prepared.original
          self.state.jobs[current].thumbnail = prepared.thumbnail
          self.state.jobs[current].sha256 = prepared.sha256
          self.state.jobs[current].size = prepared.size
          self.state.jobs[current].progress = 0.15
          self.state.jobs[current].status = "queued"
          self.resetUpload(current)
        case .failure(let error):
          if cancellation.cancelled {
            self.state.jobs[current].status = "queued"
            self.state.jobs[current].error = self.message(error)
            self.preparationPaused = !self.active && self.processingTask == nil
          } else { self.fail(current, message: self.message(error)) }
        }
        self.persistOrHalt()
        self.pump()
      }
    }
  }

  private func api(_ index: Int, kind: String) throws {
    guard let config else { return }
    let job = state.jobs[index]
    var endpoint = config.apiUrl + "/uploads"
    var body: [String: Any] = [:]
    if kind == "create" {
      guard let sha256 = job.sha256, let size = job.size else {
        throw BackupFailure.message("Missing immutable original fingerprint.")
      }
      body = ["sha256": sha256, "size": size, "contentType": job.input.contentType,
              "name": job.input.name, "hasThumbnail": job.thumbnail != nil]
    } else {
      guard let id = job.uploadID,
        id.range(of: "^[a-f0-9-]{36}$", options: .regularExpression) != nil else {
        throw BackupFailure.message("Invalid upload checkpoint.")
      }
      endpoint += "/" + id + "/" + (kind == "renew" ? "renew" : "complete")
    }
    guard let url = URL(string: endpoint) else { throw BackupFailure.message("Invalid API endpoint.") }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("Bearer " + config.token, forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    try submit(index, kind: kind, request: request, body: JSONSerialization.data(withJSONObject: body))
  }

  private func azure(_ index: Int, kind: String, block: Int? = nil) throws {
    guard let config else { return }
    let job = state.jobs[index]
    guard let ticket = job.ticket else { throw BackupFailure.message("Missing storage upload ticket.") }
    try ticket.validate(config, expectedID: job.uploadID)
    let raw: String
    if kind == "thumbnail" {
      guard let url = ticket.thumbnailUploadUrl else {
        throw BackupFailure.message("Missing thumbnail storage authorization. Retry.")
      }
      raw = url
    } else { raw = ticket.uploadUrl }
    var components = try trustedBlob(raw, host: config.blobHost)
    // Preserve the SAS's existing percent escapes (notably %2B in sig). Rebuilding all
    // queryItems can turn a signed '+' into a form-decoded space at Azure.
    var query = components.percentEncodedQuery ?? ""
    let body: Data
    var headers = ["x-ms-version": "2023-11-03"]
    if kind == "block", let block, let size = job.size, let original = job.original {
      guard let encodedID = BackupFiles.blockID(block).addingPercentEncoding(withAllowedCharacters: .alphanumerics) else {
        throw BackupFailure.message("Invalid storage block identifier.")
      }
      query += "&comp=block&blockid=" + encodedID
      let handle = try FileHandle(forReadingFrom: BackupFiles.owned(original, account: config.account, id: job.input.id))
      do {
        let offset = Int64(block) * Int64(BackupFiles.blockSize)
        let length = Int(min(Int64(BackupFiles.blockSize), size - offset))
        guard length > 0 else { throw BackupFailure.message("Invalid block checkpoint.") }
        try handle.seek(toOffset: UInt64(offset))
        body = try handle.read(upToCount: length) ?? Data()
        try handle.close()
        guard body.count == length else { throw BackupFailure.message("Private snapshot is incomplete. Select it again.") }
      } catch {
        let originalError = error
        do { try handle.close() } catch { throw BackupFailure.message("Could not close private backup snapshot.") }
        throw originalError
      }
      headers["Content-Type"] = "application/octet-stream"
    } else if kind == "commit", let size = job.size {
      query += "&comp=blocklist"
      let count = Int((size + Int64(BackupFiles.blockSize) - 1) / Int64(BackupFiles.blockSize))
      let blocks = (0..<count).map { "<Latest>" + BackupFiles.blockID($0) + "</Latest>" }.joined()
      body = Data(("<?xml version=\"1.0\" encoding=\"utf-8\"?><BlockList>" + blocks + "</BlockList>").utf8)
      headers["Content-Type"] = "application/xml"
      headers["x-ms-blob-content-type"] = job.input.contentType
    } else if kind == "thumbnail", let thumbnail = job.thumbnail {
      body = try Data(contentsOf: BackupFiles.owned(thumbnail, account: config.account, id: job.input.id))
      guard !body.isEmpty, body.count <= 1024 * 1024 else {
        throw BackupFailure.message("Private thumbnail exceeds 1 MiB. Select the original again.")
      }
      headers["Content-Type"] = "image/jpeg"
      headers["x-ms-blob-type"] = "BlockBlob"
    } else { throw BackupFailure.message("Invalid native upload operation.") }
    components.percentEncodedQuery = query
    guard let url = components.url else { throw BackupFailure.message("Invalid storage URL.") }
    var request = URLRequest(url: url)
    request.httpMethod = "PUT"
    for (key, value) in headers { request.setValue(value, forHTTPHeaderField: key) }
    // Storage gets only the signed URL; backend bearer headers are never copied here.
    try submit(index, kind: kind, block: block, request: request, body: body)
  }

  private func submit(
    _ index: Int, kind: String, block: Int? = nil, request: URLRequest, body: Data
  ) throws {
    guard let config, networkAllowed else { return }
    let job = state.jobs[index]
    let identifier = Self.sessionIdentifiers[config.allowMobile ? 1 : 0]
    guard let session = sessions[identifier] else { throw BackupFailure.message("Background URL session is unavailable.") }
    let nonce = UUID().uuidString
    let relative = "request-" + nonce + ".body"
    let file = try BackupFiles.owned(relative, account: config.account, id: job.input.id)
    try BackupFiles.write(body, to: file)
    var request = request
    request.allowsCellularAccess = config.allowMobile
    request.allowsExpensiveNetworkAccess = config.allowMobile
    request.allowsConstrainedNetworkAccess = config.allowMobile
    request.httpShouldHandleCookies = false
    request.cachePolicy = .reloadIgnoringLocalCacheData
    let task = session.uploadTask(with: request, fromFile: file)
    let operation = BackupOperation(nonce: nonce, account: config.account, jobID: job.input.id,
                                    generation: job.generation, kind: kind, block: block,
                                    session: identifier, taskID: task.taskIdentifier, body: relative)
    task.taskDescription = String(decoding: try JSONEncoder().encode(operation), as: UTF8.self)
    state.jobs[index].operation = operation
    state.jobs[index].status = "working"
    state.jobs[index].error = nil
    state.jobs[index].httpStatus = nil
    let key = taskKey(identifier, task.taskIdentifier)
    tasks[key] = task
    finishedEvents.remove(identifier)
    do { try save() } catch {
      state.jobs[index].operation = nil
      task.cancel()
      throw error
    }
    // Commit the task description and operation checkpoint before giving it to the OS.
    task.resume()
    scheduleProcessing()
    finishProcessing(success: true)
  }

  private func fail(_ index: Int, message: String, httpStatus: Int? = nil) {
    state.jobs[index].status = "error"
    state.jobs[index].error = message
    state.jobs[index].httpStatus = httpStatus
    state.jobs[index].operation = nil
  }

  private func taskKey(_ session: String, _ task: Int) -> String { session + ":" + String(task) }

  private func operation(_ task: URLSessionTask) -> BackupOperation? {
    guard let description = task.taskDescription, description.utf8.count <= 16384,
      let data = description.data(using: .utf8) else { return nil }
    return try? JSONDecoder().decode(BackupOperation.self, from: data)
  }

  private func currentIndex(_ operation: BackupOperation) -> Int? {
    guard config?.account == operation.account else { return nil }
    return state.jobs.firstIndex {
      $0.input.id == operation.jobID && $0.generation == operation.generation
        && $0.operation == operation && !$0.terminal
    }
  }

  private func completed(_ session: String, task: URLSessionTask, error: Error?) {
    let key = taskKey(session, task.taskIdentifier)
    let data = responses.removeValue(forKey: key) ?? Data()
    let invalid = invalidResponses.remove(key) != nil
    tasks.removeValue(forKey: key)
    guard let operation = operation(task) else { return }
    let index = currentIndex(operation)
    if let index { state.jobs[index].operation = nil }
    // A stale callback may clean only its unique body, never the current generation or original.
    do {
      try BackupFiles.remove(BackupFiles.owned(operation.body, account: operation.account,
                                             id: operation.jobID, create: false))
    } catch {
      if let index { fail(index, message: message(error)); persistOrHalt() }
      else { fatalError = message(error) }
      return
    }
    guard let index else { pump(); return }
    let status = (task.response as? HTTPURLResponse)?.statusCode
    let redirected = task.response?.url != nil && task.response?.url != task.originalRequest?.url
    if invalid || redirected {
      fail(index, message: "A background request was redirected or its response exceeded limits. Completion was not accepted. Reopen and Retry.",
           httpStatus: status)
    } else if let error {
      let code = (error as NSError).code
      if (error as NSError).domain == NSURLErrorDomain,
        [NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorDataNotAllowed].contains(code),
        !networkAllowed {
        state.jobs[index].status = "queued"
        state.jobs[index].error = "Waiting for the allowed network. Reopen if iOS does not resume."
      } else {
        fail(index, message: "Background transfer was interrupted (network code \(code)). Reopen and Retry to resume checkpoints.",
             httpStatus: status)
      }
    } else if let status, (200..<300).contains(status) {
      do { try accept(index, operation: operation, data: data) }
      catch { fail(index, message: message(error), httpStatus: status) }
    } else {
      rejected(index, operation: operation, status: status ?? 0)
    }
    persistOrHalt()
    if fatalError == nil {
      do { try cleanupTerminalStaging([state.jobs[index].input.id]) }
      catch { fatalError = message(error) }
    }
    pump()
  }

  private func accept(_ index: Int, operation: BackupOperation, data: Data) throws {
    guard let config else { return }
    switch operation.kind {
    case "create":
      guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw BackupFailure.message("The server returned an invalid upload response.")
      }
      if object["duplicate"] as? Bool == true, let media = object["media"] {
        try completeMedia(index, data: JSONSerialization.data(withJSONObject: media), config: config)
        return
      }
      guard let uploadID = object["uploadId"] as? String, BackupTicket.validUploadID(uploadID) else {
        throw BackupFailure.message("The server returned an invalid upload identifier.")
      }
      state.jobs[index].uploadID = uploadID
      state.jobs[index].ticket = nil
      state.jobs[index].blocks = []
      state.jobs[index].committed = false
      state.jobs[index].thumbnailUploaded = false
      // The reservation exists already. Save its ID even if the remaining ticket is
      // malformed/untrusted, so explicit Retry renews rather than reserving storage again.
      try save()
      let ticket = try JSONDecoder().decode(BackupTicket.self, from: data)
      try ticket.validate(config, expectedID: uploadID)
      state.jobs[index].ticket = ticket
    case "renew":
      let ticket = try JSONDecoder().decode(BackupTicket.self, from: data)
      try ticket.validate(config, expectedID: state.jobs[index].uploadID)
      state.jobs[index].ticket = ticket
    case "block":
      guard let block = operation.block, let size = state.jobs[index].size else {
        throw BackupFailure.message("Invalid completed block checkpoint.")
      }
      if !state.jobs[index].blocks.contains(block) { state.jobs[index].blocks.append(block) }
      state.jobs[index].renewAttempts = 0
      let completed = min(size, Int64(state.jobs[index].blocks.count) * Int64(BackupFiles.blockSize))
      state.jobs[index].progress = 0.15 + 0.8 * Double(completed) / Double(size)
    case "commit":
      state.jobs[index].committed = true
      state.jobs[index].renewAttempts = 0
    case "thumbnail":
      state.jobs[index].thumbnailUploaded = true
      state.jobs[index].renewAttempts = 0
      state.jobs[index].progress = 0.98
    case "complete":
      try completeMedia(index, data: data, config: config)
      return
    default: throw BackupFailure.message("Unknown completed native upload operation.")
    }
    state.jobs[index].status = "queued"
    state.jobs[index].error = nil
    state.jobs[index].httpStatus = nil
  }

  private func completeMedia(_ index: Int, data: Data, config: BackupConfiguration) throws {
    let media = try JSONDecoder().decode(BackupMedia.self, from: data)
    guard media.id == state.jobs[index].sha256, media.size == state.jobs[index].size,
      !media.name.isEmpty, !media.createdAt.isEmpty else {
      throw BackupFailure.message("Server completion did not match the immutable original.")
    }
    _ = try trustedBlob(media.url, host: config.blobHost)
    if let thumbnail = media.thumbnailUrl { _ = try trustedBlob(thumbnail, host: config.blobHost) }
    state.jobs[index].media = media
    state.jobs[index].status = "done"
    state.jobs[index].progress = 1
    state.jobs[index].error = nil
    state.jobs[index].httpStatus = nil
    state.jobs[index].ticket = nil
  }

  private func rejected(_ index: Int, operation: BackupOperation, status: Int) {
    let backend = ["create", "renew", "complete"].contains(operation.kind)
    if status == 507 {
      let text = "Account storage is full (507). Background queue paused. Free space, then Retry or Cancel."
      state.pause = text
      state.pauseStatus = status
      state.pauseJobID = state.jobs[index].input.id
      fail(index, message: text, httpStatus: status)
    } else if backend && (status == 401 || status == 403) {
      let text = "Sign-in expired. Background queue paused. Reopen the app and Retry to refresh Google sign-in."
      state.pause = text
      state.pauseStatus = status
      state.pauseJobID = state.jobs[index].input.id
      fail(index, message: text, httpStatus: status)
    } else if !backend && status == 403 && state.jobs[index].renewAttempts < 3 {
      state.jobs[index].ticket = nil
      state.jobs[index].status = "queued"
    } else if operation.kind == "renew" && (status == 404 || status == 409)
      && state.jobs[index].restarts < 2 {
      resetUpload(index)
      state.jobs[index].restarts += 1
      state.jobs[index].status = "queued"
    } else {
      if status == 400 && (operation.kind == "commit" || operation.kind == "complete") {
        state.jobs[index].blocks = []
        state.jobs[index].committed = false
        state.jobs[index].thumbnailUploaded = false
      }
      fail(index, message: "Background \(backend ? "API" : "storage") request failed (\(status)). Reopen and Retry to resume.",
           httpStatus: status)
    }
  }

  func launched(processingRegistered: Bool) {
    queue.async {
      self.processingRegistered = processingRegistered
      if !processingRegistered {
        self.schedulerError = "iOS processing registration is unavailable. Reopen to prepare remaining originals."
      }
      self.whenReady { self.pump() }
    }
  }

  func foreground() {
    queue.async {
      self.active = true
      self.backgroundDeadline = nil
      self.preparationPaused = false
      self.whenReady { self.pump() }
    }
  }

  func background() {
    queue.async {
      self.active = false
      self.backgroundDeadline = Date().addingTimeInterval(25)
      if self.processingTask == nil { self.preparation?.lease.begin() }
      self.whenReady {
        self.scheduleProcessing()
        self.pump()
      }
    }
  }

  func processing(_ task: BGProcessingTask) {
    task.expirationHandler = { [weak self, weak task] in
      guard let self else { return }
      self.queue.async {
        guard let task, self.processingTask === task else { return }
        self.preparationPaused = true
        self.preparation?.cancellation.cancel("iOS processing time expired. Reopen to continue preparation.")
        self.persistOrHalt()
        self.finishProcessing(success: false)
        self.scheduleProcessing()
      }
    }
    queue.async {
      self.processingTask = task
      self.processingScheduled = false
      self.preparationPaused = false
      self.whenReady { self.pump() }
    }
  }

  private func finishProcessing(success: Bool) {
    if let task = processingTask {
      processingTask = nil
      task.expirationHandler = nil
      task.setTaskCompleted(success: success)
    }
  }

  private func scheduleProcessing() {
    guard processingRegistered, !processingScheduled, config != nil, state.pause == nil,
      state.jobs.contains(where: { !$0.terminal }) else { return }
    let request = BGProcessingTaskRequest(identifier: Self.processingIdentifier)
    request.requiresNetworkConnectivity = true
    request.requiresExternalPower = false
    request.earliestBeginDate = Date().addingTimeInterval(15 * 60)
    do {
      // Replaces our own outstanding request; never cancels another module's background work.
      BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.processingIdentifier)
      try BGTaskScheduler.shared.submit(request)
      processingScheduled = true
      schedulerError = nil
    } catch {
      schedulerError = "iOS did not schedule preparation. Reopen the app to continue; existing background transfers may still run."
    }
  }

  func backgroundEvents(_ identifier: String, completion: @escaping () -> Void) {
    queue.async {
      self.completions[identifier, default: []].append(completion)
      if self.finishedEvents.remove(identifier) != nil { self.finishEvents(identifier) }
    }
  }

  private func finishEvents(_ identifier: String) {
    persistOrHalt()
    guard let callbacks = completions.removeValue(forKey: identifier) else {
      finishedEvents.insert(identifier)
      return
    }
    DispatchQueue.main.async { callbacks.forEach { $0() } }
  }
}

extension BackgroundBackupEngine: URLSessionDataDelegate, URLSessionTaskDelegate {
  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    let rejected = response.url != dataTask.originalRequest?.url
      || response.expectedContentLength > 64 * 1024
      || ((response as? HTTPURLResponse).map { (300..<400).contains($0.statusCode) } ?? false)
    if rejected, let identifier = session.configuration.identifier {
      queue.async { self.invalidResponses.insert(self.taskKey(identifier, dataTask.taskIdentifier)) }
    }
    completionHandler(rejected ? .cancel : .allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let identifier = session.configuration.identifier else { return }
    // Backpressure the delegate rather than queuing an unbounded number of response chunks.
    let shouldCancel = queue.sync { () -> Bool in
      let key = self.taskKey(identifier, dataTask.taskIdentifier)
      guard !self.invalidResponses.contains(key) else { return true }
      var response = self.responses[key] ?? Data()
      guard data.count <= 64 * 1024 - response.count else {
        self.invalidResponses.insert(key)
        return true
      }
      response.append(data)
      self.responses[key] = response
      return false
    }
    if shouldCancel { dataTask.cancel() }
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    // Apple calls this only for default/ephemeral sessions; background sessions follow
    // redirects automatically. Final URLs/metrics are checked, but cannot prevent transmission.
    completionHandler(nil)
    if let identifier = session.configuration.identifier {
      queue.async { self.invalidResponses.insert(self.taskKey(identifier, task.taskIdentifier)) }
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didFinishCollecting metrics: URLSessionTaskMetrics) {
    if metrics.redirectCount > 0, let identifier = session.configuration.identifier {
      queue.async {
        self.invalidResponses.insert(self.taskKey(identifier, task.taskIdentifier))
        task.cancel()
      }
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let identifier = session.configuration.identifier else { return }
    queue.sync {
      if self.ready { self.completed(identifier, task: task, error: error) }
      else { self.bootstrapCompletions.append((identifier, task, error)) }
    }
  }

  func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
    guard let identifier = session.configuration.identifier else { return }
    queue.async { self.whenReady { self.finishEvents(identifier) } }
  }
}
