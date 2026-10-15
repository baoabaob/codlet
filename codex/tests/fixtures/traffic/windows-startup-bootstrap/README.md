# Windows startup bootstrap acceptance

This explicit fixture prepares inputs for Core's production startup lifecycle
and embedded UI/Desktop/launch providers. It registers only a built GUI and its
ordinary test consumer; no external Adapter or replacement Host is installed.
The selected Windows image must match Core's reviewed profile. This structural
migration has not been revalidated on Native.

1. Build Core's `codlet-desktop-acceptance` binary with the `desktop-acceptance`
   feature, Core frontend modules, and the separate GUI consumer.
2. From Core, run `node codex/tests/fixtures/traffic/windows-startup-bootstrap/prepare.mjs NEW_ABSOLUTE_OUTPUT ABSOLUTE_BUILT_GUI_DIRECTORY`.
3. Fill the reviewed app directory, package version and Core binary paths in
   `config.example.json`. Set `disposableWindowsHost:true` only on a disposable
   VM/CI host. A fresh profile does not isolate machine-wide sandbox setup.
4. Run Core's `scripts/desktop-acceptance.mjs` with that config. Use a fresh
   `root` for every run; repeat with `fixtureWebSocket: true`.

The harness uses separate profiles, synthetic credentials, loopback servers and
an ordinary interceptor plugin. Desktop fetch/upload requests and two model
turns must observe modified requests and responses. WS must exercise prewarm,
server frames and continuation. The HTTP fixture rejects the initial WS upgrade
with 426 and verifies fallback.

`guarded-main.cjs` is retained as a historical research fixture and is exercised
by `bootstrap_fixture_guard.test.mjs`. The preparer no longer bundles it into an
external launch provider: Core owns the actual source. Its unit result does not
prove that a current Native launch blocks sandbox setup. Never use this harness
on a daily machine, with a real account or with an existing profile.

Inspect `probe.json`, `fixture.jsonl`, `core.err.log`, `completed.json` and
`verdict.json`. Both sources must activate, the probe must report acceptance,
Core must confirm restoration/debugger detach, and the owned processes must
exit. Verify the original image hash/signature separately. Native memory tests
also prove that the child sees the modified data followed by its original
value, with no debugger attached.

This is transport acceptance, not full GUI, installer, native sandbox setup or
real OAuth acceptance. Historical design and evidence remain in Git history;
new acceptance requires its own exact binary/profile/process receipts.
