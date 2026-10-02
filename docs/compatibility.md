# Compatibility

Codlet follows the systems and architectures offered by the official desktop client, with Linux explicitly deferred. A target or a successful compilation is not evidence of real-client acceptance.

| Target | Implementation and evidence |
| --- | --- |
| Windows x64 | Native launch, Core, GUI/adapters, lifecycle, and local client tests; primary development Preview target. x64/AMD64 supports both Intel and AMD processors. |
| Windows ARM64 | Platform-specific Node pin and compile path; no ARM64 device acceptance recorded. |
| macOS Apple Silicon | Native Core/process ownership, compatibility profiles, Swift launcher, DMG and app updater. Controlled native Desktop/model HTTP/SSE/WS checks cover client 26.917.62051; manual GUI/installer acceptance remains separate. |
| macOS Intel | Not part of the currently selected official-client download target; no Universal/Intel package is produced. |
| Linux | Deferred; no claim of support. |

The project's current platform scope is based on the official [Windows deployment](https://learn.chatgpt.com/docs/enterprise/windows-deployment) and [desktop app](https://learn.chatgpt.com/docs/app) documentation. Recheck official offerings before adding another release target.

## Client integration

Reviewed client mappings live in `compatibility/client-profiles.json`; actual accepted versions are recorded separately in `compatibility/tested-client-versions.json`. Version numbers alone do not determine plugin compatibility. Optional adapters can validate the existing interfaces on an unlisted build; missing or ambiguous contracts make the affected capability unavailable. Core's runtime skill discovers the mounted local request client independently of optional adapters and version profiles. The native official-update action retains its separately reviewed mapping. Do not add an acceptance record because a source profile or cross-compile exists.

## Independently published acceptance records

Preview.24 reads the schema-3 acceptance catalog from the fixed public URL
`https://raw.githubusercontent.com/baoabaob/codlet/main/compatibility/tested-client-versions.json`.
This is advisory JSON; it cannot change plugin grants, execute code, install
updates, enable capabilities, or supply new private-interface mappings. The
source is pinned to this repository over HTTPS, redirects are rejected, and
schema, identity, version requirements, duplicates and size are validated.
If the raw-file read fails, Core reads the same repository, path and `main`
ref through the fixed anonymous GitHub contents API using the raw-file media
type. This fallback is bounded and validated identically. It does not reuse
ETags across endpoints, follow redirect URLs, or send GitHub credentials.

Each record identifies one exact official package and platform, the minimum
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

To publish an acceptance record, edit only `tested-client-versions.json`, raise
its monotonically increasing `revision`, validate the catalog and commit/push
it to `main`. Do not change the baseline or bump Core merely to record another
verified package. Reusing a revision with different content or serving an older
revision is rejected. A deliberate correction/removal uses a new revision.
Review adapter changes and obtain real-client evidence before adding records;
an interface change still needs the appropriate adapter/Core repair.

Preview.23 was withdrawn to a GitHub draft at the user's request. Its tag and
assets are preserved, but it is excluded from public release/update discovery.
Preview.24 introduces the remote reader; subsequent record-only changes need
no installer release.

Windows package 26.924.2738.0 (frontend 26.924.22138 / 11645, local App Server
0.158.0-alpha.2.1) has isolated real-client acceptance for the Core runtime skill,
native plugin navigation, GUI activation and clean shutdown. Preview.20 also verifies
migration of prior installer seeds through the published GitHub channels while retaining
grants and enabled preferences. This does not claim another real MSIX update was installed
during that isolated test; updater restart registration is covered separately by native
bridge tests and the observed user update.

The optional Desktop and UI adapters own private frontend behavior. Core owns generic lifecycle, identity, RPC, permissions, and resource cleanup. Adapter-only plugins can inherit the portability of the adapter operations they actually use; direct OS calls, binaries, native libraries, or private mappings can narrow support. Dependency names alone do not prove portability.

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
The 489 passing Core tests include raw/API fallback, bounded/invalid responses,
ETags, cache/revision validation, preferences and cancellation; six tests retain
their existing ignored status. The public settings API suite passed six tests.

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
