# Codlet Research Baseline

> Captured: 2026-09-02. This document records evidence and decisions, not redistributed Codex source or Desktop assets.

## Official Public Baseline

- [Codex App Server](https://developers.openai.com/codex/app-server): the supported deep-integration protocol for authentication, conversation history, approvals, and streamed agent events.
- [Codex Open Source](https://developers.openai.com/codex/open-source): the authoritative list of open-source Codex components.
- Public App Server semantics are `Thread -> Turn -> Item`. Each transport connection initializes independently; a second App Server process is not an attach mechanism for Desktop's live backend connection.

The local upstream snapshot was downloaded from the official `openai/codex` codeload endpoint at short commit `8d32abc` because direct Git smart HTTP was unavailable:

- archive: `C:/Users/cccake/Documents/ChatGPT/codlet-research/openai-codex-8d32abc.zip`
- archive SHA-256: `396f4eeff7d0ba728af7aa4bb640176e5c935b77903a0aaf7171d1a005e9b1a0`
- sparse research tree: `C:/Users/cccake/Documents/ChatGPT/codlet-research/openai-codex-sparse-8d32abc/`
- inspected modules: `app-server`, `app-server-protocol`, `app-server-client`, `core`, `hooks`

The research tree is intentionally outside this repository. It must not be packaged, committed, or redistributed with Codlet.

## Installed Desktop Baseline

- MSIX package: `OpenAI.Codex_26.831.2377.0_x64__2p2nqsd0c76g0`
- Electron app version from `package.json`: `26.831.21537`
- Electron: `42.3.0`
- `app.asar` SHA-256: `37e442e444194cebff47eb190b2c0ccd99332498a361545bbf823c49ccf11cd3`
- local read-only expansion: `C:/Users/cccake/Documents/ChatGPT/codlet-research/app-asar-expanded-26.831.2377.0/`

The expansion is a local compatibility-research artifact. Codlet does not modify `app.asar`, load files from the expansion at runtime, or redistribute it.

## Verified Desktop Bridge Facts

The following statements are verified against the exact Desktop baseline above:

1. `.vite/build/preload.js:1` exposes `window.codexWindowType` and `window.electronBridge` with `contextBridge.exposeInMainWorld`.
2. `electronBridge.sendMessageFromView` invokes `codex_desktop:message-from-view`; inbound `codex_desktop:message-for-view` is dispatched as a window `message` event.
3. A renderer `connect-app-host` window message transfers a `MessagePort` through the preload to Desktop main.
4. `webview/assets/app-initial-8c4390ee0fac.js:5838` creates that `MessageChannel` and resolves the app-host service facade.
5. `.vite/build/src-B8dS-jjl.js:689` contains the local App Server `StdioConnection`: JSON-RPC is newline-delimited over a child process's stdin/stdout on Windows.
6. The Desktop renderer contains same-connection turn start/steer/interrupt methods and consumes `turn/started`, `turn/completed`, `item/started`, `item/completed`, and `item/agentMessage/delta` notifications.

These are private, build-specific contracts. The evidence supports researching a first-party Backend Adapter; it does not make `electronBridge` or the app-host envelope a public Codlet SDK.

## Architecture Consequences

- L1-L3 remain independent of L4 and continue even if the private bridge changes.
- The only acceptable transparent L4 path is a first-party adapter over Desktop's existing app-host/App Server connection.
- Starting a separate App Server may be supported later as an explicitly detached backend, but never as a fallback masquerading as the current Desktop session.
- Public plugin capabilities use adapter-owned schemas such as `codex.backend.turn@1`; private host ids, request ids, service objects, and IPC channel names stay behind the adapter.
- A build registers L4 providers only after identity, schema, notification, approval, and write-round-trip gates pass.
- Display transformation and backend history mutation remain separate contracts. No generic persisted assistant-item rewrite is claimed by this baseline.
