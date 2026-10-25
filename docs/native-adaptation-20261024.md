# Native build 21828 candidate adaptation

The signed Windows package is `OpenAI.Codex_26.1021.3705.0_x64__2p2nqsd0c76g0`,
app `26.1021.31345`, build `21828`. The downloaded package and both OpenAI
executables pass Authenticode verification. Package SHA-256 is
`0024ecd081b1187c51de45e983dc3e0bfb3b923faea7526ef2233c9ec8e8b7ac`; ASAR SHA-256
is `04862a659c6a90fc50514d8c0b8016709d97dece58839726c57495ed72f1d9f0`.

Core rc.17 includes the rc.16 child-task identity and workspace-selection fix.
The new Native source requires these additional adaptations:

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
- The navigation tooltip uses `content` and `openDelay`; its mounted component
  contract is checked before adapting the existing plugin-facing props. Sidebar
  groups and page headers are discovered in the referenced primary module. The
  new-conversation hook recognizes Native's current draft/navigation contract.
- Shortcut settings moved out of the initial asset's dependency list. Discovery
  follows the current Native entry to its main/settings route graph before loading
  the verified settings wrapper.

Core rc.17 also separates Native traffic from the Core update ledger and removes
the renderer update queue for Native requests. Core receipt exhaustion or an
uncertain update defers Core work without blocking Native. HTTP, backend-send and
restart preparation failures cannot invent a Native rejection; fallback occurs
only before the original operation has been dispatched. Explicit plugin hooks
and Native's own network policy continue to apply.

The first corrected VM candidate exposed a separate startup lease timeout while
Native was loading modules. Lease acquisition now uses the caller's existing
startup deadline rather than a shorter ten-second deadline within that startup.

The official update bridge uses entry `index-340508751504.js`, AppScope `Bst`,
services `Qot` and update selector `sHt` under the exact app/build identity above.

Source verification passes all 27 workspace checks, 15 Desktop checks and the
four main-process network/fetch/stdio/connection class contracts. The adapter
suite passes 456 tests with two optional skips; the final shortcut boundary
change also passes its 12 targeted tests and the actual-source workspace checks.

The targeted Rust close/cancel restart test passes. Native continuity checks
cover 300 consecutive failures, a full held Core ledger, hook retirement,
unknown update outcomes and pre-dispatch fallback. Detailed source evidence is
in [Desktop contracts](native-desktop-21828.json) and the
[official update mapping](native-official-update-21828.json).

Source checks do not execute Native modules. The signed package is installed in
the disposable VM. Its first UI acceptance exposed the tooltip and primary-module
changes above; the corrected candidate is awaiting the final VM check. It is not
yet listed as tested in the compatibility catalog or published as a release.
