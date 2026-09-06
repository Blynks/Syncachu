# Syncachu

A private photo/video backup app for iOS and Android, built with Expo, TypeScript,
Azure Functions, and private Azure Blob Storage.

## MVP scope

The first milestone is **Google sign-in → manual upload → uploaded-media gallery**.
Sync All and optional auto-sync while the app is open share the same upload queue.
Uploads default to Wi-Fi only; cellular data requires explicit opt-in.

This is not a continuous background backup service. iOS and Android restrict
background work, and this MVP does not install a native background upload service.
Keep the app open during backup. Device-only media is never deleted.

## Layout

- `mobile/`: Expo application, network policy, and resumable upload queue.
- `api/`: authenticated Azure Functions API and private Blob Storage adapter.

## Security model

- The API verifies Google ID tokens, including issuer, audience, and expiry.
  Configure only the OAuth client IDs belonging to your application.
- There is no separate invitation list or per-account storage quota yet. Any
  Google user who can sign in to those OAuth clients can create backups. Keep
  OAuth access restricted to intended test users until you add production abuse
  controls and cost limits.
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
| `AZURE_STORAGE_ACCOUNT_URL` | `https://YOUR_ACCOUNT.blob.core.windows.net` |
| `AZURE_STORAGE_CONTAINER` | Private media container name, normally `media` |

Replace the placeholders in `local.settings.json`, including the separate host
storage account. The `api/.env.example` file lists settings for deployment, but
Azure Functions does not load it automatically. Keep `local.settings.json` local.
Run `az login`, then `npm start` to build and start the Functions host.

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

The app pins upload/gallery URLs to the configured storage hostname.
A physical device cannot reach your computer through `localhost`;
use a reachable, trusted HTTPS development endpoint or your deployed API.
Do not disable TLS validation. Run `npm run android` or `npm run ios` to create
and launch a native development build. Use `npm start` for subsequent Metro
development sessions. iOS native builds require macOS and Xcode.

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
network policy, upload block planning, and resuming/cancelling uploads. The mobile
build exports Android/iOS JavaScript bundles; it does not compile or test the
native Google sign-in SDK on a device.

## API flow

All media routes require a Google ID token in the HTTP `Authorization` header,
using the bearer authentication scheme.

| Route | Purpose |
| --- | --- |
| `POST /api/uploads` | Check the current user's hash or create a staging upload ticket |
| `POST /api/uploads/{uploadId}/renew` | Renew scoped URLs for an owned upload |
| `POST /api/uploads/{uploadId}/complete` | Verify and finalize uploaded media |
| `GET /api/media?cursor=...` | Page through the current user's finalized media |

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
6. Enable auto-sync, add a photo while the app is active, and check it uploads.
   Close the app and confirm the UI/documentation do not promise background work.
7. Sign out mid-upload, sign in as a second Google account, and confirm neither
   the queue nor gallery exposes the first account's media.
8. Verify unauthenticated API requests are rejected, direct unsigned blob URLs
   fail, and expired SAS URLs no longer work.

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

- Auto-sync runs only while the app is active, with permission and network-policy
  checks. Operating-system background scheduling is a later milestone.
- Media stored only in iCloud or otherwise inaccessible on-device may need to be
  downloaded first. Limited photo-library permission only exposes allowed items.
- Resuming requires the original local media to remain available. Expired staging
  data or a removed source file may require restarting that item.
- Originals are limited to 2 GiB and generated JPEG thumbnails to 1 MiB. Upload
  tickets can be renewed for 24 hours; individual SAS URLs last at most 15 minutes.
  Large-file finalization also depends on Azure throughput and HTTP timeouts;
  retry an interrupted finalization rather than assuming the backup succeeded.
- Short-lived gallery links need refreshing after expiry.
- Cloud deletion/export, account recovery UX, and production abuse/rate limits
  are not part of the first milestone.