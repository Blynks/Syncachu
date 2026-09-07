[Syncachu](../README.md) / [Documentation](README.md) / Development and release checks

# Development and release checks

Use the [getting-started guide](getting-started.md) to configure both packages.
This page describes the existing local commands and the native-device acceptance
work required before distributing a build.

**On this page:** [Commands](#package-commands) | [Coverage](#what-the-checks-cover) |
[Device acceptance](#device-acceptance-checks) | [Release handoff](#release-handoff)

## Package commands

Run the following in **each** package directory (`api` and `mobile`) after `npm ci`:

```powershell
npm run typecheck
npm test
npm run build
npm audit
```

There is no root workspace runner. Each package has its own manifest and lockfile.

| Command | `api` | `mobile` |
| --- | --- | --- |
| `npm start` | Build TypeScript and start the local Functions host. | Start Metro for a development client. |
| `npm run typecheck` | Check API and test TypeScript without emitting output. | Check app TypeScript without emitting output. |
| `npm test` | Build, then run Node's test runner against compiled tests. | Compile core modules, then run the Node-based mobile tests. |
| `npm run build` | Compile TypeScript to `dist`. | Export Android and iOS JavaScript bundles. |
| `npm audit` | Inspect the installed dependency tree for known advisories. | Inspect the installed dependency tree for known advisories. |

Use `npm run android` or `npm run ios` in `mobile` for a local native build.
Native changes require rebuilding and reinstalling the binary; Metro or an OTA
JavaScript update alone cannot install Kotlin/Swift workers or sign-in plugins.

## What the checks cover

API tests cover authentication, request validation, ownership, deduplication,
immutable snapshot verification, quota behavior, and SAS scoping. Mobile tests
cover hashing, network policy, upload block planning, resuming/cancelling uploads,
durable native queue handoff, completion reconciliation, and sign-out/cancellation
races.

> [!IMPORTANT]
> The mobile build command exports JavaScript bundles. It does **not** compile or
> test the native Google sign-in SDK or background workers on a device. Passing
> JavaScript checks alone does not establish background reliability.

The [manual Azure deployment workflow](../.github/workflows/deploy-azure-dev.yml)
restores, typechecks, tests, and builds the **API** before deployment. It is not a
push/PR-triggered CI workflow and does not replace mobile or native acceptance.

## Device acceptance checks

Native sign-in and real Azure access require your cloud configuration. Use
disposable test media and exercise the applicable cases on both Android and iOS
devices or emulators; background behavior must also be established on real devices.
Treat failures as release blockers rather than relaxing authentication or storage
permissions.

### Backup and account isolation

- [ ] Sign in and upload a small photo and a video. Refresh the gallery and check
  both thumbnails.
- [ ] Select the same file again, including a renamed copy. Confirm it is skipped
  rather than stored twice. An edited file should be a new backup.
- [ ] Interrupt connectivity during a multi-block video upload, reconnect, and
  retry. Confirm progress resumes and the final file matches the original.
- [ ] With cellular uploads disabled, confirm backup waits for Wi-Fi. Explicitly
  enable cellular uploads and verify the changed policy.
- [ ] Deny photo permission, then grant limited permission. Confirm the app
  explains the restriction and Sync all only includes accessible media.
- [ ] Sign out mid-upload, sign in as a second Google account, and confirm neither
  the queue nor gallery exposes the first account's media.
- [ ] Verify unauthenticated API requests are rejected, direct unsigned blob URLs
  fail, and expired SAS URLs no longer work.

### Background execution and recovery

- [ ] Tap Sync all, wait for scanning to finish, then switch apps and lock the
  screen during a multi-block video. Confirm the Android notification remains
  visible and iOS URLSession transfers continue when the OS permits. Reopen and
  check completion appears without re-uploading acknowledged blocks.
- [ ] While backgrounded, switch from Wi-Fi to cellular with mobile data disabled;
  verify transfers wait. Enable cellular in the app, then disable it mid-upload
  and verify the native worker stops using cellular immediately.
- [ ] Stop the Android notification/service or force-quit the iOS app. Reopen and
  use Resume backup / Retry; verify checkpoints survive without false completion.
  Exercise Android's data-sync service timeout and iOS processing expiration.
- [ ] Keep a background transfer pending past SAS expiry and past Google ID-token
  expiry. Check that SAS renewal works, expired sign-in pauses visibly, and
  reopening / Retry refreshes credentials. Confirm quota errors pause the queue.
- [ ] Enable auto-sync, add a photo while the app is active, and check it is queued.
  Photos added while closed must not be advertised as continuously discovered.
  Test denied notification permission, limited Photos access, low disk space,
  and cancellation/sign-out while native preparation is in progress.

### Endpoint and staging safety

- [ ] Confirm the deployed API's create/renew/complete routes and direct Azure
  endpoints never return redirects, including expired-auth and error paths.
  Use only disposable data and credentials when exercising redirect behavior.
- [ ] Back up several large originals while the app is backgrounded and confirm
  completed native staging is released. Fail one upload after preparation:
  remaining work must pause until Retry or Cancel. With an earlier preparation
  failure also queued, Retry failed uploads must finish the retained snapshot
  before allocating another original. Repeat with Android network backoff.

## Release handoff

Use the [deployment runbook](../infra/README.md) for protected OIDC deployment and
EAS internal Android/iOS distribution. Build the API before publishing, keep local
credential files out of artifacts, and use the native app's registered
bundle/package identifiers and signing certificates.

Quota initialization is required before first API start; subsequent deployments
reuse the ready ledger. Roll back only to a quota/allowlist-compatible revision.
Never restart a legacy writer that can bypass accounting.

Successful native compilation and the device checks above are release
requirements. Back up test files, confirm gallery access, and exercise
sign-out/account switching before trusting the app with irreplaceable media.

---

[Documentation index](README.md) | [Background backup](background-backup.md) |
[Deployment runbook](../infra/README.md)
