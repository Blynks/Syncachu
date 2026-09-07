[Syncachu](../README.md) / [Documentation](../docs/README.md) / Deployment runbook

# Deployment runbook

Provision an invite-only Syncachu instance on Azure Functions **Flex Consumption,
Node.js 22**, then distribute internal Android and iOS builds. This runbook is for
authorized operators managing their own Azure, Google, GitHub, and Expo projects.

Provisioning, quota initialization, and identity setup are explicit operator
actions. Cloning the repository or pushing code does not provision resources or
trigger a deployment.

> [!IMPORTANT]
> **Private means authenticated and invite-only, not private networking.** The API
> and storage HTTPS endpoints remain Internet-reachable for phones and
> GitHub-hosted runners. Containers forbid anonymous reads; clients receive
> short-lived, blob-scoped user-delegation SAS URLs. Do not turn off public network
> access without designing the corresponding VNet, DNS, runner, and mobile connectivity.

## Deployment path

Complete these stages in order for a new installation. Later code deployments
reuse the initialized ledger and existing identity configuration.

| Stage | Action | Ready to continue when... |
| --- | --- | --- |
| 1 | [Prepare and provision](#1-prepare-and-provision) | The reviewed Bicep deployment succeeds and scoped roles have propagated. |
| 2 | [Initialize quota](#2-initialize-the-global-quota-before-first-api-start) | The initializer succeeds with no legacy catalog writers running. |
| 3 | [Configure GitHub OIDC](#3-bootstrap-protected-github-oidc-once) | The protected `azure-dev` environment and separate deployment identity are configured. |
| 4 | [Deploy the API](#4-deploy-the-api-manually) | The manually approved deployment and authenticated live acceptance checks succeed. |
| 5 | [Distribute native builds](#5-distribute-only-internal-native-builds) | Android/iOS native builds and device acceptance pass, and internal build links are restricted. |

**Reference:** [Resources and access](#resources-and-access) |
[Cost and recovery](#cost-recovery-and-validation-boundaries) |
[Release checklist](#release-checklist) | [Upstream documentation](#references)

| Repository reference | Purpose |
| --- | --- |
| [`main.bicep`](main.bicep) | Resource-group-scoped Azure provisioning. |
| [`private-beta.bicepparam`](private-beta.bicepparam) | Environment-driven provisioning parameters. |
| [`deploy-azure-dev.yml`](../.github/workflows/deploy-azure-dev.yml) | Manually triggered API build and protected OIDC deployment. |
| [`mobile/eas.json`](../mobile/eas.json) | Internal native build profile. |

For local development rather than hosted deployment, see
[Getting started](../docs/getting-started.md).

## Resources and access

`main.bicep` targets an existing resource group in Azure public cloud:

| Resource | Default |
| --- | --- |
| Functions plan | Linux Flex `FC1`; Node `22`; zero always-ready instances; 2,048 MB; HTTP concurrency 4 per instance |
| Scale ceiling | 40 instances, this template's minimum/default ceiling; regional platform limits may differ. Not 40 running/reserved instances |
| Host/deployment storage | Dedicated `StorageV2`, Hot, `Standard_LRS`; not the media account |
| Media storage | Separate `StorageV2`, Hot, `Standard_ZRS`; private `media` container and `syncachuquota` table in the same account |
| Media recovery | Blob and container soft deletion for 7 days; versioning disabled |
| Staging cleanup | Only `<media-container>/staging/` blobs, snapshots, and versions older than 2 days, matching `api/lifecycle-policy.json` |
| Monitoring | Workspace-based Application Insights; 30-day Log Analytics retention; best-effort 1 GB/day ingestion cap; Entra-authenticated ingestion |

Both accounts require HTTPS and TLS 1.2+, disable anonymous blob access and shared
keys, and default the portal to Entra authorization. The app requires HTTPS/TLS
1.2+ on both app and SCM endpoints, disables FTP and basic publishing credentials,
and has no publish profile, connection-string keys, or `listKeys` calls.

Managed identities are created before the app and its role assignments:

| Identity | Role and scope | Purpose |
| --- | --- | --- |
| `<app>-runtime` | Storage Blob Data Owner on **host account** | Host secrets and timer singleton/lease storage |
| `<app>-runtime` | Storage Table Data Contributor on **host account** | Host diagnostic-event tables, separate from the quota table |
| `<app>-runtime` | Storage Blob Data Contributor on **media account** | Media operations and user-delegation keys; container scope alone cannot issue these keys |
| `<app>-runtime` | Storage Table Data Contributor on **quota table** | Atomic global quota ledger; table is provisioned by Bicep, not created by runtime |
| `<app>-runtime` | Monitoring Metrics Publisher on **Application Insights** | Entra-authenticated host telemetry |
| `<app>-packages` | Storage Blob Data Contributor on **host `function-releases` container** | Flex deployment service reads/writes deployment packages using this separate identity |
| GitHub OIDC identity, created separately | Website Contributor on **Function App only** | OneDeploy and app start; no infrastructure deployment, RBAC administration, or direct media access |

The runtime identity's host-account Blob Data Owner also covers the package
container; the separate package identity itself has no media access. HTTP and
timer triggers do not require host Queue Data Contributor or Storage Account
Contributor. Revisit roles when adding Blob/Queue/Durable bindings rather than
granting subscription-wide roles preemptively. Allow at least several minutes for
RBAC propagation; troubleshoot 403s rather than re-enabling shared keys.

### Runtime and package authentication

Host authentication uses `AzureWebJobsStorage__accountName`, `__credential`
(`managedidentity`), and `__clientId`. `AZURE_CLIENT_ID` selects the runtime
user-assigned identity for the API's Azure SDK clients. Package authentication is
configured in `functionAppConfig.deployment.storage`, **not** a SAS URL or
`WEBSITE_RUN_FROM_PACKAGE`. Flex has no Azure Files dependency. Runtime version and
scaling live in `functionAppConfig`; do not add legacy Consumption settings such
as `FUNCTIONS_WORKER_RUNTIME`, `WEBSITE_NODE_DEFAULT_VERSION`, or remote-build flags.

## 1. Prepare and provision

Use Node.js 22 and a current Azure CLI with Bicep available. The parameter example
uses Bicep's `readEnvironmentVariable`; use Bicep 0.31+ and Azure CLI 2.61+.
Run commands below from the repository root in PowerShell. They are instructions
for an authorized operator, not an automatically executed deployment.

Choose distinct globally unique app and storage names. The app name is limited
to 58 characters to leave room for the log workspace suffix. Storage names must
contain 3-24 lowercase letters/digits. Resource names must remain stable on redeployment.
Choose a region supporting **both** Flex Node 22 and media ZRS; check subscription
quota and availability before spending money:

```powershell
az login
az account set --subscription "<subscription-id>"
az functionapp list-flexconsumption-locations --output table
az functionapp list-flexconsumption-runtimes --location "<region>" --runtime node --output table
```

The provisioning identity needs resource creation permissions in the group and
permission to assign the scoped roles above (for example, Contributor plus Role
Based Access Control Administrator at the resource group). Do not give these roles
to the GitHub deployment identity. An administrator may need to register
`Microsoft.Web`, `Microsoft.Storage`, `Microsoft.ManagedIdentity`,
`Microsoft.OperationalInsights`, and `Microsoft.Insights` resource providers.

Set local environment values; these are examples, not deployable credentials:

```powershell
$env:AZURE_LOCATION = "<supported-region>"
$env:AZURE_RESOURCE_GROUP = "<private-beta-resource-group>"
$env:AZURE_FUNCTIONAPP_NAME = "<globally-unique-function-app>"
$env:AZURE_HOST_STORAGE_ACCOUNT_NAME = "<uniquehoststorage>"
$env:AZURE_MEDIA_STORAGE_ACCOUNT_NAME = "<uniquemediastorage>"
$env:GOOGLE_CLIENT_IDS = "<web-client-id>,<android-client-id>,<ios-client-id>"
$env:ALLOWED_GOOGLE_EMAILS = "<invited-verified-email>,<another-invited-email>"
$env:AZURE_STORAGE_CONTAINER = "media"
$env:AZURE_QUOTA_TABLE = "syncachuquota"
$env:STORAGE_QUOTA_BYTES = "1000000000000"
```

`GOOGLE_CLIENT_IDS` must list explicit OAuth audiences/authorized-party IDs, with
no wildcard. The API requires a verified email matching `ALLOWED_GOOGLE_EMAILS`;
an empty list denies everyone. The allowlist is a secure Bicep parameter, not a
secret in a mobile build; do not commit real addresses or persist compiled
parameter JSON containing them. Restrict Google OAuth test users too.

For a new installation:

```powershell
az bicep build --file .\infra\main.bicep --outfile "$env:TEMP\syncachu-main.json"
az group create --name $env:AZURE_RESOURCE_GROUP --location $env:AZURE_LOCATION
az deployment group what-if --resource-group $env:AZURE_RESOURCE_GROUP --template-file .\infra\main.bicep --parameters .\infra\private-beta.bicepparam
az deployment group create --name syncachu-private-beta --resource-group $env:AZURE_RESOURCE_GROUP --template-file .\infra\main.bicep --parameters .\infra\private-beta.bicepparam
```

Review the what-if output first. Provisioning creates an **empty app**, storage,
and quota table, but does **not** initialize the ledger or publish API code.
Only continue when each command succeeds. Remove the temporary compiled template
afterward; do not save compiled parameter files or authentication material in Git.

### Existing installations

> [!WARNING]
> Do not blindly apply this new-install template over arbitrary resources, or
> replace an existing media account to make a deployment error disappear.

First stop every old API/other writer and wait for in-flight
finalizations to finish or terminate, then inspect/adapt the template and what-if.
Keep the existing media account/container and finalized records. The template
owns the full app settings and media lifecycle policy: merge any existing unrelated
rules/settings into the template before applying it. Review replication, retention,
and versioning changes; converting an existing account to ZRS may require a
separate supported migration. Never replace the media account to make a deployment
error disappear. Leave old writers stopped throughout import and cutover.

## 2. Initialize the global quota before first API start

The quota is **1,000,000,000,000 bytes (1 decimal TB) total across all users and
all scaled instances**, not 1 TB per account or process. Finalized originals and
their selected thumbnails plus active reservations count against this logical
limit. The quota table must be in the **same media account**.

After provisioning, and before the first code deployment/start, run the
administrative initializer from the quota-enabled API revision. For an existing
installation, first stop the old app (and any other API deployment sharing media):

```powershell
az functionapp stop --resource-group $env:AZURE_RESOURCE_GROUP --name $env:AZURE_FUNCTIONAPP_NAME
```

Stopping the app cannot revoke already-issued staging SAS URLs. Wait out outstanding
requests and ensure no old process can finalize media during import. Do not restart
old code after initialization: it can create unaccounted writes.

An administrator grants the initializer's signed-in developer identity **Storage
Blob Data Reader** on the media account and **Storage Table Data Contributor** on
the quota table (media-account scope also works). These are data-plane permissions;
Azure Contributor alone is insufficient. Grant them temporarily and remove them
after import. The initializer does not need host/deployment permissions or an OAuth
client secret.

```powershell
$env:AZURE_STORAGE_ACCOUNT_URL = "https://$($env:AZURE_MEDIA_STORAGE_ACCOUNT_NAME).blob.core.windows.net"
# Use the developer identity from az login, not the app's user-assigned identity.
Remove-Item Env:AZURE_CLIENT_ID -ErrorAction SilentlyContinue
Set-Location .\api
npm ci
npm run quota:init
Set-Location ..
```

Keep `AZURE_STORAGE_CONTAINER`, `AZURE_QUOTA_TABLE`, and `STORAGE_QUOTA_BYTES`
consistent with the provisioning values. The CLI does not need Google settings;
it uses `DefaultAzureCredential` and the developer's Azure CLI login. Use a clean
shell without unrelated `AZURE_CLIENT_SECRET`/workload identity credentials.

The initializer scans existing finalized index records, counts original plus
thumbnail bytes, and initializes the ledger. On an empty installation it initializes
a zero baseline. It is idempotent; interrupted/failed imports leave quota blocked
and can be retried while writers remain stopped. A ready ledger is left unchanged.
Before initialization the quota-enabled API returns 503 rather than accepting uploads.

> [!WARNING]
> Do not deploy/start on failure, manually create a zero ledger over existing
> media, or treat a rerun as a repair of writes made after initialization.

The protected workflow's readiness checkbox is an operator attestation, not an
automated ledger inspection; the workflow has no media-data role. Record the
successful initializer output in your private operational record. Later normal
deployments reuse the initialized ledger without re-importing it.

Ordinary upload reservations last 24 hours; a timer checks expiration every 15
minutes. Reservations already publishing media are conservatively retained after
an interrupted finalization. Retry completion before abandoning a failed
publication; do not manually delete ledger entries to reclaim that capacity.
See [storage and quota](../docs/storage-and-quota.md) for file limits, accounting
semantics, and cleanup guidance.

## 3. Bootstrap protected GitHub OIDC once

Create the GitHub environment **`azure-dev`** in `Blynks/Syncachu`, restrict its
deployment branches to **`main`**, and require an approving reviewer (prevent
self-review and protection bypass where available). Ensure your GitHub plan
supports these protections for this repository; if it does not, do not enable
deployment credentials until equivalent protection is in place. Also protect
`main` and review changes to workflows/infrastructure.

An Azure administrator creates a **separate** user-assigned managed identity for
GitHub federation. Do not reuse either app-attached identity:

```powershell
$oidcIdentityName = "<github-deploy-identity>"
az identity create --name $oidcIdentityName --resource-group $env:AZURE_RESOURCE_GROUP --location $env:AZURE_LOCATION
$oidcPrincipalId = az identity show --name $oidcIdentityName --resource-group $env:AZURE_RESOURCE_GROUP --query principalId --output tsv
$oidcClientId = az identity show --name $oidcIdentityName --resource-group $env:AZURE_RESOURCE_GROUP --query clientId --output tsv
$appResourceId = az functionapp show --name $env:AZURE_FUNCTIONAPP_NAME --resource-group $env:AZURE_RESOURCE_GROUP --query id --output tsv
az role assignment create --assignee-object-id $oidcPrincipalId --assignee-principal-type ServicePrincipal --role "Website Contributor" --scope $appResourceId
az identity federated-credential create --name github-azure-dev --identity-name $oidcIdentityName --resource-group $env:AZURE_RESOURCE_GROUP --issuer "https://token.actions.githubusercontent.com" --subject "repo:Blynks/Syncachu:environment:azure-dev" --audiences "api://AzureADTokenExchange"
```

The **exact environment subject** is essential: a branch-only federated credential
does not match jobs using a GitHub environment. Conversely, this environment
subject contains no branch restriction, so enforce `main` in environment protection
as well as in the workflow. Never use a wildcard repository/environment trust.

### GitHub environment variables

Set these GitHub **environment variables**, not checked-in files or publish-profile
secrets, on `azure-dev`:

| Variable | Value |
| --- | --- |
| `AZURE_CLIENT_ID` | `$oidcClientId`, the GitHub identity's client ID, **not** the runtime identity client ID |
| `AZURE_TENANT_ID` | Azure tenant/directory ID |
| `AZURE_SUBSCRIPTION_ID` | Target subscription ID |
| `AZURE_FUNCTIONAPP_NAME` | Provisioned app name |
| `AZURE_RESOURCE_GROUP` | Provisioned resource group |

The three IDs are identifiers, not client secrets. No plaintext Azure publish
profiles, storage keys, service-principal secrets, or mobile Google OAuth secrets
are needed.

## 4. Deploy the API manually

After initialization and RBAC propagation, run **Deploy private beta API** from
the Actions tab on `main`, confirm quota readiness, and approve the `azure-dev`
deployment. Pushes and pull requests never trigger this workflow.

The build job restores locked dependencies on Node 22, typechecks, runs API tests,
and compiles TypeScript. It assembles only `host.json`, package manifests, compiled
`dist/src`, and production dependencies; source tests, local settings, and `.env`
files are not shipped. The artifact lasts three days. Only the protected deployment
job receives `id-token: write`; it uses `azure/login` OIDC and the official
`Azure/functions-action` Flex **OneDeploy** path, then starts the quota-ready app.
Actions are pinned to verified upstream commit SHAs.

The artifact is built on Linux and includes its dependencies, so `remote-build`
is false. Do not set `SCM_DO_BUILD_DURING_DEPLOYMENT`, `ENABLE_ORYX_BUILD`,
`WEBSITE_RUN_FROM_PACKAGE`, slots, or publish-profile inputs. Flex deployment
package access uses the Bicep-configured package identity; GitHub does not upload
directly to media or run the administrator initializer.

After deployment, use an invited verified Google account to call `GET /api/usage`,
upload a small photo/video, and confirm the gallery. Verify missing/invalid tokens
and non-allowlisted users are rejected, and that unsigned blob URLs are denied.
Confirm timer-triggered reservation expiry and host telemetry work. A failure of
these live acceptance checks is a deployment blocker, not a reason to relax auth.
Roll back only to a quota/allowlist-compatible revision; never restart a legacy
writer as a rollback strategy.

## 5. Distribute only internal native builds

`mobile/eas.json` contains one `beta` profile: internal distribution, Android APK,
iOS physical-device ad-hoc signing with a standard paid Apple Developer account,
and no development client. There is no store/production submission profile.

Use an Expo project owned by your team. From `mobile`, authenticate with EAS CLI,
link/configure that project, and set its **preview** environment values:
`EXPO_PUBLIC_API_URL` (the Bicep `apiUrl` output), `EXPO_PUBLIC_AZURE_BLOB_HOST`
(media account hostname only), `EXPO_PUBLIC_APP_ID`, `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`,
`EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, and `EXPO_PUBLIC_GOOGLE_IOS_URL_SCHEME`.
These values ship in the app and are **public configuration**, never secrets.
Choose real application identifiers and register the EAS Android signing
certificate SHA-1 with Google OAuth; use the matching iOS bundle ID/client scheme.
Follow the [Google sign-in setup](../docs/getting-started.md#configure-google-sign-in)
before building.

Background backup also requires a new native binary: Expo autolinks the local
`mobile/modules/background-backup` module. The app config registers iOS background
processing and its bundle-specific task identifier; the Android module declares
its data-sync foreground service and notification permissions. An OTA JavaScript
update cannot add these native capabilities. Review
[background backup behavior](../docs/background-backup.md) and complete the
[device acceptance checks](../docs/development.md#device-acceptance-checks) on both
platforms before distributing.
Local JavaScript tests and bundle exports do not compile these Kotlin/Swift
workers; successful Android/iOS native builds are also required for release.

In particular, use the direct HTTPS API URL without login/canonical-host
redirect middleware and the configured Azure account's direct blob endpoint.
Apple's background URLSession automatically follows redirects; the client can
reject an observed redirected result but cannot prevent its transmission.
Nonredirecting endpoints, including auth/error responses, are a deployment
requirement for iOS background backup.

With EAS CLI 19.1+ available, run from `mobile`:

```powershell
eas device:create
eas build --platform android --profile beta
eas build --platform ios --profile beta
```

`eas device:create` enrolls each iOS tester's UDID. Select a standard Apple
Developer team for **ad hoc**, not an Enterprise team. New devices require a new
provisioning profile/build or re-signing; Apple device/year limits and approval
delays apply. Android testers install the APK directly after approving their
device's installation prompt. Neither path requires a public App Store/Play
release; do not run `eas submit`.

### Restrict build access

> [!WARNING]
> Internal build links are accessible to anyone with the link by default.

Before sharing, in Expo project settings disable **Unauthenticated access to
internal builds**, and authorize only the intended Expo accounts/team members.
Share links privately, not in public issues/releases. iOS ad-hoc registration
limits installation, not link disclosure. The backend verified-email allowlist
remains mandatory even for people who obtain a binary; removing a tester from
that list blocks future authenticated API requests, not already-issued SAS URLs.

## Cost, recovery, and validation boundaries

No always-ready instances avoids idle compute reservation, **not** all charges:
timer executions, storage, transactions, bandwidth/egress, and telemetry still
cost money. Configure Azure budgets and alerts separately. The 1 TB application
quota is **not a physical storage or billing cap**: staging, abandoned uploads,
snapshots/versions, soft-deleted data, quota metadata, and host packages are outside
the finalized-media budget. A Blob SAS cannot enforce a PUT payload's maximum
byte length. Lifecycle deletion is asynchronous; soft-deleted staging remains
billable through its retention period. Telemetry caps may overshoot and suppress
incident logs; they do not cap compute/storage/egress.

ZRS protects against a zone failure, not every account deletion or logical error.
Soft deletion is not an independent backup, and the quota table has no equivalent
blob soft-delete protection. Protect operator access, maintain an independent
backup/export plan, and do not delete/recreate the ledger to fix capacity errors.
Keep tokens, SAS query strings, filenames, and invitation lists out of logs.

Local Bicep compilation validates syntax/types only. It cannot establish regional
availability, permissions, RBAC propagation, Google OAuth/signing configuration,
actual deployment/start behavior, or native device installation. Those require an
authorized operator's what-if/provisioning and acceptance run. No live Azure
deployment or native distribution is implied by these files.

## Release checklist

- [ ] Quota initialization succeeded, and no legacy writer can bypass accounting.
- [ ] Google audiences, verified-email invitations, managed-identity roles, and
  protected GitHub environment settings match the intended instance.
- [ ] Authenticated upload/gallery/usage checks pass; unauthorized API access and
  unsigned blob access fail; reservation expiry and telemetry work.
- [ ] Direct API and Blob endpoints do not redirect, including auth/error paths.
- [ ] Both native builds pass the [device acceptance checks](../docs/development.md#device-acceptance-checks),
  and internal build access is limited to intended testers.
- [ ] Budgets, staging cleanup, recovery procedures, and an independent backup
  plan are in place before storing irreplaceable media.

## References

- [Flex creation, runtimes, and deployment storage](https://learn.microsoft.com/azure/azure-functions/flex-consumption-how-to)
- [Flex managed-identity Bicep reference sample](https://github.com/Azure/azure-quickstart-templates/tree/master/quickstarts/microsoft.web/function-app-flex-managed-identities)
- [Identity-based host connections and minimum roles](https://learn.microsoft.com/azure/azure-functions/manage-connections)
- [Microsoft.Web/sites 2024-04-01 schema](https://learn.microsoft.com/azure/templates/microsoft.web/2024-04-01/sites)
- [Azure Functions Action OIDC and Flex parameters](https://github.com/Azure/functions-action)
- [GitHub environment OIDC subject and protection](https://docs.github.com/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-azure)
- [EAS internal distribution, ad hoc signing, and private link access](https://docs.expo.dev/build/internal-distribution/)

---

[Documentation index](../docs/README.md) | [Security model](../docs/security.md) |
[Storage and quota](../docs/storage-and-quota.md)
