# 1.0.0-rc.24 validation

Core rc.24 adapts Windows x64 to official Native package `26.1103.3517.0`,
app `26.1103.31037`, build `25241`, with App Server `0.167.0-alpha.3.2`.
It includes Desktop `0.2.23`, UI `0.1.21`, and optional GUI `1.0.0-rc.7`.

## Native changes

The renderer changed from Vite's initial/shared modules to Rspack. Discovery
binds the current entry's module cache to the mounted `__codexRoot`, selects
Native's actual React root creator, and follows lexical imports and export
identities. Factory parsing is lazy. Retiring an unrelated cached module does
not retire selected services; replacing a selected module or export does.
Cancellation stops lazy work before module initialization.

The adapter resolves the current navigation signal, page shell, notification
dispatcher, working selectors, permission hook, transcript, composer, viewport
and shortcut query/registry. Opaque proxies cannot claim page-shell properties.
Permission input cache slots belong to the object consumed by the hook, before
the compiler reuses that temporary for other values.

Native removed `getCachedThreadMetadata`. On its explicit missing-method
response, the adapter reads `getThreadListSummary` for the requested identities
and verifies their thread and host. It does not read full conversations to
enumerate metadata. Other failures remain errors.

The reviewed ASAR SHA-256 is
`3ec8607192a18734a2800e0c1690bf1c6f901de61ff908e75e90ea88fe7dc37b`.
The complete source snapshot includes 9,416 files, including Rspack's async
directory. Native source files remain outside this repository and distribution.
The [isolation review](../../native-isolation-26.1103.3517.0.json) records the
17 checks and exact main-process source identities. The Windows bootstrap
recognizes the signed `chrome.dll` hash
`afc20f0ec82644138c54889255a019a35cecb5c2d9414b0a60d7ac7ae6454dfd`.

## Automated checks

- Complete Codex suite: 666 passed, two opt-in tests skipped.
- Native source and owned-run checks: 17 passed.
- Rust lab checks: 39 passed; formatting passed.
- Compatibility catalog refresh, cache and version-selection checks: 17 passed.
- Online package/release checks: seven passed.
- Publisher tests and native installer self-tests passed. Installer checks
  exercised Chinese, English and automatic language fallback, window layout,
  feature selection, payload checking and cancellation without installing.

## Production distribution

The production executable was built from
`2a6fe2ad1847d9e5eaad4a037e44434b0580ebfb` with the release profile and default
features disabled. It is distinct from the acceptance executable below.
Both adapter bundles, the Desktop host entry, Core UI SDK and client-source
runtime were found byte-for-byte in this executable. All 39 portable and 39 MSI
manifest payload records matched. The ordinary executable passed distribution
setup checks, including optional GUI installation, repeat setup, disabled and
revoked preferences, and removal. The MSI structure check passed without an
installation transaction.

| Artifact | Bytes | SHA-256 |
| --- | ---: | --- |
| Core executable | 27,236,864 | `163e529245d4cf296061d2bbb0f9f55ae0d7b26ab79c19383723cf1c868d8377` |
| Windows setup | 9,038,336 | `6013ab396505ee8f53b59bc60e4e2f280d20cecd5ea8f8b0d0b9aa35557717fa` |
| Windows MSI | 8,941,568 | `44f5a4a82d90b3551e153324a6642d1777df4f144af50a62c29d3b912b7006b0` |
| Portable runtime update | 10,057,514 | `933357223b34a636897b49dd2cc79102543878da5fae1bd221f83af41a6856b9` |

The GUI archive matches the published rc.7 digest and its Ed25519-signed update
feed. No private plugin or Native source snapshot is part of the release.

## Actual Windows Native acceptance

Run `core-13d42176-dc1e-4974-8b22-0ea9863deae1` used the acceptance build with
SHA-256 `8e067ab55b25bdbb02e4fd5bf93214d6c0956f786f57526366e17cb8222ca6fd`.
It used fresh homes, a dedicated official backend, synthetic credentials and a
loopback Responses fixture. Windows sandbox mode was unelevated. Process
creation identities and the owned renderer target were verified before plugin
operations. The normal user client remained a separate process.

The functional plugin's read-only run completed with no failed checks. It
verified management/resources, desktop reads, all six workspace interfaces
and the attached desktop main HTTP source. The external backend provider route
was unavailable in this harness and is not claimed as exercised interception.

The resident acceptance checks passed:

| Operation | Observed result |
| --- | --- |
| Native draft and send | The owned draft was submitted once to the local fixture |
| History | The completed task exposed its turn and both user/assistant items |
| Permissions | Current snapshot was ready; Native's Full access confirmation was retained |
| Working state and events | Idle → working → idle around a second completed fixture turn; 31 events observed |
| Workspace preparation | Navigation, transcript, composer, shortcuts, viewport and action available |
| Transcript lifecycle | Mounted, reached readiness, followed latest, restored position and disposed |
| Shortcut lifecycle | Registered, read its snapshot and disposed |
| Independent viewport | Bound the task, changed width to 380 and closed |
| Page restoration | Opened the functional page with Native toolbar and restored the selected task |

The first history assertion incorrectly expected bodies in `turns.list`, which
explicitly requests metadata-only items. Its failed report is retained. A
diagnostic-plugin reload corrected the assertion to use `items.list` and
continued against the already completed task; the initial send was not repeated.
The final continuation completed all nine checks.

The final run and the preceding R4 run exited normally. Recorded process
identities and child processes were checked before removing their executable,
runtime, profile-home and plugin-cache copies. Reports, session JSONL and
databases were retained. Superseded lab stages were removed; generated workspace
artifacts were reduced to approximately 267 MB.

An earlier R4 functional run also verified composer action click/cleanup,
editable draft creation and Native page controls. Its broader Host resource
tests lacked explicit filesystem, executable and origin grants and failed;
they are not counted as successful operations. Source-only probes and earlier
candidate runs are separate from the final resident results.

This acceptance covers Windows x64 and a synthetic local backend. It does not
establish macOS/ARM64 support, real-account upstream traffic, an installed MSI
upgrade, arbitrary private plugin behavior, IME or attachment lifecycle, or
composer rebinding. The public composer rebind capability remains unavailable.
