# Codlet

Codlet is a Windows-first launcher and lightweight extension runtime for Codex Desktop. The current code is an M0 inherited-CDP-pipe candidate implementation described in `docs/PRODUCT_TECHNICAL_PLAN.md`. On 2026-08-30, the user confirmed that the latest external M0 run used installed Codex build `26.825.6671.0`. This records build coverage for that run, not a permanent compatibility guarantee; the complete M0 lifecycle and repetition gates have not passed yet.

It does not modify the Codex package, official shortcuts, protocols, configuration, or user data. It never terminates or restarts an existing Codex process. Normal Codex launches do not run Codlet.

## M0 commands

Run the automated checks on Windows:

```powershell
cargo fmt --all -- --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-targets --all-features
```

Inspect the installed package and report any running process from the Codex package without launching anything:

```powershell
cargo run --locked --bin codlet -- doctor
```

The foreground M0 runtime path is deliberately explicit. Run it only after manually closing every Codex window:

```powershell
cargo run --locked --bin codlet -- m0-runtime --launch-codex
```

The runtime first checks the package identity of every running `ChatGPT.exe` candidate. If any process belongs to the Codex package, it reports an instance conflict and exits without modifying that process. Otherwise it launches the installed package executable with the two inherited CDP handles, discovers the exact `app://-/index.html` renderer, inserts and removes a temporary marker, then keeps the runtime and pipes alive. Use Codex normally and close Codex yourself; the foreground runtime then observes that child exit, joins its CDP workers, and returns. It never kills Codex.

The one-shot transport smoke probe remains available:

```powershell
cargo run --locked --bin codlet -- m0-probe --launch-codex
```

This is not a production launcher. Completing the smoke probe closes its remote-debugging pipe. Electron binds that disconnect to application quit, so the Codex instance launched by the smoke probe exits even though Codlet calls no process-termination API.

The equivalent ignored integration gate additionally requires explicit authorization. It must only be run after the user has deliberately closed every Codex window and confirmed that launching a fresh Codex instance is acceptable:

```powershell
$env:CODLET_RUN_REAL_CODEX_GATE = "1"
try {
    cargo test --locked --test real_codex_gate installed_codex_accepts_inherited_cdp_pipe -- --ignored --exact --nocapture
} finally {
    Remove-Item Env:CODLET_RUN_REAL_CODEX_GATE
}
```

Do not run that command merely to exercise CI. The real foreground lifecycle (Codex remains visible and usable while the runtime is alive, then the runtime exits cleanly after the user closes Codex), zero behavior from the official entry, repeated launches, orphan checks, and port-scan checks remain external M0 gates.

## Scope

The current M0 candidate covers NUL framing, blocking request/event routing, EOF teardown, exact Windows handle inheritance, current-user package discovery, conflict detection, target discovery, the launch probe, and a minimal foreground runtime host. A detached runtime process and launcher/runtime IPC are deferred to a later milestone. Plugin registry, renderer plugin lifecycle, the first-party `codlet` GUI, plugin host processes, SDK, and marketplace work remain outside M0.
