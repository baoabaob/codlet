# Unified Core v1 implementation contract

Status: implemented for the local `1.0.0-rc.1` candidate. See [validation evidence and platform boundaries](validation.md); this document defines the contract, not certification.

## Product and release

Codlet targets Codex. The UI and Desktop adapter implementations become Core-owned modules. GUI, split workbench, and capability test plugins remain independently reloadable consumers. Existing capability API 1 contracts and plugin identities/data stay valid. The candidate release is `1.0.0-rc.1`; no published release is overwritten.

Core exposes a semantic renderer SDK under `context.codex` while preserving `context.ui`, `context.services`, and existing RPC compatibility. The namespace must cover the current adapters' complete capability surface, including local callback/DOM handles without routing all calls through Rust IPC. The implementation owner defines exact typed methods before consumers migrate. Capability availability, implementation coverage, declared author support, and verified client/platform evidence are separate facts. Unknown client versions probe individual capabilities rather than disabling a whole plugin.

## Internal ownership and migration

The former adapter sources are imported into Core with provenance and maintained there. Internal provider identities may retain compatibility aliases, but are not user-installed plugins and cannot compete with installed legacy adapters. Migration preserves registry records, grants, and storage; Core supersedes legacy providers through a reversible migration, without deleting user files or silently increasing consumer privileges. Install defaults contain GUI only. Source catalogs and runtime/development documentation must reflect this.

## Permissions

Standard services do not confer the implementation's raw authority. Narrow exceptional boundaries cover selected executable/shell access, Native DOM/main-world access, raw CDP, and full raw Host environment. Existing grants migrate only within their previous authority. Permission text: “该权限允许插件直接使用未经 Codlet 统一适配的系统或客户端能力。相关功能的跨平台及客户端版本兼容由插件作者维护。”

Admission checks and broker enforcement must be distinguished from declaration/review rules. An isolated JavaScript world shares Native DOM; a full Node Host can bypass SDK brokers. No claim of security isolation may rely on labels or those worlds alone. Standard background computation must have an execution path that does not require full raw Host privileges. Preserve existing UI/native component functionality; do not replace it with an unvalidated whole-product rendering architecture.

## Online updates

First establish a small end-to-end proof with actual IPC/stream continuity before expanding integration. Compatible updates preflight code/protocol/state, snapshot explicit plugin state, close admission to new writes, settle accepted writes with determinate or explicitly unknown outcomes, retain Native connections/backend routing/stream forwarding, transfer single resource ownership, restore plugin state, and retire the old owner only after takeover acknowledgment. Deduplicate operations, reject stale epochs/late messages, support cancellation, and retain the old owner on preflight/takeover failure. Never replay side-effecting requests speculatively.

Arbitrary JS closures, Promises, DOM nodes, or external processes are not serializable state. Any permanent transport/injection/bootstrap component remains part of Core and must have an explicit update mechanism or accurately reported next-launch activation. Initial migration from the old architecture differs from subsequent compatible updates. Preserving a Native PID while breaking a running session is failure.

## Consumer invariants

Split ID remains `dev.split-workbench`. Preserve actual Native bodies, one Native composer, drafts/attachments/IME/permissions/navigation return/shortcuts/layout, all view modes and independent sidebar. Mount every added body with no total cap or offscreen eviction. History may paginate without a total cap. Free canvas remains 35%–1000%. Activity uses `working: boolean | null`; unknown retains existing members, and waiting-but-idle is not working. The accepted approximately 200 ms switching behavior is not evidence of the former 50/100 ms goal. No second App Server connection.

## Work ownership

- Update worker: runtime/client bridge/transport and runtime update implementation, targeted tests and update documentation. Coordinate before editing shared renderer bootstrap, `plugins.rs`, `lib.rs`, or `main.rs`.
- SDK worker: Core-owned adapter sources, semantic facade/types, Core provider integration and adapter compatibility tests. Own renderer bootstrap integration; coordinate permission fields with permission worker. Do not edit official GUI or split consumers.
- Permission worker: permission model, Host execution boundaries, admission/broker validation and focused tests/docs. Own `plugins.rs`, `plugin_permissions.rs`, and `runtime/host.cjs`; coordinate shared runtime entrypoints.
- Main agent: consumers, installer/catalog/CLI migration, test-plugin discovery, release metadata, cross-module integration and final verification.

All workers preserve existing uncommitted work. Baseline patches and untracked files were saved under `.codlet-artifacts/major-v1-baseline-20261014`. Do not reset/clean, delete with `--force`, commit other owners' edits, publish, or control the user's daily Native instance. Use owned isolated clients for live checks. Windows tests do not establish macOS acceptance.
