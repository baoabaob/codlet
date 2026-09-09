# Native raw-CDP host example

This executable uses only Rust's standard library and `serde_json`. Its manifest
has a native `host` entry and no renderer entry, official plugin dependency, or
capability-provider declaration.

Build from the repository root with `cargo build --release --bin codlet-raw-host-example`.
Create `examples/raw-host/bin` and copy the resulting executable there. Register
this example directory with `codlet plugin add examples/raw-host --trust --grant host.process --grant cdp.raw`,
then enable it with `codlet plugin enable example.raw-host`. Start a fresh
`codlet launch` when the normal Codex desktop is closed. This M2a executor starts
and stops native hosts with the owning runtime; it does not hot-reload them yet.

The example handles Core's `initialize` request by calling `Target.getTargets`.
While the selected target is absent, it retries every 50 ms for up to 3.5 seconds.
Discovery and later calls share one 4.5-second initialization budget, with the
final 0.5 seconds reserved for cleanup; retries do not renew this budget. The
plugin selects a page or the first available target, then calls
`Target.attachToTarget` with `flatten: true`. It subscribes to that exact CDP
session, enables Runtime events, evaluates an expression, and receives
`cdp.event` notifications while waiting for RPC responses. It then unsubscribes
and detaches its session before replying with `{"ready":true}`. This works with
any compatible target/session; it does not inspect Codex URLs or load an adapter.
Every failure after attaching goes through the same cleanup path: unsubscribe
if a subscription was created, then detach the session. Cleanup failures do not
replace the original error. Shutdown replies immediately and exits without
further Core calls, including when it interrupts initialization or cleanup.

Append literal arguments to `host.command` to customize the demonstration:

- `--expression`, `document.title`: change the JavaScript expression.
- `--target-id`, `TARGET_ID`: select a specific CDP target.
- `--report`, `report.json`: save the result and up to 16 captured events in the
  plugin's working directory. The default writes no CDP data to a file or console.

Core RPC responses return the CDP result directly. The example unwraps only the
JSONL response envelope, not another CDP envelope. Missing `cdp.raw` produces a
`permission_denied` initialization failure, optionally saved in the report.

`host.process` authorizes an ordinary executable running as the current user;
neither its Job-based lifetime management nor the JSONL bridge is a sandbox.
The example can evaluate the supplied expression with the target's privileges.
