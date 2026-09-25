# Documentation

These pages describe the current product and its contracts. Historical plans,
acceptance logs and abandoned prototypes are available through Git history.

The active [native traffic migration design](native-traffic-migration.md) is a
proposal for upcoming implementation, not a description of shipped behavior.

## Using and developing Codlet

| Page | Purpose |
| --- | --- |
| [Architecture](architecture.md) | Ownership, Core/Adapter boundary and execution model |
| [Development](development.md) | Reproducible builds, checks and isolated desktop testing |
| [Distribution](distribution.md) | Windows and macOS Preview packaging and installation |
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
| [Management](spec/management.md) | Registration, transactions, updates and removal |
| [Traffic](spec/traffic.md) | Network channels and transparent interception coverage |

The [TypeScript contracts](../types) define concrete method shapes. The optional
official GUI and client adapters have their own [specifications](https://github.com/baoabaob/codlet-plugins/tree/main/docs/spec).
They are not compiled into Core. Their documented capabilities must not be
mistaken for an official-client API built into the generic runtime.
