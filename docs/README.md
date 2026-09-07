[Syncachu](../README.md) / Documentation

# Documentation

Guides for developing, deploying, and operating your own Syncachu instance.
Start with the path that matches your role, then use the reference guides for
platform behavior and operational details.

> [!NOTE]
> Syncachu is in private beta. These guides describe the current implementation,
> including its limits; they do not imply a public release or a managed service.

## Choose a starting point

| Audience | Start here | Then |
| --- | --- | --- |
| Developers | [Getting started](getting-started.md) | [Architecture](architecture.md) and [development checks](development.md) |
| Instance operators | [Deployment runbook](../infra/README.md) | [Security model](security.md) and [storage accounting](storage-and-quota.md) |
| Invited testers | Install the internal build shared by your operator | [First backup](getting-started.md#make-your-first-backup) and [background behavior](background-backup.md) |

## Guides and reference

| Document | Covers |
| --- | --- |
| [Getting started](getting-started.md) | Prerequisites, Azure development resources, Google OAuth, local configuration, and a first backup. |
| [Architecture](architecture.md) | Component responsibilities, the upload lifecycle, authenticated routes, and code entry points. |
| [Background backup](background-backup.md) | Android and iOS workers, network restrictions, local staging, and retry behavior. |
| [Security model](security.md) | Identity, account isolation, SAS grants, metadata, encryption, and the iOS redirect boundary. |
| [Storage and quota](storage-and-quota.md) | Initialization, reservations, capacity limits, cleanup, and billing boundaries. |
| [Development and release checks](development.md) | Package commands, automated coverage, and device acceptance requirements. |
| [Deployment runbook](../infra/README.md) | Azure provisioning, managed identities, GitHub OIDC, manual deployment, and internal native distribution. |

## Before working with real media

Use a dedicated development storage account and disposable media during setup.
Read the [security model](security.md) before configuring endpoints or sharing a
build. Complete the [device acceptance checks](development.md#device-acceptance-checks)
before relying on background backup, and retain an independent copy of important
files.

---

[Back to the project overview](../README.md)
