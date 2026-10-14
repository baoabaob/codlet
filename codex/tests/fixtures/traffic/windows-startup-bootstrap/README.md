# Windows startup bootstrap acceptance

This fixture exercises the production Core before-resume phase and the ordinary
Desktop Adapter. There is no experimental native helper or alternate launch
provider. The selected Windows image must match the Adapter's reviewed profile.

1. Build Core's `codlet-desktop-acceptance` binary with the `desktop-acceptance`
   feature, and build the official plugin bundles.
2. Run `node tests/fixtures/traffic/windows-startup-bootstrap/prepare.mjs NEW_ABSOLUTE_OUTPUT`.
3. Fill the reviewed app directory and Core binary paths in `config.example.json`.
4. Run Core's `scripts/desktop-acceptance.mjs` with that config. Use a fresh
   `root` for every run; repeat with `fixtureWebSocket: true`.

The harness uses separate profiles, synthetic credentials, loopback servers and
an ordinary interceptor plugin. Desktop fetch/upload requests and two model
turns must observe modified requests and responses. WS must exercise prewarm,
server frames and continuation. The HTTP fixture rejects the initial WS upgrade
with 426 and verifies fallback.

Only the fixture main bundle adds `guarded-main.cjs`: it blocks the official
client's unrelated `windowsSandbox/setupStart` RPC before it can install OS
components. It logs only a blocked marker, never request content. All traffic
sources and startup phases use production implementations. This guard is absent
from the released Adapter. Never use a real account or existing profile.

Inspect `probe.json`, `fixture.jsonl`, `core.err.log`, `completed.json` and
`verdict.json`. Both sources must activate, the probe must report acceptance,
Core must confirm restoration/debugger detach, and the owned processes must
exit. Verify the original image hash/signature separately. Native memory tests
also prove that the child sees the modified data followed by its original
value, with no debugger attached.

This is transport acceptance, not full GUI, installer, native sandbox setup or
real OAuth acceptance. See [the design and evidence](../../../../docs/spec/windows-startup-bootstrap.md).
