# Documentation

Start with the maintained contracts below. Release evidence and historical research have separate directories so an old experiment does not become a current requirement.

## Product and development

| Page | Purpose |
| --- | --- |
| [Repository ownership](repository-layout.md) | Core, ordinary plugins, generated GUI distribution and retired Adapter repositories |
| [Architecture](architecture.md) | Core-owned Codex integration and ordinary plugin execution |
| [Create a plugin](plugin-development.md) | AI-assisted creation, source projects, copied installs, updates and sharing |
| [Development](development.md) | Reproducible builds, checks and isolated desktop testing |
| [Distribution](distribution.md) | Windows and macOS packaging and installation |
| [Release readiness](release-readiness.md) | Current candidate scope and outstanding acceptance |
| [Online Core updates](core-online-update.md) | Update admission, state transfer, receipts and resident components |
| [Troubleshooting](troubleshooting.md) | CLI recovery, safe mode, logs and diagnostics |
| [Compatibility](compatibility.md) | Platform matrix and client-build evidence |
| [Native source adaptation](native-source-adaptation.md) | Preserved sources, binding-aware diffs, interface mapping, patch proposals and evidence levels |
| [Known issues](known-issues.md) | Accepted limits, incomplete features and practical workarounds |

## SDK contracts

| Specification | Scope |
| --- | --- |
| [Plugin format](spec/plugin-format.md) | Entries, manifests, metadata and source identity |
| [Plugin updates](spec/plugin-updates.md) | Signed static feeds, publisher tooling, caching and migration |
| [Host runtime](spec/host.md) | Managed Node execution, cleanup and development watching |
| [RPC](spec/rpc.md) | Capabilities, scopes, generations, cancellation and limits |
| [Permissions](spec/permissions.md) | Grants, path/origin scopes and the trust boundary |
| [Core services](spec/services.md) | Storage, credentials, files, tasks, events and OS integration |
| [UI SDK](spec/ui.md) | Renderer controls, React/DOM support and page lifecycle |
| [Codex SDK](spec/codex.md) | Navigation, workspace, Desktop and Host semantics |
| [Workspace](spec/workspace.md) | Native surfaces, transcripts, input confirmation, location and viewport ownership |
| [Client source](spec/client-source.md) | Native attachment, private bridge and component ownership |
| [Client compatibility](spec/client-compatibility.md) | Runtime contracts, capability discovery and independent degradation |
| [Management](spec/management.md) | Registration, transactions, updates and removal |
| [Traffic](spec/traffic.md) | Network channels and interception coverage |

Concrete method shapes live in [types](../types). Core maintains the implementation in [codex](../codex/README.md); the optional GUI remains in [codlet-plugins](https://github.com/baoabaob/codlet-plugins).

## Evidence and archives

- [Release records](releases/README.md): exact sources, immutable packages, validation and limits for each candidate.
- [Current Windows candidate validation](releases/1.0.0-rc.20/validation.md) records actual Native checks on builds 22391 and 21828; remote publication is separate. [rc.19](releases/1.0.0-rc.19/validation.md), the [first v1 validation](releases/1.0.0-rc.1/validation.md) and [implementation](releases/1.0.0-rc.1/implementation.md) retain their original candidate scope.
- [Historical research](history/README.md): dated Core investigations, imported Adapter specifications and previous release readiness.

Native identity inventories referenced by current code remain beside their current compatibility documents. Historical commands and absolute report paths document the original run; they are not instructions to rerun against a daily client.
