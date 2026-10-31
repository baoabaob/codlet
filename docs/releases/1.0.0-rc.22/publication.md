# 1.0.0-rc.22 publication

Published on 2026-10-31 as a Windows x64 **preview prerelease**:
[Codlet 1.0.0-rc.22](https://github.com/baoabaob/codlet/releases/tag/v1.0.0-rc.22).
GitHub release ID is `429609489`; its tag points to production source
`b32fc5e8e607a480f0b9c1ce1c788535eaed828f`.

The [fixed acceptance record](https://github.com/baoabaob/codlet/blob/59901adefe3fb8baac74a670ac14f4233852712f/docs/releases/1.0.0-rc.22/validation.md)
identifies the exact installed Core, actual rc.21 upgrade and maintenance,
Native/sidebar/Split checks, original update-network failure, successful new
Core check and execution boundaries. Desktop `0.2.22`, UI `0.1.19` and optional
GUI `1.0.0-rc.6` are included.

## Public assets

| Asset | GitHub ID | Bytes | SHA-256 |
| --- | ---: | ---: | --- |
| [Windows x64 setup EXE](https://github.com/baoabaob/codlet/releases/download/v1.0.0-rc.22/Codlet-1.0.0-rc.22-windows-x64-setup.exe) | 693849662 | 8,993,280 | `e05cfeb074d11b86694688b369c632fca150b5b47a9f4c710d3f1144485d48e6` |
| [Complete runtime ZIP](https://github.com/baoabaob/codlet/releases/download/v1.0.0-rc.22/codlet-runtime-1.0.0-rc.22-win-x64-portable.zip) | 693849766 | 9,965,790 | `6f2756c1f012259eaabe582e75613f44928bc754ac9ff9f7295d3682d5b76eee` |
| [Schema-1 preview catalog](https://github.com/baoabaob/codlet/releases/download/v1.0.0-rc.22/codlet-update-managed.json) | 693849825 | 561 | `b00e0b23b3a5eb6c65fc8b9f23bed87c5b7b6bf03e585c99b8bf1c49b9013109` |
| [Schema-2 preview catalog](https://github.com/baoabaob/codlet/releases/download/v1.0.0-rc.22/codlet-update-managed-v2.json) | 693849863 | 561 | `85bb02dcf36830b4e4710102c6d2835109bc5b9fd00a8d743614b964dd4d1c6b` |
| [SHA256SUMS.txt](https://github.com/baoabaob/codlet/releases/download/v1.0.0-rc.22/SHA256SUMS.txt) | 693849915 | 410 | `198c151125f57915b9182740442fa0f815df272b108bb6aa218ceb32356e7319` |

Both update catalogs select the complete runtime ZIP. rc.20/rc.21 MSI users
must save their work, fully quit the client and run setup directly. Setup
updates Codlet; the official client is updated separately through its existing
update process, then fully quit before launching through Codlet.

An anonymous request to the public setup URL returned HTTP 200 on
2026-10-31 at 00:19 UTC. The actual 8,993,280-byte download matched the setup
SHA-256 above. The reviewed release notes are 2,270 bytes with SHA-256
`acaa96e29e5ab57df4d946d6ed12bb5d4f9104ba6d61896c81a701f24d54beca`.

## Compatibility catalog

The fixed [public catalog](https://raw.githubusercontent.com/baoabaob/codlet/main/compatibility/tested-client-versions.json)
was independently published by commit
[`e3a560014c3ad2e90dbb3c1a2e67948ec46700d8`](https://github.com/baoabaob/codlet/commit/e3a560014c3ad2e90dbb3c1a2e67948ec46700d8).
Revision `2026103101` preserves seven historical entries and adds package
`26.1027.3384.0`, minimum Core `1.0.0-rc.22`, Desktop `0.2.22` and UI `0.1.19`.
Content blob is `21140a814c9e2b3cb0ee29ea5698a4349ec3c469`.

One anonymous read of that exact fixed raw URL returned HTTP 200, revision
`2026103101`, eight records and 4,011 bytes, with SHA-256
`29a358946c0d9b97fe96d452ac85028c66bed689aefb96e6f118c4396c98b918`.
It matches source metadata commit
`a32ece1d4fe7775f3b58d1e9e8dfbf0829da25d3`. The production binary retains its
compiled offline baseline `2026102801`; these metadata publications do not
rebuild the accepted payload.
