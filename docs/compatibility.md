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
