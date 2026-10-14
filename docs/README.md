# Documentation

These pages describe the current product and its contracts. Historical plans,
acceptance logs and abandoned prototypes are available through Git history.

The native engine, SDK boundaries and supported traffic behavior are described
in the [traffic contract](spec/traffic.md).

## Using and developing Codlet

| Page | Purpose |
| --- | --- |
| [Architecture](architecture.md) | Core-owned Codex integration and ordinary plugin execution |
| [Development](development.md) | Reproducible builds, checks and isolated desktop testing |
| [Distribution](distribution.md) | Windows and macOS packaging and installation |
| [Release readiness](release-readiness.md) | Current candidate scope and separately retained historical evidence |
| [Online Core updates](core-online-update.md) | Explicit state, admission, receipts and resident component boundaries |
| [Troubleshooting](troubleshooting.md) | CLI recovery, safe mode, logs and diagnostics |
| [Compatibility](compatibility.md) | Platform matrix and client-build evidence |
| [Known issues](known-issues.md) | Accepted limits, incomplete features and practical workarounds |

## Contracts

| Specification | Scope |
| --- | --- |
| [Plugin format](spec/plugin-format.md) | Entries, manifests, metadata and source identity |
| [Host runtime](spec/host.md) | Managed Node execution, cleanup and development watching |
| [RPC](spec/rpc.md) | Capabilities, scopes, generations, cancellation and limits |
| [Permissions](spec/permissions.md) | Grants, path/origin scopes and the trust boundary |
| [Core services](spec/services.md) | Storage, credentials, files, tasks, events and OS integration |
| [UI SDK](spec/ui.md) | Renderer UI, full React/DOM support and page lifecycle |
| [Codex SDK](spec/codex.md) | Stable navigation, workspace, Desktop and Host semantics |
| [Client source](spec/client-source.md) | Native attachment, private bridge and component ownership |
| [Management](spec/management.md) | Registration, transactions, updates and removal |
| [Traffic](spec/traffic.md) | Network channels and transparent interception coverage |

The [TypeScript contracts](../types) define concrete method shapes. Core embeds
the UI/Desktop implementation under [codex](../codex/README.md); the optional
GUI remains in [codlet-plugins](https://github.com/baoabaob/codlet-plugins).
Imported Adapter specifications and historical evidence retain their provenance,
while the maintained Core SDK contract defines the current interface.
