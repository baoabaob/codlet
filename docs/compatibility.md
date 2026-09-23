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

Reviewed client mappings live in `compatibility/client-profiles.json`; actual accepted versions are recorded separately in `compatibility/tested-client-versions.json`. Unknown client builds must report unavailable private integrations explicitly. Do not add an acceptance record because a source profile or cross-compile exists.

The optional Desktop and UI adapters own private frontend behavior. Core owns generic lifecycle, identity, RPC, permissions, and resource cleanup. Adapter-only plugins can inherit the portability of the adapter operations they actually use; direct OS calls, binaries, native libraries, or private mappings can narrow support. Dependency names alone do not prove portability.

## Acceptance evidence

For each target, record the installed official package/frontend/backend identity, pinned Node version, launch and shutdown, management IPC, runtime skill, plugin activation/reload/revocation/removal, dependency failure recovery, and UI behavior. Installer tests must cover paths with spaces and non-ASCII characters, existing data, running applications, shortcut choices, and cancellation.

CI-native process tests, simulated protocols, package mount/signature checks, and real desktop tests answer different questions. Preserve that distinction in release notes and [known issues](known-issues.md); never present unsigned or untested builds as notarized or fully accepted.
