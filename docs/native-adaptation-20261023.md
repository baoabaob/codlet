# Native builds 21421 and 21477 adaptation

Core 1.0.0-rc.14 targets the signed Windows package
`OpenAI.Codex_26.1016.8622.0_x64__2p2nqsd0c76g0`, app `26.1016.62342`,
build `21477`. The official production update manifest advertised this package
on 2026-10-23. Its MSIX SHA-256 is
`9085cf2e2eb5081f894a2cf334e1f36dbb9438ecb409d20195aa2fe1ecfcb4c8`;
the ASAR SHA-256 is
`a05dfd86ca508148c83c25590639cf91a52c6647733cdf200723d85357052b49`.
The package signature and both OpenAI executable signatures verified successfully.

The Store update offered to the current installation is package
`26.1016.8120.0`, app `26.1016.61520`, build `21421`. Core also maps this
intermediate version explicitly. Its staged ASAR SHA-256 is
`760eae730e57438a0693cab4aba5ed8b7eb0ea1c5b7a7dc26dd0e84c2398810f`,
matching the package used by the preceding VM acceptance run. Its OpenAI image
signature verifies successfully. Keeping both mappings covers the Store and
direct-update rollout paths without assuming that their advertised versions agree.

The preserved source snapshot contains 15,010 files. Relative to build 21161,
the main-process source files are byte-identical, while renderer asset filenames
have changed. The workspace index covers 269 modules with no missing imports in
its selected dependency closure. All 28 workspace roles are located and all 27
Core source-decoder checks pass. The role diff maps 44,853 lexical bindings;
unresolved external dependencies remain unresolved rather than being promoted
to a whole-program equivalence claim.

Two exact mappings change in Core:

- Working-state selectors now recognize the pair
  `app-initial-ad16eaadf81f.js` / `app-shared-2feb3d4c6fcc.js`. The response,
  pending-input and publication exports remain `NCn`, `pCn` and `JQ`. Their
  reviewed normalized shapes and lexical AppScope relationships match. Before
  adding this pair, the three selector checks fail as unreviewed; afterward all
  15 Desktop scope, permission and Working checks pass.
- The official update bridge now matches app `26.1016.62342`, build `21477`,
  entry `index-525daf5f2209.js`, and the new initial/shared asset pair. Source
  analysis uniquely resolves the update state, AppScope and install service.
  Runtime checks still require the exact observed entry and existing AppScope.

Build 21421 passes the same 27 workspace and 15 Desktop source checks. Its
reviewed asset pair is `app-initial-83973da15da9.js` /
`app-shared-efae91d19fbd.js`, with entry `index-114b01fbb27e.js`. Working exports
remain `NCn`, `pCn`, and `JQ`; update bindings remain `Qst`, `ist`, and `gDn`.
The three Working roles were unreviewed before adding this separate mapping.

Evidence: [Desktop contracts](native-desktop-21477.json),
[official update mapping](native-official-update-21477.json), and the local
workspace verification and binding comparison under
`D:/codlet-vm-lab/native-release-20261023`.
The intermediate Store version has its own [Desktop report](native-desktop-21421.json)
and [update mapping](native-official-update-21421.json).
Source analysis executes no Native module. Desktop operations are recorded
separately in the [rc.14 release validation report](releases/1.0.0-rc.14/validation.md).

This release also integrates the startup, backend-policy preparation,
event-delivery and plugin readiness corrections verified in the
[2026-10-22 acceptance run](core-acceptance-20261022.md). Split Workbench rc.4
starts Desktop preparation after renderer activation and cancels that work when
its generation retires.
