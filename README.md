# Syncachu

A private photo/video backup app for iOS and Android, built with Expo, TypeScript,
Azure Functions, and private Azure Blob Storage.

## MVP scope

The first milestone is **Google sign-in → manual upload → uploaded-media gallery**.
Sync All and optional auto-sync while the app is open share the same upload queue.
Uploads default to Wi-Fi only; cellular data requires explicit opt-in.

After you tap **Sync all** or **Choose files**, queued backups use native workers
and can continue when you switch apps or lock the screen. Keep the app open until
the library scan finishes: photos not yet discovered are not queued.
Android uses a foreground service with an ongoing progress notification; iOS
uses background URLSession transfers and OS-scheduled preparation time.
This is still not continuous photo-library monitoring. The OS can pause work,
and force-stopping the app stops backup. Device-only media is never deleted.

## Layout

- `mobile/`: Expo application, network policy, and resumable upload queue.
- `mobile/modules/background-backup/`: local Expo module with Android and iOS
  native backup workers; included by Expo autolinking in new native builds.
- `api/`: authenticated Azure Functions API and private Blob Storage adapter.
- `infra/`: private-beta Bicep provisioning, OIDC deployment guide, and settings.

## Private-beta foundation

The API now admits only explicitly approved, verified Google email addresses.
The default quota is **1 TB total across the instance** (1,000,000,000,000 bytes),
shared by all approved accounts. Azure Table Storage atomically reserves capacity
before issuing upload URLs and charges each finalized per-user original and its
thumbnail once. The app displays used, reserved, and available storage.

Follow [the private deployment guide](infra/README.md) for reproducible Azure
provisioning, the manually triggered GitHub Actions/OIDC deployment, and EAS
internal Android/iOS builds. Restore, cloud deletion, and deletion of backed-up
device originals are not included.

## Security model

- The API verifies Google ID tokens, including issuer, audience, and expiry.
  Configure only the OAuth client IDs belonging to your application.
- `ALLOWED_GOOGLE_EMAILS` is a server-side private-beta allowlist. Missing/empty
  configuration fails closed; tokens must have a matching verified email.
  Changing it requires restarting/redeploying the Function App. The quota is
  instance-wide, not per-account. Approved users can see aggregate instance usage,
  but cannot see another account's media.
- Each Google account has a separate server-derived storage namespace.
- The API uses Azure credentials on the server, preferably managed identity.
  **Never put Azure storage keys, service-account credentials, or OAuth client
  secrets in the mobile app.** Expo public environment variables are bundled into
  the application and are not secret.
- Upload URLs are short-lived, HTTPS-only, blob-scoped SAS grants for staging
  objects, not container-wide or finalized-media write permissions.
- Completion verifies the original file's actual SHA-256 and size against an
  immutable upload snapshot before publishing it. Deduplication is per user.
- Originals and thumbnails remain private. Gallery URLs are temporary bearer
  credentials: do not log, share, or send them to analytics.
- Signing out stops client work, but previously issued SAS URLs remain valid until
  they expire. Storage contains filenames, hashes, sizes, and backup timestamps;
  originals may retain embedded EXIF/location metadata.
- Background workers use the same scoped SAS grants and authenticated API, not
  storage keys or a new long-lived server credential. iOS retains its current ID
  token in device-only Keychain storage for OS relaunch; sign-out removes it.
  Android keeps its ID token in memory. When authentication expires, reopen the
  app and tap Retry to refresh credentials. Native staging snapshots and native
  queue state stay in app-owned storage and are excluded from OS device backups.
- **iOS background transfers follow HTTP redirects automatically.** Unlike the
  foreground uploader and Android worker, Apple's background URLSession cannot
  refuse a redirect before sending the redirected request. Initial destinations
  are validated and observed redirected results are rejected, but that cannot
  undo transmission. Configure direct, trusted HTTPS API and Azure Blob endpoints
  that never redirect; do not put login pages, URL shorteners, canonical-host
  redirects, or redirecting proxies in front of them. This is an explicit
  platform tradeoff, not a guarantee that every iOS request remains on its
  initially validated host. See Apple's
  [background-session redirect behavior](https://developer.apple.com/documentation/foundation/urlsessiontaskdelegate/urlsession(_:task:willperformhttpredirection:newrequest:completionhandler:)).
- Azure encrypts data at rest and HTTPS protects transit. This is **not end-to-end
  encryption**: the backend and authorized Azure administrators can read files.

## Prerequisites

- Node.js 22 and npm.
- Azure CLI, Azure Functions Core Tools v4, and an Azure subscription.
- A Google Cloud project with OAuth consent configured and test users added if
  the consent screen is in testing mode.
- Android Studio or Xcode for native development builds. Google native sign-in
  requires a development build; Expo Go is not supported.

## Azure setup

1. Create a StorageV2 account for media. Require HTTPS and TLS 1.2 or newer,
   disable anonymous blob access, and disable shared-key access. Create a private
   container named `media` using an Entra-authenticated account. Do not enable a
   static website or public container access.
2. Create a Node.js 22 Azure Functions v4 app on Flex Consumption or Premium and
   enable its system-assigned managed identity. The Functions runtime's own
   host/deployment storage is separate from the private media account; configure
   it according to Azure's hosting requirements.
3. Grant the function identity **Storage Blob Data Contributor** at the media
   **storage-account** scope. Account scope is needed to request user-delegation
   keys, not just access blobs in a container. Allow time for RBAC propagation.
   Create the `syncachuquota` table and grant **Storage Table Data Contributor**
   on that table (or media account). The quota initializer also needs this role
   and Blob Data Reader on the media container. Keep the account's default tier
   Hot; the API explicitly promotes new originals to Cool and thumbnails to Hot.
4. For local development, run `az login` and grant your developer identity the
   same role on a development media account. The API uses
   `DefaultAzureCredential`; production should use its managed identity.
5. Configure the API settings described below. Never enable anonymous storage
   access to work around authentication errors.

Use a dedicated development account and test media first. Native clients do not
need Blob CORS rules; this MVP is not configured for browser sign-in or web backup.

## Google sign-in setup

1. Configure the Google OAuth consent screen and create a **Web application**
   OAuth client. Its client ID is the server audience used by native Google
   sign-in, not a client secret.
2. Create an **Android** OAuth client for your actual application package name and
   development signing certificate SHA-1. Register release/Play signing
   certificates separately before distribution.
3. Create an **iOS** OAuth client for your actual bundle identifier. Configure its
   client ID and reversed-client-ID URL scheme in the mobile environment/config.
4. Set the API's `GOOGLE_CLIENT_IDS` to the app's Web, Android, and iOS client IDs.
   The verifier checks both token audiences and any authorized-party (`azp`)
   claim, so the native client IDs must also be allowed. Do not use wildcards.
5. Rebuild the native app after changing package identifiers, URL schemes, or
   native sign-in plugin configuration.

## Run locally

Install each package independently, starting from the repository root:

```sh
cd api
npm ci
cp local.settings.example.json local.settings.json
```

The API requires:

| Setting | Value |
| --- | --- |
| `GOOGLE_CLIENT_IDS` | Comma-separated Web/native Google client IDs accepted as audiences or authorized parties |
| `ALLOWED_GOOGLE_EMAILS` | Comma-separated approved verified Google emails; no wildcards |
| `AZURE_STORAGE_ACCOUNT_URL` | `https://YOUR_ACCOUNT.blob.core.windows.net` |
| `AZURE_STORAGE_CONTAINER` | Private media container name, normally `media` |
| `AZURE_QUOTA_TABLE` | Existing Table Storage quota table, normally `syncachuquota` |
| `STORAGE_QUOTA_BYTES` | Total instance limit in bytes, default `1000000000000` (decimal 1 TB) |

Replace the placeholders in `local.settings.json`, including the separate host
storage account. The `api/.env.example` file lists settings for deployment, but
Azure Functions does not load it automatically. Keep `local.settings.json` local.
Run `az login`. Before first startup, initialize the quota as described below,
then use `npm start` to build and start the Functions host.

### Initializing or upgrading quota accounting

Create the private media container and quota table first. Stop any old API and
wait for its in-flight completions to finish before importing an existing
library. Do not let another writer modify the catalog while initialization runs.
Set `AZURE_STORAGE_ACCOUNT_URL`, `AZURE_STORAGE_CONTAINER`, `AZURE_QUOTA_TABLE`,
and `STORAGE_QUOTA_BYTES` in your shell, then run `npm run quota:init` in `api/`.
This administrative command reads shell environment variables, **not**
`local.settings.json`. Use your local `az login`; do not set a production
`AZURE_CLIENT_ID` on a developer machine.

The initializer reads all finalized catalog records and their actual blob sizes,
including thumbnails, before marking accounting ready. Interrupted imports can
be retried without double counting. A ready ledger is never reset by rerunning
the command. Existing libraries above the limit remain accounted for, but cannot
add uploads until sufficient capacity is available. Missing or incomplete
initialization blocks new uploads and the usage endpoint with HTTP 503.

Upload reservations include the declared original size plus up to 1 MiB for a
thumbnail. Completion replaces that reservation with actual finalized bytes.
Unpublished reservations expire after 24 hours and are reclaimed by a timer
every 15 minutes; cancelling a local queue item does not immediately free its
server reservation. Once verified media starts publication, its reservation
does not expire unless the canonical media has already been charged. Retry an
interrupted completion: do not delete ledger rows to reclaim capacity, because
the original may already exist. Unresolved publication failures require
administrator investigation. The app pauses further uploads on a quota error;
use Retry once space or the configured limit is available.

**This is a logical media quota, not a storage-account or spending cap.** Staging
blobs, snapshots, versions, soft-deleted files, orphaned copies, catalog/ledger
metadata, and service logs can consume additional storage. Blob SAS grants
cannot constrain PUT payload size; uploaded content is checked at finalization.
Keep the beta allowlist small, apply staging cleanup, and configure budget alerts.

For identity-based host storage, the host/developer identity also needs **Storage
Blob Data Owner** on the host storage account. Additional host roles depend on
hosting and extensions; follow Microsoft's
[identity-based host storage guidance](https://learn.microsoft.com/azure/azure-functions/functions-reference#connecting-to-host-storage-with-an-identity).
This is separate from the media account's Blob Data Contributor role.

For the mobile app, start again from the repository root:

```sh
cd mobile
npm ci
cp .env.example .env
```

Configure `mobile/.env`:

| Setting | Value |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | Your reachable HTTPS API URL, ending in `/api` |
| `EXPO_PUBLIC_AZURE_BLOB_HOST` | Media storage hostname, without `https://` |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | Google Web OAuth client ID |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | Google iOS OAuth client ID |
| `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` | Reversed iOS client ID from Google |
| `EXPO_PUBLIC_APP_ID` | Your Android package name and iOS bundle identifier |

The app validates initial upload/gallery URLs against the configured storage
hostname. iOS background sessions have the redirect limitation described above.
A physical device cannot reach your computer through `localhost`;
use a reachable, trusted HTTPS development endpoint or your deployed API.
Do not disable TLS validation. Run `npm run android` or `npm run ios` to create
and launch a native development build. Use `npm start` for subsequent Metro
development sessions. iOS native builds require macOS and Xcode.

### Background backup behavior

Rebuild and reinstall the development client or EAS beta binary to include the
local native module. A JavaScript update alone cannot install a native service.
Older binaries without the module explicitly retain foreground-only uploading.

On Android, allow notifications to see backup progress and the notification's
stop action. Denying notification permission does not grant extra background
rights: Android still exposes the foreground service in its Active apps/task
manager. The service starts from the open app, follows the Wi-Fi/mobile-data
setting natively, and stops when its queue is finished. There is no boot receiver
or automatic force-stop recovery. Android's data-sync time limits and vendor
battery restrictions can pause a long backup; reopen and tap Resume backup.

Wi-Fi-only is enforced conservatively: Android requires validated Wi-Fi without
a VPN or cellular transport; iOS requires Wi-Fi that is not marked expensive or
constrained. A hotspot, VPN, or Low Data Mode can therefore leave backup waiting
even when the phone appears online. Allow mobile data only if using those
networks is acceptable.

On iOS, URLSession handles file-backed transfers without a running JavaScript
thread, and its native delegate handles ticket renewal and finalization.
Preparing originals and thumbnails uses foreground time, a bounded background
task, or an OS-scheduled processing task. iOS decides when processing runs;
large libraries may require reopening the app. Low Power Mode, connectivity,
protected files before first unlock, and a user force-quit can delay or stop
work. This is not an always-running iOS service.

Native workers keep one working original snapshot per account before hashing
and transferring it, so enough free device space for that snapshot is required.
Files copied by Choose files and retained work for signed-out accounts can use
additional space. Successful native uploads release their private staging files
after saving a completion receipt, without waiting for the app to reopen.
Workers persist block checkpoints and completion results; reopening
reconciles these with the visible queue before acknowledging native results.
Cancel and sign-out stop native requests as well as foreground work. Neither
operation deletes media in Photos or MediaStore. Expired sign-in, permission
changes, quota failures, and unrecoverable transfer errors are shown in the queue;
use Retry after resolving the cause.

If a failed upload already has a private original snapshot, the native queue
pauses until that item is retried or cancelled. This preserves its resumable
bytes without accumulating a second copy of the library on the device. Failures
before a snapshot is prepared do not prevent other accessible media from backing up.

## Automated checks

Run these commands in **each** package directory:

```sh
npm run typecheck
npm test
npm run build
npm audit
```

API tests cover authentication, request validation, ownership, deduplication,
immutable snapshot verification, and SAS scoping. Mobile tests cover hashing,
network policy, upload block planning, resuming/cancelling uploads, durable native
queue handoff, completion reconciliation, and sign-out/cancellation races. The
mobile build exports Android/iOS JavaScript bundles; it does not compile or test
the native Google sign-in SDK or background workers on a device. Native
compilation and the device acceptance checks below remain release requirements;
passing the JavaScript commands alone does not establish background reliability.

## API flow

All media routes require a Google ID token in the HTTP `Authorization` header,
using the bearer authentication scheme.

| Route | Purpose |
| --- | --- |
| `POST /api/uploads` | Check the current user's hash or create a staging upload ticket |
| `POST /api/uploads/{uploadId}/renew` | Renew scoped URLs for an owned upload |
| `POST /api/uploads/{uploadId}/complete` | Verify and finalize uploaded media |
| `GET /api/media?cursor=...` | Page through the current user's finalized media |
| `GET /api/usage` | Read shared instance used/reserved/available bytes and its quota |

The phone hashes the original bytes, stages deterministic blocks directly to
Azure using SAS, commits the block list, uploads its JPEG thumbnail, and asks the
API to finalize the item. Google tokens go only to the API, never to SAS URLs.
The server independently verifies the file rather than trusting the supplied hash.

## Device acceptance checks

Native sign-in and real Azure access require your cloud configuration and must be
tested on a device or emulator:

1. Sign in and upload a small photo and a video. Refresh the gallery and check
   both thumbnails.
2. Select the same file again, including a renamed copy. Confirm it is skipped
   rather than stored twice. An edited file should be a new backup.
3. Interrupt connectivity during a multi-block video upload, reconnect, and
   retry. Confirm progress resumes and the final file matches the original.
4. With cellular uploads disabled, confirm backup waits for Wi-Fi. Explicitly
   enable cellular uploads and verify the changed policy.
5. Deny photo permission, then grant limited permission. Confirm the app explains
   the restriction and Sync All only includes accessible media.
6. Tap Sync all, wait for scanning to finish, then switch apps and lock the
   screen during a multi-block video. Confirm the Android notification remains
   visible and iOS URLSession transfers continue when the OS permits. Reopen and
   check completion appears without re-uploading acknowledged blocks.
7. Sign out mid-upload, sign in as a second Google account, and confirm neither
   the queue nor gallery exposes the first account's media.
8. Verify unauthenticated API requests are rejected, direct unsigned blob URLs
   fail, and expired SAS URLs no longer work.
9. While backgrounded, switch from Wi-Fi to cellular with mobile data disabled;
   verify transfers wait. Enable cellular in the app, then disable it mid-upload
   and verify the native worker stops using cellular immediately.
10. Stop the Android notification/service or force-quit the iOS app. Reopen and
    use Resume backup/Retry; verify checkpoints survive without false completion.
    Exercise Android's data-sync service timeout and iOS processing expiration.
11. Keep a background transfer pending past SAS expiry and past Google ID-token
    expiry. Check that SAS renewal works, expired sign-in pauses visibly, and
    reopening/Retry refreshes credentials. Confirm quota errors pause the queue.
12. Enable auto-sync, add a photo while the app is active, and check it is queued.
    Photos added while closed must not be advertised as continuously discovered.
    Test denied notification permission, limited Photos access, low disk space,
    and cancellation/sign-out while native preparation is in progress.
13. Confirm the deployed API's create/renew/complete routes and direct Azure
    endpoints never return redirects, including expired-auth and error paths.
    Use only disposable data and credentials when exercising redirect behavior.
14. Back up several large originals while the app is backgrounded and confirm
    completed native staging is released. Fail one upload after preparation:
    remaining work must pause until Retry or Cancel. With an earlier preparation
    failure also queued, Retry failed uploads must finish the retained snapshot
    before allocating another original. Repeat with Android network backoff.

## Deployment and operation

- Build the API before publishing with Azure Functions Core Tools, and configure
  its environment values as Function App settings. Do not publish local credential
  files. Set `AzureWebJobsStorage__credential=managedidentity` in Azure, alongside
  `AzureWebJobsStorage__accountName`; keep the local developer configuration
  using `az login`. From `api/`, publish with
  `npm run build` followed by `func azure functionapp publish YOUR_FUNCTION_APP`.
- Deploy the native app with your own bundle/package identifiers and registered
  signing certificates. OAuth client IDs and API URLs are public configuration.
- Back up test files, confirm gallery access, and test sign-out/account switching
  before trusting the app with irreplaceable media.
- Staging uploads and snapshots consume storage even when a client abandons an
  upload. `api/lifecycle-policy.json` is an example two-day cleanup policy for
  `media/staging/`, beyond the 24-hour ticket window. Adjust its container prefix
  if you rename `media`, and merge it with existing policies rather than replacing
  unrelated rules. Never apply staging deletion rules to finalized media.
- Ticket metadata under `tickets/` is retained for idempotent completion retries.
  If you add ticket retention rules, old completion IDs will eventually return
  404; clients must start a new upload/deduplication check.
- Review retention, cloud deletion/export, account deletion, abuse controls,
  monitoring, and privacy disclosures before a public launch. This MVP is not a
  replacement for a second independent backup.

## Known limitations

- Auto-sync discovers new media only while the app is active. Already queued
  backups can continue natively, subject to OS scheduling, service time limits,
  connectivity, local media availability, and credential expiry.
- Media stored only in iCloud or otherwise inaccessible on-device may need to be
  downloaded first. Limited photo-library permission only exposes allowed items.
- Preparation and foreground-only uploads require the local original to remain
  available. Native uploads resume from their retained private snapshot. If that
  snapshot is missing or damaged, cancel and select the original again; native
  workers do not silently replace it with potentially edited device media.
- Originals are limited to 2 GiB and generated JPEG thumbnails to 1 MiB. Upload
  tickets can be renewed for 24 hours; individual SAS URLs last at most 15 minutes.
  Large-file finalization also depends on Azure throughput and HTTP timeouts;
  retry an interrupted finalization rather than assuming the backup succeeded.
- Short-lived gallery links need refreshing after expiry.
- Cloud deletion/export, account recovery UX, and production abuse/rate limits
  are not part of the first milestone.