# Native build 21828 candidate adaptation

The signed Windows package is `OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0`,
app `26.1021.31345`, build `21828`. The downloaded package and both OpenAI
executables pass Authenticode verification. Package SHA-256 is
`0024ecd081b1187c51de45e983dc3e0bfb3b923faea7526ef2233c9ec8e8b7ac`; ASAR SHA-256
is `04862a659c6a90fc50514d8c0b8016709d97dece58839726c57495ed72f1d9f0`.

Core rc.17 includes the rc.16 child-task identity and workspace-selection fix.
The new Native source requires four additional adaptations:

- The local navigation action is now a rest-argument delegate to the existing
  mounted navigation bridge. Its decoder verifies the forwarding function body;
  the earlier seven-argument location-key dispatcher remains supported.
- Shortcut query keys and their derived state initialize in separate functions.
  Discovery follows bounded lexical key references, rejects shadowed keys and
  competing writes, and ignores identifier substrings when enforcing its limit.
- The permission converter accepts an optional fourth profile argument. Three-
  and four-argument versions are recognized; other signatures remain unsupported.
- Working-state publication moved into the primary module. The exact reviewed
  asset set is initial `438d1df57f70`, shared `955d52676f9c` and primary
  `844e405f2b90`. The selectors are `hRn`, `pRt` and `_E`. Async input now carries
  a question key while retaining its nonblocking state.

The official update bridge uses entry `index-340508751504.js`, AppScope `Bst`,
services `Qot` and update selector `sHt` under the exact app/build identity above.

Source verification passes all 27 workspace checks, 15 Desktop checks and the
four main-process network/fetch/stdio/connection class contracts. The adapter
suite passes 456 tests with two optional skips; the final shortcut boundary
change also passes its 12 targeted tests and the actual-source workspace checks.

The optimized desktop acceptance executable builds successfully. Its SHA-256 is
`c2918b1e4912b0113862cd48d4843ef796f0f3f4f4b26b7176e57bc1112673f5`.
The targeted Rust close/cancel restart test passes. Detailed source evidence is
in [Desktop contracts](native-desktop-21828.json) and the
[official update mapping](native-official-update-21828.json).

Source checks do not execute Native modules. The candidate is awaiting disposable
VM installation and interaction acceptance. It is not listed as a tested Native
version in the compatibility catalog and has not been published as a release.
