# Release records

| Candidate | Record |
| --- | --- |
| 1.0.0-rc.22 | [Native build 22943 acceptance and Windows restart handoff](1.0.0-rc.22/validation.md); [publication](1.0.0-rc.22/publication.md) |
| 1.0.0-rc.21 | [Desktop HTTP upload and response lifecycle correction](1.0.0-rc.21/validation.md) |
| 1.0.0-rc.20 | [Build 22391/21828 acceptance and live sidebar adaptation](1.0.0-rc.20/validation.md) |
| 1.0.0-rc.19 | [Runtime skill registration and transcript positioning](1.0.0-rc.19/validation.md) |
| 1.0.0-rc.18 | [Native ownership discovery and joint updates](1.0.0-rc.18/validation.md) |
| 1.0.0-rc.17 | [Native request continuity and build 21828](1.0.0-rc.17/validation.md) |
| 1.0.0-rc.16 | [Task ancestry and child-task selection](1.0.0-rc.16/validation.md) |
| 1.0.0-rc.15 | [Workspace transcript and interaction checks](1.0.0-rc.15/validation.md) |
| 1.0.0-rc.14 | [Startup, Native mappings and Windows desktop acceptance](1.0.0-rc.14/validation.md) |
| 1.0.0-rc.13 | [Cold-start readiness and workspace runtime](1.0.0-rc.13/validation.md) |
| 1.0.0-rc.12 | [Official update and keymap source adaptation](1.0.0-rc.12/validation.md) |
| 1.0.0-rc.11 | [Core update delivery and Windows upgrades](1.0.0-rc.11/validation.md) |
| 1.0.0-rc.10 | [Native source analysis, workspace adaptation and coverage evidence](1.0.0-rc.10/validation.md) |
| 1.0.0-rc.9 | [Signed static plugin updates and publishing contract](1.0.0-rc.9/validation.md) |
| 1.0.0-rc.8 | [Startup recovery and background update checks](1.0.0-rc.8/validation.md) |
| 1.0.0-rc.7 | [Repository review, skill workflow and Windows/macOS delivery](1.0.0-rc.7/validation.md) |
| 1.0.0-rc.6 | [Node reuse and startup progress](1.0.0-rc.6/validation.md) |
| 1.0.0-rc.5 | [Plugin installation lifecycle](1.0.0-rc.5/validation.md) |
| 1.0.0-rc.4 | [Windows startup repair](1.0.0-rc.4/validation.md) |
| 1.0.0-rc.2 | [Capability-based integration and validation](1.0.0-rc.2/validation.md) |
| 1.0.0-rc.1 | [Implementation and migration](1.0.0-rc.1/implementation.md), [Windows validation and package identities](1.0.0-rc.1/validation.md), [macOS packaging](1.0.0-rc.1/macos-packaging.md) |

The latest published Windows preview is **[1.0.0-rc.22](https://github.com/baoabaob/codlet/releases/tag/v1.0.0-rc.22)**, released on 2026-10-31 for official package `26.1027.3384.0`, app `26.1027.30824` / build `22943`. Its exact production setup passed an rc.21 upgrade, same-version maintenance and installed Native/sidebar/Split checks; update discovery succeeded on one new check after a network error. Both preview catalogs select the complete runtime. rc.20/rc.21 MSI owners must upgrade directly through setup; the repaired restart handoff becomes active after installation.

**1.0.0-rc.20** was published on 2026-10-28; its navigation and permission acceptance did not cover the affected authenticated Desktop HTTP paths. Each record identifies its exact implementation, artifacts, publication status and evidence; later documentation or directory changes do not change an existing package's source identity. Never overwrite an archive under an existing version.

See [current readiness](../release-readiness.md) for remaining work and [0.2.0 history](../history/releases/0.2.0-readiness.md) for the earlier release plan.
