# Core-owned Native research tools

These six tools were transferred from `baoabaob/codlet-plugins` commit
`dcdf5166ba10acb54086f95ac28fefed556b560e`, with dependency/report paths adjusted
for Core ownership. They retain their reviewed hashes, exact-child checks and
synthetic loopback scope. Transfer and unit checks do not constitute a new Native
or platform acceptance result.

| Tool | Purpose |
| --- | --- |
| `inspect-pe-image.mjs` | Compare signed PE images for acceptance evidence; runtime admission still pins the whole file. |
| `process-identity.mjs` | Pure creation-time and parent/child identity helpers, also used by preserved workspace probes. |
| `verify-owned-main-handshake.mjs` | Exact owned-child handshake against Core's embedded Desktop provider. |
| `verify-official-main-owned.mjs` | Explicit owned official-main research using the Core traffic fixture. |
| `verify-plaintext-backend.mjs` | Explicit synthetic backend HTTP/SSE/WebSocket and task-routing checks. |
| `verify-plaintext-desktop.mjs` | Historical exact-child Desktop plaintext probe. |

Install dependencies once from the Core root with `npm ci --prefix frontend`;
build Core sources with `node frontend/build.mjs`. The tools use that dependency
installation and Core-owned `codex/host`, `codex/bundled` and fixture paths.
Reports go to `.codlet-artifacts/native-tools/request-chain/` under Core.

Native runners require explicit `--run-owned yes` and absolute executable paths.
Windows Native runners additionally require
`CODLET_TEST_DISPOSABLE_WINDOWS_HOST=1` on a disposable VM/CI host: an isolated
`CODEX_HOME` alone does not isolate machine-wide sandbox setup. Do not set this
flag on a daily machine. Backend acceptance may use a sandbox mode appropriate
only to that disposable synthetic fixture. No tools, real credentials or daily
sessions should be supplied.

`.github/workflows/windows-backend.yml` is dispatch-only. It downloads and
verifies the explicitly pinned official binary on an ephemeral Windows runner;
moving the workflow does not trigger it. The default `node codex/test.mjs` runs
unit/VM tests. Official backend turn tests remain skipped unless their explicit
environment opt-in is provided.

Core's dispatch-only `.github/workflows/verify-macos-traffic.yml` takes one exact
`core_commit`, builds Core's frontend and traffic engine, and invokes these tools
from Core. It retains the source-reviewed official ZIP, signing identity, bundle
names and SHA pins; it does not check out or build the plugins repository. The
runtime version comes from `runtime/node-runtime.json`, including the macOS
platform override. Reports use the `macos-*` paths below the same ignored report
directory. These are opt-in Native diagnostics; editing the workflow or checking
its paths does not establish a new macOS result.

The account-free independent CUA Node check is separate:
`python3 tests/verify_mac_client_node.py --archive ABSOLUTE_REVIEWED_ZIP`
validates the exact official Node/signature and Core's embedded Desktop provider,
then Core-owned Host tests. Its optional `--export-runtime NEW_DIRECTORY` copies
only the validated runtime and license. It has no plugins-repository argument.
