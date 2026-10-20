# 1.0.0-rc.8 startup and update checks

Review date: 2026-10-20. Windows candidate with optional GUI **1.0.0-rc.4**.

## Changes

- Launch uses the verified local plugin packages. The existing runtime-owned
  background checker performs one read-only scan after readiness. The duplicate
  prelaunch download/install path and its checkpoint are no longer used.
- Backend policy discovery uses asynchronous, read-only child requests. Native
  starts with its original arguments while discovery runs. A verified policy can
  be applied through an idle Native connection's normal reconnect operation.
  Pending requests and active/starting turns prevent that reconnect, including
  work that starts while policy discovery is in progress. Policy results are
  scoped to the launch inputs, consumed on use and expire after ten seconds.
  Retirement cancels and waits for owned probe children.
- Desktop startup readiness can recover after the first 30-second wait. Only
  transient readiness errors retry, with delays capped at ten seconds; schema
  drift remains a terminal error. Retirement cancels retries, and successful
  readiness stops probing.
- Public GitHub metadata reads retry a transport failure once after 500 ms,
  within one total 20-second deadline. Repository identity plus release discovery
  share a 30-second per-repository budget. HTTP permission/not-found errors,
  rejected redirects and invalid metadata do not retry. TLS validation remains
  enabled. Asset downloads retain their existing behavior.
- The GUI displays each failed plugin's actual update error, hides stale errors
  during a retry and discards errors belonging to replaced package versions.

## Observed network failure

The installed GUI receipt names `https://github.com/baoabaob/codlet-gui` as its
update channel. The development repository `codlet-plugins` is a different source.
Repeated queries to the actual channel failed in the installed rc.7 Core.
An independent Windows Schannel curl request through the configured
`127.0.0.1:7897` proxy reproduced the failure: CONNECT returned HTTP 200, then
the TLS handshake failed before an HTTP response from GitHub.

This establishes a failure on the current proxied GitHub connection, not a
missing release or a plugin execution error. It does not identify whether the
proxy's upstream route or the remote connection ended the handshake.
The rc.8 release CLI later queried the same channel successfully. Its newest
public GUI release was `v0.1.9`, older than the locally installed `1.0.0-rc.3`;
successful checking therefore does not offer an upgrade to that public version.

## Verification

- Node 24.21.0: complete Core/Codex suite, **745 passed, 3 skipped**; complete GUI
  suite, **128 passed**. Later targeted recovery checks cover the final policy
  cache key and idle reconnect behavior: **29 passed**, including three repeated
  cold boots of the packaged source with an owned synthetic client.
- Rust `cargo test --locked --features test-fixtures`: **816 passed, 8 ignored**.
  The production library also passed all **555 tests**. A production CLI migration
  test was blocked by executable-identity checks against the already-running
  installed rc.7 Core; the isolated suite does not share its control namespace.
- Frontend typecheck and strict Clippy for all targets with test fixtures passed.
- Windows MSI structure checks, actual installer Chinese/English self-tests and
  all **38 distribution payload hashes** passed. The self-tests verified the
  embedded MSI digest and performed no installation.
- Actual Native cold-start timing and account-dependent recovery have not been
  remeasured in this candidate. The running user session was retained. The full
  Windows desktop acceptance harness requires a disposable host because fresh
  sandbox setup can change machine-wide Windows state.

Reports are retained under `.codlet-artifacts/startup-resilience-20261020/`.
The previous rc.7 launch took approximately 22 seconds to show its window,
including approximately five seconds in the removed prelaunch network check.
Those observations are a baseline, not a measured rc.8 startup result.

## Distribution

GUI source: `baoabaob/codlet-plugins@5ea5155928894e33b101ce9c4f9d249139306d7d`.
Package: `codlet-gui-1.0.0-rc.4.zip`.
SHA-256: `69f98dd20323b182ac8d1ef5416b70048c52755fb57308ec721d7186d438efa9`.

Core source: `baoabaob/codlet@e3460bf0cd654b13012aee3f1d90c76352b4dc0a`.

| Package | Bytes | SHA-256 |
| --- | ---: | --- |
| `Codlet-1.0.0-rc.8-windows-x64-setup.exe` | 8,482,304 | `a49470c52930f60e813ec53ee5ea9ffc66f2ad0becce4bc2211cc5c16636d28d` |
| Internal MSI | 8,400,896 | `e80d222bb19fce630ad3d0c801f3ed2611a582ac90759dcaf5600b66bd3048b6` |

The Core executable SHA-256 is
`ef0c793d69b0861f4fe938928392c9dd2cf1284659780dbb63872ee3bb0102dd`.
The installer is unsigned. Packages and verification receipts are under
`.codlet-artifacts/startup-resilience-20261020/windows/`.
This candidate has no new macOS package or public release.
