[Syncachu](../README.md) / [Documentation](README.md) / Storage and quota

# Storage and quota

Syncachu reserves capacity before issuing upload URLs and charges each finalized
per-user original and its selected thumbnail once. Azure Table Storage provides
atomic accounting across approved accounts and scaled API instances.

**On this page:** [Limits](#limits-at-a-glance) |
[Initialization](#initialize-or-import-a-library) |
[Reservations](#reservations-and-finalization) | [Cleanup](#cleanup-and-retention) |
[Costs](#cost-and-recovery-boundaries)

## Limits at a glance

| Setting or limit | Current value |
| --- | --- |
| Default `STORAGE_QUOTA_BYTES` | **1,000,000,000,000 bytes** (1 decimal TB), shared across the entire instance. |
| Original size | Up to 2 GiB per file. |
| Generated JPEG thumbnail | Up to 1 MiB. |
| Upload ticket renewal window | 24 hours. |
| Individual SAS lifetime | At most 15 minutes. |
| Unpublished reservation lifetime | 24 hours. |
| Reservation-expiry timer | Every 15 minutes. |
| Example staging cleanup | After 2 days, beyond the ticket window. |

The app displays used, reserved, and available capacity. Approved users can see
aggregate instance usage but cannot browse another account's media.

> [!WARNING]
> This is a **logical media quota**, not a storage-account or spending cap.
> Staging, snapshots, versions, soft-deleted files, orphaned copies, metadata, and
> logs can consume additional storage. Blob SAS grants cannot constrain PUT payload
> size; uploaded content is checked at finalization.

## Initialize or import a library

Create the private media container and quota table first. The table must be in
the same media account. Before first API start, initialize accounting even for an
empty installation.

For an existing library, stop every old API or other catalog writer and wait for
in-flight completions to finish. No writer may modify the catalog during import.
The [deployment runbook](../infra/README.md#2-initialize-the-global-quota-before-first-api-start)
covers the hosted cutover, temporary operator roles, and readiness gate.

The initializer needs **Storage Blob Data Reader** on the media container/account
and **Storage Table Data Contributor** on the quota table or media account.
Use the developer identity from `az login`, not a production `AZURE_CLIENT_ID`.

From the repository root, in PowerShell after installing API dependencies:

```powershell
az login
$env:AZURE_STORAGE_ACCOUNT_URL = "https://YOUR_ACCOUNT.blob.core.windows.net"
$env:AZURE_STORAGE_CONTAINER = "media"
$env:AZURE_QUOTA_TABLE = "syncachuquota"
$env:STORAGE_QUOTA_BYTES = "1000000000000"
Remove-Item Env:AZURE_CLIENT_ID -ErrorAction SilentlyContinue
Set-Location .\api
npm run quota:init
```

Use a clean shell without unrelated `AZURE_CLIENT_SECRET` or workload identity
credentials. The command reads **shell environment variables, not
`local.settings.json`**. Keep these values consistent with the API configuration.

The initializer reads all finalized catalog records and their actual blob sizes,
including thumbnails, before marking accounting ready. Interrupted imports can
be retried without double counting while writers remain stopped. A ready ledger
is never reset by rerunning the command.

Existing libraries above the limit remain accounted for but cannot add uploads
until sufficient capacity is available. Missing or incomplete initialization
blocks new uploads and the usage endpoint with HTTP 503. Do not start or deploy
the API after a failed import, create a zero ledger over existing media, or restart
legacy code that can make unaccounted writes.

## Reservations and finalization

Upload reservations include the declared original size plus up to 1 MiB for a
thumbnail. Completion replaces the reservation with actual finalized bytes.
Unpublished reservations expire after 24 hours and are reclaimed by the timer;
cancelling a local queue item does **not** immediately release its server reservation.

Once verified media starts publication, its reservation does not expire unless
the canonical media has already been charged. Retry interrupted completion rather
than deleting ledger rows: the original may already exist. Unresolved publication
failures require administrator investigation.

Large-file finalization also depends on Azure throughput and HTTP timeouts.
Retry an interrupted finalization rather than assuming the backup succeeded.
The app pauses further uploads on a quota error; use **Retry** once space or the
configured limit is available. Cloud deletion is not currently exposed by the app.

## Cleanup and retention

[`api/lifecycle-policy.json`](../api/lifecycle-policy.json) is an example two-day
cleanup policy for `media/staging/`. Staging uploads and snapshots consume storage
even when a client abandons an upload.

Adjust the container prefix if you rename `media`, and merge the example with
existing policies rather than replacing unrelated rules. **Never apply staging
deletion rules to finalized media.**

Ticket metadata under `tickets/` is retained for idempotent completion retries.
If you add ticket retention rules, old completion IDs eventually return 404;
clients must start a new upload/deduplication check.

The Bicep deployment configures seven-day blob and container soft deletion,
disables versioning, and keeps media-account defaults Hot. The API promotes new
originals to Cool and thumbnails to Hot. Review retention and tiering costs
before changing these policies.

## Cost and recovery boundaries

Keep the beta allowlist small, apply staging cleanup, and configure Azure budgets
and alerts. Lifecycle deletion is asynchronous, and soft-deleted staging remains
billable through its retention period. Compute, transactions, bandwidth/egress,
telemetry, and host deployment packages also incur costs outside the media quota.

Zone-redundant storage protects against a zone failure, not every account deletion
or logical error. Soft deletion is not an independent backup, and the quota table
does not have equivalent blob soft-delete protection. Protect operator access
and maintain an independent backup/export plan.

See the deployment runbook's
[cost and recovery boundaries](../infra/README.md#cost-recovery-and-validation-boundaries)
for infrastructure-specific operational guidance.

---

[Documentation index](README.md) | [Architecture](architecture.md) |
[Deployment runbook](../infra/README.md)
