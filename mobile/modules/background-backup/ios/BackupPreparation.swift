import Foundation
import CryptoKit
import Photos
import UIKit
import ImageIO
import AVFoundation

final class BackupCancellation: @unchecked Sendable {
  private let lock = NSLock()
  private var reason: String?

  func cancel(_ message: String) {
    lock.lock()
    if reason == nil { reason = message }
    lock.unlock()
  }

  var cancelled: Bool {
    lock.lock()
    defer { lock.unlock() }
    return reason != nil
  }

  func check() throws {
    lock.lock()
    let message = reason
    lock.unlock()
    if let message { throw BackupFailure.message(message) }
  }
}

// This is a bounded preparation grace period, not a background upload service.
final class BackupPreparationLease: @unchecked Sendable {
  private let cancellation: BackupCancellation
  private var task: UIBackgroundTaskIdentifier = .invalid
  private var timer: DispatchWorkItem?

  init(_ cancellation: BackupCancellation) { self.cancellation = cancellation }

  func begin() {
    DispatchQueue.main.async {
      guard self.task == .invalid else { return }
      self.task = UIApplication.shared.beginBackgroundTask(withName: "Prepare backup snapshot") {
        self.cancellation.cancel("Preparation paused by iOS. Reopen the app to continue.")
        self.finishOnMain()
      }
      if self.task == .invalid && UIApplication.shared.applicationState != .active {
        self.cancellation.cancel("Preparation needs foreground time. Reopen the app to continue.")
      }
      let timer = DispatchWorkItem {
        if UIApplication.shared.applicationState != .active {
          self.cancellation.cancel("Preparation paused by iOS. Reopen the app to continue.")
        }
        self.finishOnMain()
      }
      self.timer = timer
      DispatchQueue.main.asyncAfter(deadline: .now() + 25, execute: timer)
    }
  }

  func finish() { DispatchQueue.main.async { self.finishOnMain() } }

  @MainActor private func finishOnMain() {
    timer?.cancel()
    timer = nil
    if task != .invalid { UIApplication.shared.endBackgroundTask(task) }
    task = .invalid
  }
}

struct BackupPreparedFile {
  let directory: String
  let original: String
  let thumbnail: String?
  let size: Int64
  let sha256: String
}

private final class BackupOriginalWriter: @unchecked Sendable {
  private let lock = NSLock()
  private var handle: FileHandle?
  private var digest = SHA256()
  private var count: Int64 = 0
  private var failure: Error?
  private let cancellation: BackupCancellation

  init(url: URL, cancellation: BackupCancellation) throws {
    self.cancellation = cancellation
    try BackupFiles.write(Data(), to: url)
    handle = try FileHandle(forWritingTo: url)
  }

  func append(_ data: Data) {
    lock.lock()
    defer { lock.unlock() }
    guard failure == nil, let handle else { return }
    do {
      try cancellation.check()
      guard Int64(data.count) <= BackupFiles.maxSize - count else {
        throw BackupFailure.message("Choose a non-empty original up to 2 GiB.")
      }
      try handle.write(contentsOf: data)
      digest.update(data: data)
      count += Int64(data.count)
    } catch { failure = error }
  }

  func check() throws {
    lock.lock()
    let error = failure
    lock.unlock()
    try cancellation.check()
    if let error { throw error }
  }

  func finish() throws -> (Int64, String) {
    lock.lock()
    defer { lock.unlock() }
    try cancellation.check()
    if let failure { throw failure }
    guard count > 0, let handle else {
      throw BackupFailure.message("Choose a non-empty original up to 2 GiB.")
    }
    try handle.synchronize()
    try handle.close()
    self.handle = nil
    return (count, digest.finalize().map { String(format: "%02x", $0) }.joined())
  }

  func close() throws {
    lock.lock()
    defer { lock.unlock() }
    if let handle {
      self.handle = nil
      try handle.close()
    }
  }
}

private final class BackupPhotoCompletion: @unchecked Sendable {
  private let lock = NSLock()
  private var storedError: Error?
  let signal = DispatchSemaphore(value: 0)

  func finish(_ error: Error?) {
    lock.lock()
    storedError = error
    lock.unlock()
    signal.signal()
  }

  var error: Error? {
    lock.lock()
    defer { lock.unlock() }
    return storedError
  }
}

private final class BackupVideoFrame: @unchecked Sendable {
  private let lock = NSLock()
  private var storedImage: CGImage?
  let signal = DispatchSemaphore(value: 0)

  func finish(_ image: CGImage?) {
    lock.lock()
    storedImage = image
    lock.unlock()
    signal.signal()
  }

  var image: CGImage? {
    lock.lock()
    defer { lock.unlock() }
    return storedImage
  }
}

enum BackupPreparation {
  static func prepare(
    _ input: BackupInput, account: String, cancellation: BackupCancellation
  ) throws -> BackupPreparedFile {
    try cancellation.check()
    let directoryName = "snapshot-" + UUID().uuidString
    let directory = try BackupFiles.owned(directoryName, account: account, id: input.id)
    try BackupFiles.directory(directory)
    let original = directory.appendingPathComponent("original")
    let writer = try BackupOriginalWriter(url: original, cancellation: cancellation)
    do {
      if let assetID = input.assetId, !assetID.isEmpty {
        try copyPhoto(assetID, video: input.contentType.hasPrefix("video/"),
                      writer: writer, cancellation: cancellation)
      } else {
        try copyFile(input.uri, writer: writer, cancellation: cancellation)
      }
      let (size, digest) = try writer.finish()
      try BackupFiles.manager.setAttributes([.posixPermissions: NSNumber(value: 0o400)], ofItemAtPath: original.path)
      try cancellation.check()
      var thumbnailName: String?
      if let data = try thumbnail(original, video: input.contentType.hasPrefix("video/"),
                                  cancellation: cancellation) {
        try BackupFiles.write(data, to: directory.appendingPathComponent("thumbnail.jpg"))
        thumbnailName = directoryName + "/thumbnail.jpg"
      }
      try cancellation.check()
      return BackupPreparedFile(directory: directoryName, original: directoryName + "/original",
                                thumbnail: thumbnailName, size: size, sha256: digest)
    } catch {
      let originalError = error
      do {
        try writer.close()
        try BackupFiles.remove(directory)
      } catch {
        throw BackupFailure.message("Could not clean an interrupted private snapshot. Reopen and retry.")
      }
      throw originalError
    }
  }

  private static func copyFile(
    _ raw: String?, writer: BackupOriginalWriter, cancellation: BackupCancellation
  ) throws {
    guard let raw, let components = URLComponents(string: raw),
      let url = components.url, url.isFileURL,
      components.host == nil || components.host == "" || components.host == "localhost",
      components.user == nil, components.password == nil, components.query == nil, components.fragment == nil
    else { throw BackupFailure.message("Original is unavailable locally. Select it again.") }
    let accessing = url.startAccessingSecurityScopedResource()
    defer { if accessing { url.stopAccessingSecurityScopedResource() } }
    let before = try BackupFiles.manager.attributesOfItem(atPath: url.path)
    guard before[.type] as? FileAttributeType == .typeRegular,
      let size = before[.size] as? NSNumber, size.int64Value > 0, size.int64Value <= BackupFiles.maxSize
    else { throw BackupFailure.message("Choose a non-empty local original up to 2 GiB.") }
    let source = try FileHandle(forReadingFrom: url)
    do {
      while true {
        let more = try autoreleasepool { () throws -> Bool in
          try cancellation.check()
          let chunk = try source.read(upToCount: 1024 * 1024) ?? Data()
          if chunk.isEmpty { return false }
          writer.append(chunk)
          try writer.check()
          return true
        }
        if !more { break }
      }
      try source.close()
    } catch {
      // FileHandle also closes on deallocation if closing itself fails.
      let originalError = error
      do { try source.close() } catch {
        throw BackupFailure.message("Could not close the local original after a read failure.")
      }
      throw originalError
    }
    let after = try BackupFiles.manager.attributesOfItem(atPath: url.path)
    guard before[.size] as? NSNumber == after[.size] as? NSNumber,
      before[.modificationDate] as? Date == after[.modificationDate] as? Date,
      before[.systemFileNumber] as? NSNumber == after[.systemFileNumber] as? NSNumber
    else { throw BackupFailure.message("Original changed while copying. Retry to make a new snapshot.") }
  }

  private static func copyPhoto(
    _ identifier: String, video: Bool, writer: BackupOriginalWriter, cancellation: BackupCancellation
  ) throws {
    guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [identifier], options: nil).firstObject else {
      throw BackupFailure.message("Photo permission or original is unavailable. Restore access and retry.")
    }
    let resources = PHAssetResource.assetResources(for: asset)
    guard let resource = resources.first(where: { $0.type == (video ? .video : .photo) }) else {
      throw BackupFailure.message("The original photo or video resource is unavailable locally.")
    }
    let options = PHAssetResourceRequestOptions()
    options.isNetworkAccessAllowed = false
    let completion = BackupPhotoCompletion()
    let manager = PHAssetResourceManager.default()
    let requestID = manager.requestData(for: resource, options: options) { data in
      writer.append(data)
    } completionHandler: { error in
      completion.finish(error)
    }
    do {
      while completion.signal.wait(timeout: .now() + 0.2) == .timedOut {
        try writer.check()
      }
      try writer.check()
      if completion.error != nil {
        throw BackupFailure.message("Original is not available locally. Download it in Photos, restore permission, then retry.")
      }
    } catch {
      manager.cancelDataRequest(requestID)
      throw error
    }
  }

  private static func thumbnail(
    _ original: URL, video: Bool, cancellation: BackupCancellation
  ) throws -> Data? {
    try cancellation.check()
    let image: CGImage?
    if video {
      let generator = AVAssetImageGenerator(asset: AVURLAsset(url: original))
      generator.appliesPreferredTrackTransform = true
      generator.maximumSize = CGSize(width: 480, height: 480)
      let frame = BackupVideoFrame()
      generator.generateCGImagesAsynchronously(forTimes: [NSValue(time: .zero)]) { _, image, _, _, _ in
        frame.finish(image)
      }
      let deadline = Date().addingTimeInterval(8)
      while frame.signal.wait(timeout: .now() + 0.2) == .timedOut {
        if cancellation.cancelled || Date() >= deadline {
          generator.cancelAllCGImageGeneration()
          try cancellation.check()
          return nil
        }
      }
      image = frame.image
    } else if let source = CGImageSourceCreateWithURL(original as CFURL, nil) {
      image = CGImageSourceCreateThumbnailAtIndex(source, 0, [
        kCGImageSourceCreateThumbnailFromImageAlways: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: 480,
        kCGImageSourceShouldCacheImmediately: true
      ] as CFDictionary)
    } else {
      image = nil
    }
    try cancellation.check()
    guard let image else { return nil }
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(output, "public.jpeg" as CFString, 1, nil) else {
      return nil
    }
    CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.65] as CFDictionary)
    guard CGImageDestinationFinalize(destination), output.length <= 1024 * 1024 else { return nil }
    return output as Data
  }
}
