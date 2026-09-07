[Syncachu](../README.md) / [Documentation](README.md) / Security model

# Security model

Syncachu uses Google identity, server-enforced account isolation, and private
Azure storage. This guide describes the implementation's trust boundaries and
operator responsibilities; it is not a claim of independent security certification.

**On this page:** [Identity](#identity-and-access) | [Storage](#storage-and-upload-grants) |
[Device credentials](#device-credentials-and-sign-out) |
[iOS redirects](#ios-background-redirects) | [Privacy](#privacy-and-encryption)

> [!IMPORTANT]
> **Private does not mean end-to-end encrypted or privately networked.** Azure
> encrypts data at rest and HTTPS protects transit, but the backend and authorized
> Azure administrators can read files. Hosted API and storage endpoints remain
> Internet-reachable for mobile clients.

## Identity and access

- The API verifies Google ID tokens, including issuer, audience, expiry, and any
  authorized-party (`azp`) claim. Configure only OAuth client IDs belonging to
  your application; wildcards are not accepted.
- `ALLOWED_GOOGLE_EMAILS` is a server-side private-beta allowlist. Missing or empty
  configuration fails closed; tokens must contain a matching verified email.
  Changing the allowlist requires restarting or redeploying the Function App.
- Each Google account has a separate server-derived storage namespace.
  Deduplication is per user, and one approved account cannot browse another's media.
- The quota is instance-wide, not per-account. Approved users can see aggregate
  instance usage, but not another account's media.

## Storage and upload grants

The API uses Azure credentials on the server, preferably managed identity.
The deployment runbook defines [scoped roles](../infra/README.md#resources-and-access)
for runtime, package deployment, and GitHub OIDC identities.

**Never put Azure storage keys, service-account credentials, or OAuth client
secrets in the mobile app.** Expo public environment variables are bundled into
the application and are not secret.

Upload URLs are short-lived, HTTPS-only, blob-scoped SAS grants for staging
objects. They do not grant container-wide access or write access to finalized
media. Completion verifies the original file's actual SHA-256 and size against
an immutable upload snapshot before publishing it.

Originals and thumbnails remain private. Gallery URLs are temporary bearer
credentials: do not log, share, or send them to analytics. Individual SAS URLs
last at most 15 minutes; an upload ticket can be renewed within its 24-hour window.
Never enable anonymous storage access to bypass an authentication failure.

## Device credentials and sign-out

Background workers use the same scoped SAS grants and authenticated API, not
storage keys or a new long-lived server credential.

| Platform | Google ID-token handling |
| --- | --- |
| Android | The native worker keeps its ID token in memory. |
| iOS | The current ID token is retained in device-only Keychain storage for OS relaunch; sign-out removes it. |

When authentication expires, reopen the app and tap **Retry** to refresh
credentials. Native staging snapshots and native queue state stay in app-owned
storage and are excluded from OS device backups.

Signing out stops client work, including native requests, but previously issued
SAS URLs remain valid until they expire. Removing a tester from the allowlist
blocks future authenticated API access, not already-issued SAS grants.
Cancellation and sign-out do not delete device-library originals.

## iOS background redirects

> [!WARNING]
> **iOS background transfers follow HTTP redirects automatically.** Unlike the
> foreground uploader and Android worker, Apple's background URLSession cannot
> refuse a redirect before sending the redirected request.

Initial destinations are validated and observed redirected results are rejected,
but that cannot undo transmission. Configure direct, trusted HTTPS API and Azure
Blob endpoints that **never redirect**, including authentication failures and
other error responses.

Do not put login pages, URL shorteners, canonical-host redirects, or redirecting
proxies in front of these endpoints. This is an explicit platform tradeoff, not
a guarantee that every iOS request remains on its initially validated host.
See Apple's [background-session redirect behavior](https://developer.apple.com/documentation/foundation/urlsessiontaskdelegate/urlsession(_:task:willperformhttpredirection:newrequest:completionhandler:)).

Use only disposable data and credentials when exercising redirect behavior.
The [device acceptance checklist](development.md#device-acceptance-checks) includes
endpoint validation before distribution.

## Privacy and encryption

Storage contains filenames, hashes, sizes, and backup timestamps. Originals may
retain embedded EXIF and location metadata. Keep tokens, SAS query strings,
filenames, and invitation lists out of logs.

Azure encrypts stored data and HTTPS protects transfers. Syncachu does **not**
provide end-to-end encryption: operators and authorized Azure administrators
remain inside the trust boundary.

Before a public launch, review retention, cloud deletion/export, account
deletion, abuse controls, monitoring, and privacy disclosures. These are not all
implemented in the private beta. Soft deletion and zone-redundant storage do not
replace a second independent backup.

---

[Documentation index](README.md) | [Background backup](background-backup.md) |
[Deployment runbook](../infra/README.md)
