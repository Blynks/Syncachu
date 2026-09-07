[Syncachu](../README.md) / [Documentation](README.md) / Background backup

# Background backup

After you tap **Sync all** or **Choose files**, queued backups use native workers
and can continue when you switch apps or lock the screen. Android and iOS provide
different execution models; neither guarantees an always-running backup process.

**On this page:** [Discovery](#discovery-and-queueing) | [Android](#android) |
[iOS](#ios) | [Network policy](#network-policy) |
[Local storage](#local-storage-and-checkpoints) | [Recovery](#recovering-paused-work)

> [!IMPORTANT]
> Keep the app open until the library scan finishes. Photos not yet discovered
> are not queued. Auto-sync discovers new media only while the app is active;
> Syncachu does not continuously monitor the photo library while closed.

## Discovery and queueing

Manual selection, Sync all, and optional auto-sync while the app is open share
the same upload queue. Limited photo-library permission exposes only approved
items. Media stored only in iCloud or otherwise inaccessible on-device may need
to be downloaded before it can be backed up.

The local Expo module must be included in a new native build. Rebuild and
reinstall the development client or EAS beta binary after native changes; a
JavaScript update alone cannot add a service. Older binaries without the module
explicitly retain foreground-only uploading.

| Platform | Execution model | Practical boundary |
| --- | --- | --- |
| Android | Data-sync foreground service with an ongoing progress notification. | Starts from the open app; service time limits and vendor battery policies can pause work. |
| iOS | Background URLSession file transfers, plus bounded or OS-scheduled preparation time. | iOS decides when preparation runs; large libraries may require reopening the app. |

## Android

Allow notifications to see backup progress and the notification's stop action.
Denying notification permission does not grant extra background rights: Android
still exposes the foreground service in its Active apps/task manager.

The service starts from the open app, follows the Wi-Fi/mobile-data setting
natively, and stops when its queue is finished. There is no boot receiver or
automatic force-stop recovery. Android's data-sync time limits and vendor battery
restrictions can pause a long backup; reopen the app and tap **Resume backup**.

## iOS

URLSession handles file-backed transfers without a running JavaScript thread.
Its native delegate handles ticket renewal and finalization. Preparing originals
and thumbnails uses foreground time, a bounded background task, or an OS-scheduled
processing task.

iOS decides when processing runs. Low Power Mode, connectivity, protected files
before first unlock, and a user force-quit can delay or stop work. This is not an
always-running iOS service.

Use direct, nonredirecting HTTPS API and Blob endpoints. Apple's background
URLSession follows redirects automatically; the client can reject an observed
redirected result but cannot prevent its transmission. Read the full
[redirect boundary](security.md#ios-background-redirects) before deployment.

## Network policy

Uploads default to **Wi-Fi only**; cellular data requires explicit opt-in.
Native workers enforce Wi-Fi-only conservatively:

| Platform | Required network when cellular uploads are disabled |
| --- | --- |
| Android | Validated Wi-Fi without a VPN or cellular transport. |
| iOS | Wi-Fi that is not marked expensive or constrained. |

A hotspot, VPN, or Low Data Mode can leave backup waiting even when the phone
appears online. Allow mobile data only if using those networks is acceptable.

## Local storage and checkpoints

Native workers keep **one working original snapshot per account** before hashing
and transferring it, so enough free device space for that snapshot is required.
Files copied by Choose files and retained work for signed-out accounts can use
additional space.

Successful native uploads release their private staging files after saving a
completion receipt, without waiting for the app to reopen. Workers persist block
checkpoints and completion results; reopening reconciles these with the visible
queue before acknowledging native results.

Preparation and foreground-only uploads require the local original to remain
available. Native uploads resume from their retained private snapshot. If that
snapshot is missing or damaged, cancel and select the original again; workers do
not silently replace it with potentially edited device media.

If a failed upload already has a private original snapshot, the native queue
pauses until that item is retried or cancelled. This preserves resumable bytes
without accumulating a second copy of the library on the device. Failures before
a snapshot is prepared do not prevent other accessible media from backing up.

## Recovering paused work

| Situation | What to do |
| --- | --- |
| Waiting for a permitted network | Connect to eligible Wi-Fi, or explicitly allow mobile data if acceptable. |
| Expired sign-in | Reopen the app and tap **Retry** to refresh credentials. |
| Quota error | Resolve available capacity or the configured limit, then use **Retry**. See [quota accounting](storage-and-quota.md). |
| Android service stopped or OS paused work | Reopen and use **Resume backup** / **Retry**; there is no automatic force-stop recovery. |
| Permission changed or original unavailable | Restore access or make the original available on-device, then retry. |
| Failed upload holding a snapshot | Retry or cancel that item before other native preparation can continue. |
| Missing or damaged native snapshot | Cancel and select the original again. |
| Expired gallery link | Refresh the gallery to obtain a new temporary URL. |

Cancel and sign-out stop native requests as well as foreground work. Neither
operation deletes media in Photos or MediaStore. Expired sign-in, permission
changes, quota failures, and unrecoverable transfer errors are shown in the queue.
Force-stopping the app stops backup.

---

[Documentation index](README.md) | [Security model](security.md) |
[Device acceptance checks](development.md#device-acceptance-checks)
