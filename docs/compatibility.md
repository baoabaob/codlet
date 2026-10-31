# Compatibility

Codlet follows the systems and architectures offered by the official desktop client, with Linux explicitly deferred. A target or a successful compilation is not evidence of real-client acceptance.

| Target | Implementation and evidence |
| --- | --- |
| Windows x64 | Native launch, Core SDK, optional GUI, lifecycle, and bounded local client tests; primary delivery target. x64/AMD64 supports both Intel and AMD processors. |
| Windows ARM64 | Platform-specific Node pin and compile path; no ARM64 device acceptance recorded. |
| macOS Apple Silicon | Native Core/process ownership, compatibility profiles, Swift launcher, DMG and app updater. Controlled native Desktop/model HTTP/SSE/WS checks cover client 26.917.62051; manual GUI/installer acceptance remains separate. |
| macOS Intel | Not part of the currently selected official-client download target; no Universal/Intel package is produced. |
| Linux | Deferred; no claim of support. |

The 2026-10-20 review checked Native **26.1013.40934 / build 20770** on the current
production update channel. Windows package 26.1013.4894.0 retained the previously
reviewed source/Node hashes. macOS acceptance now includes this Native's signed
CUA Node, Core resolver, DMG initialization and update/rollback checks. These are
separate from the older full Desktop/model transport fixtures and from manual
account/GUI acceptance; see the [rc.7 record](releases/1.0.0-rc.7/validation.md).

The project's current platform scope is based on the official [Windows deployment](https://learn.chatgpt.com/docs/enterprise/windows-deployment) and [desktop app](https://learn.chatgpt.com/docs/app) documentation. Recheck official offerings before adding another release target.

## Client integration

The published Windows x64 **1.0.0-rc.22** supports official package
`26.1027.3384.0` / app `26.1027.30824` / build `22943`, with Desktop `0.2.22`
and UI `0.1.19`. Its exact `b32fc5e`/`c30f696c…` production package passed an
actual rc.21 setup upgrade, same-version maintenance and installed Native,
sidebar, Split and permission-read checks. The original harness retained a
settled update-network error; one new check by the same Core then succeeded
without network changes. See [rc.22 validation](releases/1.0.0-rc.22/validation.md)
for startup recovery, preceding failures and execution boundaries, and the
[publication record](releases/1.0.0-rc.22/publication.md) for public artifacts.
The profile used a synthetic loopback API-key backend and an existing verified
Node pin. Real OAuth/account/settings/Statsig network paths and first-time Node
download were not validated. The Native menu has no explicit read-only option,
so that permission mutation was unsupported and not executed.

The independently published public catalog is revision `2026103101`, with eight
records, including this accepted package/pair. The final production binary keeps
its older bundled baseline `2026102801`; source metadata and public advisory
catalog publication do not rebuild it. Their exact commits and public raw-body
SHA-256 are recorded in the publication record.

The published Core **1.0.0-rc.20** passed isolated Native acceptance on package
`26.1023.6123.0` / app `26.1023.50603` / build `22391`, and regression checks
on `26.1021.3705.0` / app `26.1021.31345` / build `21828`. The same production
executable covered conversations, permission reads, classic/rail transitions,
project/list grouping and normal shutdown; [rc.20 validation](releases/1.0.0-rc.20/validation.md)
retains its scope. The [rc.21 record](releases/1.0.0-rc.21/validation.md) separately
records the Desktop HTTP correction and direct-setup recovery on the later
installed package `26.1023.6621.0`.

The rc.22 update requires the complete runtime and a new start. rc.20/rc.21 MSI
owners must run the setup EXE directly after saving work and fully quitting the
client; the handoff repair takes effect in the newly installed Core. Official
Native updates remain separate from Codlet setup.

Core's maintained Native startup and source mappings live in `codex/compatibility/client-profiles.json`. The retired pre-v1 catalog is preserved in [the Core history archive](history/core/client-profiles-before-v1.json). Actual accepted versions are recorded separately in `compatibility/tested-client-versions.json`. Version numbers alone do not determine plugin compatibility. Core probes individual interfaces on an unlisted build; a missing or ambiguous contract makes the affected capability unavailable or unknown. The runtime skill discovers the mounted local request client independently. The native official-update action retains its separately reviewed mapping. Do not add an acceptance record because a source profile or cross-compile exists. Local candidate evidence does not rewrite historical acceptance records.

## Independently published acceptance records

Core reads the schema-3 acceptance catalog from the fixed public URL
`https://raw.githubusercontent.com/baoabaob/codlet/main/compatibility/tested-client-versions.json`.
This is advisory JSON; it cannot change plugin grants, execute code, install
updates, enable capabilities, or supply new private-interface mappings. The
source is pinned to this repository over HTTPS, redirects are rejected, and
schema, identity, version requirements, duplicates and size are validated.
If the raw-file read fails, Core reads the same repository, path and `main`
ref through the fixed anonymous GitHub contents API using the raw-file media
type. This fallback is bounded and validated identically. It does not reuse
ETags across endpoints, follow redirect URLs, or send GitHub credentials.

Historical records identify one exact official package and platform, the minimum
Core and required adapter versions, and the versions actually used for its
acceptance. A matching package with an older Core or an inactive/older required
adapter reports `requirements-unmet`; it does not inherit a passing result from
another installed configuration. Minimum versions are advisory prerequisites,
not evidence that every later combination has itself been exercised.
The oldest package-only entry is explicitly marked `legacyRecord`, with no
invented Core/adapter test combination. Its minimum Core identifies the first
release carrying that acceptance entry.

The bundled `compatibility/client-compatibility-baseline.json` is an offline
baseline, separate from the independently maintained remote catalog. Core
loads a validated last-successful cache first and checks in the background after
normal runtime readiness. Automatic checks follow the existing
`automaticUpdateChecks` preference. Fresh caches avoid startup downloads for
six hours; an unlisted running client triggers a check even with a fresh cache.
Raw-file checks use ETag revalidation. Errors keep the current records and
retry after 15 minutes. Manual checks coalesce for 60 seconds; closing the
runtime cancels an outstanding request.

The cache is a bounded atomic sidecar named
`<registry>.compatibility-cache.json`. Offline startup uses that cache or the
bundled baseline and does not wait for network access. Diagnostics report the
source, catalog revision, last successful check and refresh error. The record
is a compatibility fact, not evidence that an official client update exists.

To publish an acceptance record, edit the fixed public
`tested-client-versions.json`, raise its monotonically increasing `revision`,
validate the catalog and commit/push it to `main`. The independently published
catalog does not replace the baseline already compiled into an accepted Core.
Reusing a revision with different content or serving an older revision is
rejected. A deliberate correction/removal uses a new revision.

The rc.22 source branch requires its checked-in catalog and baseline to match.
After acceptance, synchronize those two source files in one metadata commit,
separate from the fixed public catalog's `main` commit. This prepares later
builds' baseline while preserving the accepted installer's original bytes.
Neither metadata publication requires rebuilding that accepted binary.
Review the Core compatibility modules and obtain real-client evidence before
adding records; an interface change still needs the appropriate implementation repair.

Old Core Preview releases, drafts and version tags have been removed while
preparing 0.2.0. The independent acceptance catalog remains available; changing
an acceptance record does not require publishing another installer.

Windows package 26.924.2738.0 (frontend 26.924.22138 / 11645, local App Server
0.158.0-alpha.2.1) has isolated real-client acceptance for the Core runtime skill,
native plugin navigation, GUI activation and clean shutdown. Preview.20 also verifies
migration of prior installer seeds through the published GitHub channels while retaining
grants and enabled preferences. This does not claim another real MSIX update was installed
during that isolated test; updater restart registration is covered separately by native
bridge tests and the observed user update.

Core owns the Codex frontend and Desktop compatibility implementation as well as lifecycle, identity, RPC, permissions and cleanup. Standard SDK consumers use that adaptation without inheriting its raw permissions. Explicit direct OS calls, binaries, native libraries or private mappings can narrow the author's support scope. SDK declarations, runtime availability and actual platform verification are separate facts.

Windows package `26.928.1915.0` (frontend `26.928.20755` / `12246`, AppServer
`0.159.0`) passed isolated real-client checks for the runtime skill, plugin GUI,
Desktop task reads, composer actions, native page toolbar and unsubmitted draft
creation. The run had zero plugin errors and a normal exit. It used a fresh
profile, synthetic onboarding and a loopback API fixture; daily-client data,
real sign-in and MSIX installation were outside that acceptance.

## Acceptance evidence

Fresh Windows profiles do not isolate machine-wide sandbox users and firewall
rules. Earlier native acceptance profiles triggered the official elevated
sandbox provisioner on the development host. This can affect other profiles;
the profile boundaries stated below apply to files and credentials, not system
sandbox state. Native Windows acceptance now requires an explicitly disposable
VM/host (`disposableWindowsHost: true`). Do not run that provisioning flow on a
shared daily machine. This changes the acceptance tooling, not Core startup.

Preview.24 on Windows package `26.930.2377.0`, Desktop Adapter 0.2.8 and
UI Adapter 0.1.10 passed four native public-management checks for live remote
records, manual refresh, caller-source rejection and list/status consistency.
The normal functional fixture passed its 20 checks and scoped CLI
reload/disable/enable cleanup in the same run. The runtime skill was ready,
both sources activated, the client exited normally and there were zero plugin
errors. Tests used an owned fresh profile and synthetic loopback fixtures.
The regression suite separately covers raw/API fallback, bounded/invalid
responses, ETags, cache/revision validation, preferences and cancellation.

Windows package `26.930.2377.0` (frontend `26.930.21537` / `12776`, AppServer
`0.159.0-alpha.12.1`) passed the extended `compatibility.acceptance` 0.0.2
fixture with Desktop Adapter 0.2.7 and UI Adapter 0.1.10. Both HTTP/SSE and
Responses WebSocket runs passed 24 functional checks, including task opening,
submit rewrite/context injection, model traffic rewriting, events/history,
steering/interruption and plugin-owned Core services. The WebSocket run also
passed scoped CLI reload/disable/enable and generation cleanup. The runtime
skill was ready, both sources activated, and the clients exited normally with
zero plugin errors. This used synthetic credentials and owned loopback fixtures;
real OAuth, new MSIX installation, OS dialogs and other platforms are separate.

This update required exact-image startup and main/backend source reviews in the
Desktop Adapter. The startup-only inspector argument is consumed before later
native workers/forks inherit it; retaining it left the worktree environment
reader waiting indefinitely. Core's generic production lifecycle is unchanged.

For each target, record the installed official package/frontend/backend identity, pinned Node version, launch and shutdown, management IPC, runtime skill, plugin activation/reload/revocation/removal, dependency failure recovery, and UI behavior. Installer tests must cover paths with spaces and non-ASCII characters, existing data, running applications, shortcut choices, and cancellation.

CI-native process tests, simulated protocols, package mount/signature checks, and real desktop tests answer different questions. Preserve that distinction in release notes and [known issues](known-issues.md); never present unsigned or untested builds as notarized or fully accepted.
