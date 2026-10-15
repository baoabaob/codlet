# Client capability compatibility

Core owns compatibility with the selected Codex client. Ordinary plugins depend
on SDK APIs and declared capabilities, and do not supply Codex version ranges or
executable fingerprints. Application versions and complete-file hashes identify
observations; an unknown identity is not a failed interface contract.

## Backend admission

Before changing an owned app-server child's provider endpoints, Core identifies
the executable and uses a bounded helper to exercise `initialize`, `config/read`
and `account/read`. The helper returns only routing metadata. It never starts a
thread or turn, writes configuration, or requests a credential refresh.

An implementation with recorded routing evidence can use that evidence after
the live protocol checks. For an unlisted executable, a second read-only process
receives temporary loopback provider overrides. Every override needed for this
launch must appear unchanged in its effective configuration. Core rechecks the
file digest before launching the actual child, binding the result to the same
file that was probed. A failed contract leaves that child's original launch intact.

The SDK's `context.codex.traffic.create()` and `probe()` use Core's live
`owned-backend-provider` source capability. The optional historical fingerprint
argument and `fixtureVerified` result remain for older consumers, but do not
authorize or prohibit registration.

## Desktop source contracts

Core observes original CommonJS source identities and top-level class bindings.
It also captures the entry module's paused lexical frame: that module has already
been compiled before the observer is installed. Capturing it does not run Native
initializers or open another application connection.

Recorded source mappings are a fast path. Unlisted modules can provide network,
desktop fetch, Stdio and connection hooks when unique live classes satisfy the
method contracts used by the integration. These checks cover policy delegation,
the final Electron network call, JSONL writes and account-update handling. Class
names, bundle filenames and unrelated source changes are not admission criteria.
Ambiguous, missing or replaced bindings disable their associated source. Native
policy and authentication still execute through the original methods.

Renderer discovery separately checks the live router, mounted components and
existing backend connection. A failed traffic source does not suspend Core's
Desktop renderer provider or plugins that use its independent read/write APIs.
Holding `traffic.intercept` permission does not make traffic a required startup
dependency. External source providers still suspend their explicitly declared
dependents when those providers cannot start.

## State changes and verification

Source replacement snapshots the previously active source IDs. A candidate that
loses one of those capabilities fails activation and rolls back; partial startup
availability does not permit silent capability loss during an online update.
Owned processes, authorization and package integrity checks remain separate from
these interface checks.

Regression coverage includes unknown file identities, changed files after a
probe, missing protocol methods, ignored overrides, renamed source classes,
ambiguous hooks, independent capability failure, and a real inspector-paused entry
module. `scripts/verify-backend-contract.mjs` runs the production contract probe
against an explicitly selected backend with a fresh synthetic profile.
`scripts/verify-backend-auto-launch.mjs` exercises the actual spawn hook and reads
the resulting overrides from that backend; its route service is a local stub.
`scripts/verify-native-source-contracts.mjs` checks extracted method contracts.
Release
acceptance must also launch the production Core and exercise its automatic source
path; an explicitly injected fixture source is not evidence for that path.
