[Syncachu](../README.md) / [Documentation](README.md) / Getting started

# Getting started

Set up a development API and a native Android or iOS build. Dependencies are
installed separately in `api` and `mobile`; there is no root package to install.
The API uses real Azure storage, so start with a dedicated development account
and disposable test media.

**On this page:** [Prerequisites](#prerequisites) |
[Azure resources](#prepare-azure-resources) | [Google sign-in](#configure-google-sign-in) |
[API](#run-the-api) | [Mobile app](#run-the-mobile-app) | [First backup](#make-your-first-backup)

> [!TIP]
> For reproducible Azure provisioning and invited-tester distribution, use the
> [deployment runbook](../infra/README.md). The steps here focus on local development.

## Prerequisites

| Requirement | Notes |
| --- | --- |
| Node.js 22 and npm | Required for both packages. |
| Azure subscription and Azure CLI | Sign in with a developer identity that has the required storage data roles. |
| Azure Functions Core Tools v4 | Runs the API locally. |
| Google Cloud project | Configure OAuth consent and add test users if the consent screen is in testing mode. |
| Android Studio or Xcode | Required for native development builds; iOS builds require macOS and Xcode. |

Native Google sign-in requires a development build. **Expo Go is not supported.**
The application is not configured for browser sign-in or web backup.

## Prepare Azure resources

The [Bicep runbook](../infra/README.md#1-prepare-and-provision) is the supported
path for a complete hosted installation. For local API development, prepare:

1. A **StorageV2 media account** requiring HTTPS and TLS 1.2 or newer, with
   anonymous blob access and shared-key access disabled. Create a private `media`
   container using an Entra-authenticated identity. Do not enable a static website
   or public container access.
2. A **`syncachuquota` table in the same media account**. The API expects the table
   to exist; it does not provision it.
3. A **separate Functions host storage account**, configured for identity-based
   access according to Azure's hosting requirements.

Grant your developer identity these data-plane roles, then run `az login`:

| Scope | Role | Purpose |
| --- | --- | --- |
| Media storage account | Storage Blob Data Contributor | Media operations and user-delegation keys; container scope alone cannot issue keys. |
| Quota table, or media account | Storage Table Data Contributor | Quota initialization and atomic reservations. |
| Host storage account | Storage Blob Data Owner | Identity-based Functions host storage. |

The initializer needs Blob Data Reader on the media container/account plus
Table Data Contributor; the developer's media Blob Data Contributor role also
covers reading. Additional host roles depend on hosting and extensions; consult
Microsoft's [identity-based host storage guidance](https://learn.microsoft.com/azure/azure-functions/functions-reference#connecting-to-host-storage-with-an-identity).
The [deployment role matrix](../infra/README.md#resources-and-access) describes
the hosted runtime and deployment identities.

Allow time for RBAC propagation. The API uses `DefaultAzureCredential` locally;
hosted deployments should use managed identity. Keep the media account's default
tier Hot: the API explicitly promotes new originals to Cool and thumbnails to Hot.
Native clients do not need Blob CORS rules.

> [!WARNING]
> Do not enable anonymous storage access or shared keys to work around permission
> errors. Keep host storage and private media storage separate.

## Configure Google sign-in

1. Configure the Google OAuth consent screen and create a **Web application**
   OAuth client. Its client ID is the server audience used by native Google
   sign-in, not a client secret.
2. Create an **Android** OAuth client for the actual application package name and
   development signing certificate SHA-1. Register release/Play signing
   certificates separately before distribution.
3. Create an **iOS** OAuth client for the actual bundle identifier. Configure its
   client ID and reversed-client-ID URL scheme in the mobile environment.
4. Set the API's `GOOGLE_CLIENT_IDS` to the app's Web, Android, and iOS client IDs.
   The verifier checks token audiences and any authorized-party (`azp`) claim,
   so native client IDs must also be allowed. Do not use wildcards.
5. Add invited, verified email addresses to the server's `ALLOWED_GOOGLE_EMAILS`.
   Google OAuth test-user access does not replace this API allowlist.

Rebuild the native app after changing package identifiers, URL schemes, or native
sign-in plugin configuration. No Google OAuth client secret belongs in the app.

## Run the API

The commands below use **PowerShell**, starting from the repository root.
Replace example values in the copied file before continuing.

```powershell
Set-Location .\api
npm ci
Copy-Item .\local.settings.example.json .\local.settings.json
```

Configure the `Values` object in `api/local.settings.json`:

| Setting | Value |
| --- | --- |
| `GOOGLE_CLIENT_IDS` | Comma-separated Web/native Google client IDs accepted as audiences or authorized parties. |
| `ALLOWED_GOOGLE_EMAILS` | Comma-separated approved verified Google emails; no wildcards. |
| `AZURE_STORAGE_ACCOUNT_URL` | `https://YOUR_ACCOUNT.blob.core.windows.net` |
| `AZURE_STORAGE_CONTAINER` | Private media container name, normally `media`. |
| `AZURE_QUOTA_TABLE` | Existing Table Storage quota table, normally `syncachuquota`. |
| `STORAGE_QUOTA_BYTES` | Total instance limit in bytes; default `1000000000000` (decimal 1 TB). |
| `AzureWebJobsStorage__accountName` | The separate Functions host storage account name. |

Keep the supplied runtime settings and replace all placeholders.
[`api/.env.example`](../api/.env.example) lists deployment settings, but Azure
Functions does **not** load it automatically. Keep `local.settings.json` local.

**Before first startup, [initialize quota accounting](storage-and-quota.md#initialize-or-import-a-library).**
That administrative command reads shell environment variables, not
`local.settings.json`. Missing or incomplete initialization blocks uploads and
usage reporting with HTTP 503.

After successful initialization, from `api`:

```powershell
npm start
```

This builds TypeScript and starts the Functions host. A mobile device needs a
reachable, trusted **HTTPS** API endpoint, such as your deployed API or a
nonredirecting HTTPS development endpoint. A physical device cannot reach your
computer through `localhost`; do not disable TLS validation to work around this.

## Run the mobile app

Open a second terminal at the repository root:

```powershell
Set-Location .\mobile
npm ci
Copy-Item .\.env.example .\.env
```

Configure `mobile/.env`:

| Setting | Value |
| --- | --- |
| `EXPO_PUBLIC_API_URL` | Reachable HTTPS API URL, ending in `/api`. |
| `EXPO_PUBLIC_AZURE_BLOB_HOST` | Media storage hostname, without `https://`. |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | Google Web OAuth client ID. |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | Google iOS OAuth client ID. |
| `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME` | Reversed iOS client ID from Google. |
| `EXPO_PUBLIC_APP_ID` | Android package name and iOS bundle identifier. |

These values are bundled into the application and are **public configuration**.
Never put storage keys, OAuth client secrets, tokens, or SAS URLs in this file.
The app validates initial upload/gallery URLs against the configured storage
hostname; review the [iOS redirect limitation](security.md#ios-background-redirects)
before choosing API and storage endpoints.

Create and launch the native development build for your platform:

```powershell
npm run android
# Or, on macOS with Xcode:
npm run ios
```

Use `npm start` in `mobile` for subsequent Metro development sessions.
Rebuild and reinstall after changing native configuration or the local
background-backup module; a JavaScript update alone cannot install native services.

## Make your first backup

1. Sign in with an approved Google account and grant access to the media you want
   to back up. Limited photo permissions expose only the items you allow.
2. On Wi-Fi, use **Choose files** to upload a small photo and a video.
3. Refresh the gallery and confirm both items appear with thumbnails. Upload the
   same original again to confirm per-account deduplication.
4. Try **Sync all**, keeping the app open until scanning finishes. Already-queued
   work can then continue according to the [background backup rules](background-backup.md).

For repeatable release validation, follow the
[device acceptance checklist](development.md#device-acceptance-checks), not just
this first-backup walkthrough.

---

[Documentation index](README.md) | [Architecture](architecture.md) |
[Deploy a private instance](../infra/README.md)
