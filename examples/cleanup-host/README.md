# A persistent host plugin with explicit CDP cleanup

This package keeps one raw CDP session and a generation-specific JavaScript global
alive until the plugin is disabled or reloaded. `deactivate(cleanup)` removes its
own global and detaches its session. It uses no renderer entry or official adapter.

```powershell
codlet plugin add .\examples\cleanup-host --trust --grant host.process --grant cdp.raw
codlet plugin enable example.cleanup-host
codlet plugin reload example.cleanup-host
codlet plugin disable example.cleanup-host
```

The running Codlet session supplies the same managed JS runtime as other host
plugins. `settings.json` may specify `targetId` and a `report` prefix; by default
the example stores no reports. It selects the first available target if no ID is
set and fails initialization if no target exists yet.

At shutdown, the ordinary `activate` context and its subscriptions are retired.
Use the `cleanup` argument rather than a saved `context.cdp`. Cleanup receives a
separate abort signal and at most 1500 ms total, including transport and all
requests; calling again cannot renew this budget. The Core permission checks are
unchanged, and native process/Job/IO retirement is still required before reload
starts another generation.

The example can remove only the state it deliberately owns. A detached target,
unresponsive CDP peer or exhausted deadline can prevent page cleanup; Codlet does
not promise automatic rollback of arbitrary plugin effects or a safety sandbox.
See [the cleanup contract](../../docs/spec/host.md) and
[the TypeScript declarations](../../types/host.d.ts).
