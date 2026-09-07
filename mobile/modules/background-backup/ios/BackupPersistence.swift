import Foundation
import CryptoKit
import Security

enum BackupFailure: Error, LocalizedError {
  case message(String)
  var errorDescription: String? {
    switch self { case .message(let message): return message }
  }
}

struct BackupConfiguration: Codable {
  let userId: String
  let apiUrl: String
  let blobHost: String
  let token: String
  let allowMobile: Bool

  func validate() throws {
    guard !userId.isEmpty, userId.utf8.count <= 1024,
      !token.isEmpty, token.utf8.count <= 32768,
      token.unicodeScalars.allSatisfy({ $0.value > 32 && $0.value < 127 }),
      let url = URLComponents(string: apiUrl),
      url.scheme == "https", let host = url.host, !host.isEmpty,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      url.path.hasSuffix("/api"), url.url != nil,
      blobHost.range(of: "^[a-z0-9]{3,24}\\.blob\\.core\\.windows\\.net$", options: .regularExpression) != nil
    else { throw BackupFailure.message("Invalid HTTPS API, Azure host, account or sign-in configuration.") }
  }

  var account: String { BackupFiles.hash(userId) }
}

struct BackupInput: Codable, Equatable {
  let id: String
  let key: String
  let name: String
  let contentType: String
  let uri: String?
  let assetId: String?

  func validate() throws {
    let types: Set<String> = [
      "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic", "image/heif", "image/avif",
      "video/mp4", "video/quicktime", "video/webm", "video/x-m4v", "video/3gpp"
    ]
    guard !id.isEmpty, id.utf8.count <= 1024, !key.isEmpty, key.utf8.count <= 4096,
      !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.utf16.count <= 255,
      !name.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }),
      types.contains(contentType),
      (assetId?.isEmpty == false || uri?.hasPrefix("file://") == true)
    else { throw BackupFailure.message("Invalid backup item. Select a supported local photo or video.") }
  }
}

struct BackupMedia: Codable {
  let id: String
  let name: String
  let contentType: String
  let size: Int64
  let createdAt: String
  let url: String
  let thumbnailUrl: String?
}

struct BackupTicket: Codable {
  let uploadId: String
  let uploadUrl: String
  let thumbnailUploadUrl: String?
  let expiresAt: String
  let blockSize: Int

  var expiry: Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: expiresAt) ?? ISO8601DateFormatter().date(from: expiresAt)
  }

  static func validUploadID(_ value: String) -> Bool {
    value.range(of: "^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$",
                options: .regularExpression) != nil
  }

  func validate(_ config: BackupConfiguration, expectedID: String?) throws {
    guard blockSize == BackupFiles.blockSize, expiry != nil,
      Self.validUploadID(uploadId),
      expectedID == nil || expectedID == uploadId
    else { throw BackupFailure.message("The server returned an invalid upload ticket. Retry.") }
    _ = try trustedBlob(uploadUrl, host: config.blobHost)
    for raw in [uploadUrl, thumbnailUploadUrl].compactMap({ $0 }) {
      let url = try trustedBlob(raw, host: config.blobHost)
      guard url.queryItems?.contains(where: { $0.name == "comp" || $0.name == "blockid" }) != true else {
        throw BackupFailure.message("Storage authorization already contains an upload operation.")
      }
    }
  }
}

func trustedBlob(_ raw: String, host: String) throws -> URLComponents {
  guard let url = URLComponents(string: raw), url.scheme == "https", url.host == host,
    url.port == nil, url.user == nil, url.password == nil, url.fragment == nil,
    url.queryItems?.contains(where: { $0.name == "sig" && !($0.value ?? "").isEmpty }) == true,
    url.url != nil
  else { throw BackupFailure.message("The server returned an untrusted Azure storage URL.") }
  return url
}

struct BackupOperation: Codable, Equatable {
  let nonce: String
  let account: String
  let jobID: String
  let generation: String
  let kind: String
  let block: Int?
  let session: String
  var taskID: Int
  let body: String
}

struct BackupJob: Codable {
  let input: BackupInput
  var generation = UUID().uuidString
  var status = "queued"
  var progress: Double = 0
  var error: String?
  var httpStatus: Int?
  var media: BackupMedia?
  var original: String?
  var thumbnail: String?
  var sha256: String?
  var size: Int64?
  var uploadID: String?
  var ticket: BackupTicket?
  var blocks: [Int] = []
  var committed = false
  var thumbnailUploaded = false
  var renewAttempts = 0
  var restarts = 0
  var operation: BackupOperation?

  var terminal: Bool { status == "done" || status == "cancelled" || status == "error" }
  var canAcknowledge: Bool { status == "done" || status == "cancelled" }
}

struct BackupState: Codable {
  var version = 1
  var jobs: [BackupJob] = []
  var pause: String?
  var pauseStatus: Int?
  var pauseJobID: String?
  var apiURL: String?
  var blobHost: String?
}

struct BackupSnapshot: Encodable {
  let id: String
  let status: String
  let progress: Double
  let error: String?
  let httpStatus: Int?
  let media: BackupMedia?
}

enum BackupCredentials {
  private static var query: [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "Syncachu") + ".background-backup",
      kSecAttrAccount as String: "active-account"
    ]
  }

  static func read() throws -> BackupConfiguration? {
    var attributes = query
    attributes[kSecReturnData as String] = true
    attributes[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(attributes as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw BackupFailure.message("Unlock this device and reopen Syncachu to resume background backup.")
    }
    let config = try JSONDecoder().decode(BackupConfiguration.self, from: data)
    try config.validate()
    return config
  }

  static func write(_ config: BackupConfiguration) throws {
    let values: [String: Any] = [
      kSecValueData as String: try JSONEncoder().encode(config),
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    ]
    let status = SecItemUpdate(query as CFDictionary, values as CFDictionary)
    if status == errSecItemNotFound {
      var attributes = query
      values.forEach { attributes[$0.key] = $0.value }
      guard SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess else {
        throw BackupFailure.message("Could not securely save background sign-in. Reopen and retry.")
      }
    } else if status != errSecSuccess {
      throw BackupFailure.message("Could not securely update background sign-in. Reopen and retry.")
    }
  }

  static func clear() throws {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw BackupFailure.message("Could not remove background sign-in. Unlock the device and stop again.")
    }
  }
}

enum BackupFiles {
  static let blockSize = 4 * 1024 * 1024
  static let maxSize: Int64 = 2 * 1024 * 1024 * 1024
  static let manager = FileManager.default

  static func hash(_ string: String) -> String {
    SHA256.hash(data: Data(string.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  static func root(create: Bool = true) throws -> URL {
    let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                  appropriateFor: nil, create: create)
    let url = support.appendingPathComponent("SyncachuBackgroundBackup", isDirectory: true)
    if create { return try directory(url) }
    return url
  }

  @discardableResult
  static func directory(_ url: URL) throws -> URL {
    try manager.createDirectory(at: url, withIntermediateDirectories: true, attributes: [
      .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication
    ])
    var protectedURL = url
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    try protectedURL.setResourceValues(values)
    try manager.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                              ofItemAtPath: url.path)
    return url
  }

  static func account(_ hash: String, create: Bool = true) throws -> URL {
    guard hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
      throw BackupFailure.message("Invalid private backup directory.")
    }
    let url = try root(create: create).appendingPathComponent(hash, isDirectory: true)
    if create { return try directory(url) }
    return url
  }

  static func job(_ accountHash: String, _ id: String, create: Bool = true) throws -> URL {
    let url = try account(accountHash, create: create).appendingPathComponent(hash(id), isDirectory: true)
    if create { return try directory(url) }
    return url
  }

  static func owned(_ relative: String, account: String, id: String, create: Bool = true) throws -> URL {
    let base = try job(account, id, create: create)
    let components = relative.split(separator: "/", omittingEmptySubsequences: false)
    guard !components.isEmpty, components.allSatisfy({
      !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\\")
    }) else { throw BackupFailure.message("Invalid private staging checkpoint.") }
    let candidate = base.appendingPathComponent(relative).standardizedFileURL
    guard candidate.resolvingSymlinksInPath().path.hasPrefix(base.resolvingSymlinksInPath().path + "/") else {
      throw BackupFailure.message("Invalid private staging checkpoint.")
    }
    return candidate
  }

  static func write(_ data: Data, to url: URL) throws {
    try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    var value = url
    var resources = URLResourceValues()
    resources.isExcludedFromBackup = true
    try value.setResourceValues(resources)
  }

  static func load(_ accountHash: String) throws -> BackupState {
    let path = try account(accountHash).appendingPathComponent("queue.json")
    guard manager.fileExists(atPath: path.path) else { return BackupState() }
    let state = try JSONDecoder().decode(BackupState.self, from: Data(contentsOf: path))
    guard state.version == 1 else { throw BackupFailure.message("Unsupported native backup checkpoint.") }
    var identifiers: Set<String> = []
    for job in state.jobs {
      try job.input.validate()
      guard identifiers.insert(job.input.id).inserted,
        ["queued", "working", "error", "done", "cancelled"].contains(job.status),
        job.progress.isFinite, (0...1).contains(job.progress),
        UUID(uuidString: job.generation) != nil,
        job.renewAttempts >= 0, job.restarts >= 0
      else { throw BackupFailure.message("Native backup checkpoint is invalid. Existing originals were not changed.") }
      if let size = job.size {
        guard size > 0, size <= maxSize, job.original != nil,
          job.sha256?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
        else { throw BackupFailure.message("Native original checkpoint is invalid.") }
        let count = Int((size + Int64(blockSize) - 1) / Int64(blockSize))
        guard job.blocks.allSatisfy({ $0 >= 0 && $0 < count }),
          Set(job.blocks).count == job.blocks.count else {
          throw BackupFailure.message("Native block checkpoint is invalid.")
        }
      } else if job.original != nil || job.sha256 != nil || !job.blocks.isEmpty {
        throw BackupFailure.message("Native original checkpoint is incomplete.")
      }
      if job.status == "done" {
        guard let media = job.media,
          job.sha256 == nil || media.id == job.sha256,
          job.size == nil || media.size == job.size,
          media.id.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
          media.size > 0, media.size <= maxSize, !media.name.isEmpty, !media.contentType.isEmpty,
          !media.createdAt.isEmpty, !media.url.isEmpty else {
          throw BackupFailure.message("Native completion checkpoint is incomplete.")
        }
      }
    }
    return state
  }

  static func save(_ state: BackupState, accountHash: String) throws {
    try write(JSONEncoder().encode(state), to: account(accountHash).appendingPathComponent("queue.json"))
  }

  static func remove(_ url: URL) throws {
    let rootURL = try root(create: false).standardizedFileURL
    guard url.standardizedFileURL.path.hasPrefix(rootURL.path + "/"),
      url.resolvingSymlinksInPath().path.hasPrefix(rootURL.resolvingSymlinksInPath().path + "/")
    else { throw BackupFailure.message("Refusing to remove a file outside private backup staging.") }
    if manager.fileExists(atPath: url.path) { try manager.removeItem(at: url) }
  }

  static func blockID(_ index: Int) -> String {
    Data(String(format: "%08d", Int32(index)).utf8).base64EncodedString()
  }
}
