# Explicit Native acceptance drivers

Core owns the historical `build-probe.mjs` Native bootstrap and the read-only
`probe.js` report sampler. They are test tools, not an installable plugin or a
second implementation of the full functional consumer.

The maintained consumer, package builder, permissions and current usage live in
[`codlet-plugins/tests/fixtures/runtime-compatibility`](https://github.com/baoabaob/codlet-plugins/tree/main/tests/fixtures/runtime-compatibility).
Use that repository's `consumer/` or its generated package. The obsolete Core
copy of the consumer and package builder was removed; the original import can
still be recovered from Core Git history and `codex/PROVENANCE.json`.

`probe.js` samples the consumer's public acceptance symbol. To bundle the
historical driver from the Core root, after installing Core frontend dependencies:

```text
node codex/tests/fixtures/runtime-compatibility/build-probe.mjs ABSOLUTE_PROBE_JS
```

The generated driver can create one synthetic task and seed turn through an
already identified Native connection when an explicitly owned loopback fixture
enables `autorun`. It must only be used with a fresh owned profile and verified
process/target identities; never inject it into a daily client. It does not
authorize a second AppServer connection or replay failed/unknown writes.

This driver was inherited from earlier acceptance research. Its transfer into
Core and successful compilation do **not** establish a new Native acceptance
result. In particular, the v1 final G run used its own controlled probe and
retained Core route; it did not revalidate this historical driver. Older results
and limits remain available in Git history. Use the current Core owned-launch
preflight and its exact run receipts for new acceptance work.
