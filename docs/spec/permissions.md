# Permissions and explicit scopes

Managed authority is the intersection of the loaded manifest declarations, explicitly saved grants, resource ownership and applicable scopes. A grant absent from the manifest does not expand its declaration. Requiring a semantic adapter capability does not implicitly grant all permissions used by its provider.

## Current permissions

| Permission | Managed surface / scope |
| --- | --- |
| `ui.dom` | Renderer access to page DOM |
| `ui.mainWorld` | Renderer execution in the page's own JavaScript world |
| `cdp.raw` | Host raw CDP; Core tracks its managed sessions/resources |
| `host.process` | Managed Node Host activation; legacy `process.run` also needs `executables` |
| `host.fs` | Host read broker and Core file reads under `readRoots` |
| `host.network` | HTTP fetch/traffic dispatch to exact `networkOrigins`, including a selected proxy |
| `traffic.intercept` | Host interception of granted exact origins through the Native traffic entrance |
| `traffic.sensitiveHeaders` | Read/change sensitive traffic headers and WebSocket subprotocols |
| `traffic.redirect` | Rewrite a request to another separately granted origin |
| `host.system` | Host's bounded OS/architecture/logical CPU query |
| `runtime.manage` | Management of other plugins, imports and grants; not a read-only listing grant |
| `core.storage` | Own config/KV and data/cache namespace |
| `core.credentials` | Own credential metadata, creation, rotation and removal |
| `core.credentials.use` | Authorized use of an origin-bound credential reference |
| `host.fs.write` | Atomic write, mkdir and nonrecursive removal under `writeRoots` |
| `host.fs.watch` | Bounded nonrecursive watches under `watchRoots` or permitted selection references |
| `core.files.dialog` | Native selection and temporary selected-file access |
| `core.events` | Owner topics; cross-plugin access additionally needs exact capability declarations |
| `core.tasks` | Own registered task runners and tasks |
| `host.process.spawn` | Streaming managed child processes; `executables`, optional `cwdRoots` and `envKeys` |
| `core.network` | Owner network profiles, route/proxy resolution and status |
| `core.notifications` | Owner native notifications |
| `core.clipboard.read` | Explicit clipboard text reads |
| `core.clipboard.write` | Explicit clipboard text writes |
| `core.shortcuts` | Only combinations granted in `shortcuts` |
| `core.diagnostics` | Own resource inventory and bounded diagnostics |

Core services require `codlet.core.services@1` with Runtime scope on the calling entry as well as the method's permission. Renderer-only packages may declare `host.fs`, `host.network` and service permissions; names beginning with `host` do not require an otherwise empty Node Host. `host.process.spawn` is distinct from `host.process`. See [services](services.md) and [Host](host.md).

Selected references are an explicit exception to permanent directory grants: `files.read/stat/readDir/writeAtomic` with `reference` use `core.files.dialog`, and the reference constrains read/write access to the selection. They do not authorize unrelated paths, create permanent roots, or bypass watch/mkdir/remove permissions.

## Trust record and broker policy

The registry stores one complete `path + grants + brokerPolicy` record per local registration. `path` is the canonical directory; the optional policy uses `readRoots`, `writeRoots`, `watchRoots`, `networkOrigins`, `executables`, `cwdRoots`, `envKeys` and `shortcuts`. An empty or omitted list grants no ambient scope. Each list has at most 32 distinct entries; policy paths are bounded to 4,096 bytes, environment keys/shortcut values to 128 bytes.

CLI grants are explicit and repeatable:

```text
plugin add ABSOLUTE_PLUGIN_DIRECTORY --trust --grant core.storage --grant host.fs --read-root ABSOLUTE_DATA_DIRECTORY
plugin permissions dev.notes --json
```

Other scope flags are `--write-root`, `--watch-root`, `--network-origin`, `--executable`, `--cwd-root`, `--env-key` and `--shortcut`. Add `--enable` only when activation is intended. Normalized scope review does not execute the plugin.

Root scopes require the matching file permission. `executables` requires `host.process` or `host.process.spawn`; `cwdRoots`/`envKeys` require `host.process.spawn`. `shortcuts` requires `core.shortcuts`. Network origins are normalized exact HTTP(S) scheme/host/port values without credentials, wildcards, path, query or fragment. WS/WSS credential/network destinations normalize to the corresponding HTTP(S) origin. Windows executable selections must name `.exe` files; platform validation is not an assumption that Windows paths work elsewhere.

The path broker checks lexical scope before traversing and pins validated filesystem objects. Device paths, alternate data streams, traversal and unsafe symlink/reparse/hard-link cases are rejected as applicable. A granted generic shell/interpreter still exposes its own functionality; argument arrays do not make arbitrary code safe.

## Revocation and concurrency

Registry reads accept the supported legacy schema; explicit saves use schema 2. The complete registry and candidate save are bounded to 1 MiB. Saves compare the complete prior trust record under the registry lock, preserving unrelated preference edits and rejecting concurrent trust changes.

Admission and result delivery validate current authority against the generation snapshot. Removing registration, changing its root/grants/policy or failing to validate the record retires old managed authority. Core-owned handles and invocation tokens cannot be reassigned by putting another plugin ID or generation in business parameters.

`plugin revoke ID PERMISSION` atomically removes that grant and associated scopes, then retires the owner and affected dependency closure. It preserves enabled preference, does not automatically compensate with old authority and does not reverse completed external effects. Shared executable scopes remain only when another applicable process grant still authorizes them. Granting authority again creates a fresh valid generation.

Finite Host cleanup cannot restore ordinary calls. It may use `cdp.raw` only while the same loaded source/registration still authorizes it; removing raw permission, changing the directory or unregistering prevents the plugin's raw cleanup calls. Core can still reclaim resources it owns directly.

## Trust limits

Node Host and launched programs run as the current user, not in an OS security sandbox. Main-world code shares the application's JavaScript environment; isolated worlds separate JavaScript globals but share the underlying page DOM. Raw CDP deliberately retains a broad method surface. These capabilities are not reduced to an adapter allowlist, and arbitrary page/OS effects are not automatically reversible. Lifecycle isolation and bounded managed resources are not claims of hostile-code containment.
