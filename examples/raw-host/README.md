# Raw CDP host plugin in JavaScript

This is an ordinary Codlet directory package: `codlet.json`, `dist/host.js` and
optional resources. It needs no renderer entry, official adapter, native binary
or per-plugin Node installation. Codlet provides the JS process and handles JSONL.

With a Codlet distribution that includes its managed JS runtime:

```powershell
codlet plugin add .\examples\raw-host --trust --grant host.process --grant cdp.raw
```

The next `codlet launch` loads `host.entry` using CommonJS `activate(context)` and
`deactivate()`. A running Codlet session also supports online management, including
this example registered after launch. Use the same Codlet executable that owns
the session:

```powershell
codlet plugin enable example.raw-host
codlet plugin reload example.raw-host
codlet plugin disable example.raw-host
```

Reload requires an enabled plugin; use `enable` to start a disabled one. Commands
use the existing lifecycle receipts described in [the host control contract](../../docs/M2B_HOST_CONTROL_2026-09-10.md).

The example uses `context.cdp` to discover any target, attach a flattened session,
subscribe to that session, enable Runtime, evaluate an expression, unsubscribe
and detach. Target discovery waits briefly for a newly launched client. Errors
still run cleanup, and shutdown makes no further Core calls. It has no Codex URL
filter, private selector or official capability dependency.

Optionally create `settings.json` in this directory:

```json
{
  "expression": "document.title",
  "report": "report.json"
}
```

`targetId` can select an explicit target. `report` saves the result and up to 16
captured events; omit it to avoid saving page data. Node built-in modules and pure
JS dependencies can be required normally; relative imports and resources resolve
against the original plugin directory even though the entry runs from a snapshot.

TS authors can use [the host declarations](../../types/host.d.ts) and compile their
entry to CommonJS `.js` or `.cjs`. The runtime does not compile TS or load `.node`
addons. These packaging rules do not provide a sandbox: host JS retains ordinary
current-user Node filesystem, network and process access.

For source development, build `codlet` then stage its pinned runtime once:

```powershell
cargo build --locked --bin codlet
.\scripts\Install-JsRuntime.ps1 -Destination .\target\debug
```

Use the actual target directory if `CARGO_TARGET_DIR` is set. The staging script
downloads and verifies the official Node runtime for the distribution; it runs
no plugin or dependency install scripts and changes no system Node installation.
See [the full JS runtime contract](../../docs/JS_PLUGIN_RUNTIME_2026-09-09.md).
