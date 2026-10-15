# Conversation permissions: producer and consumer contract

The implementation supplies the interface below for parallel consumer work. A candidate is not live acceptance: the production reader must return authoritative choices on a confirmed Native input, and the replacement lease must pass the bounded Native acceptance. No actual user permission was changed by the read-only investigation or synthetic tests.

## Data and authority

`PermissionSelection` is a structured choice, never a raw sandbox/approval policy:

```ts
type PermissionSelection =
  | { kind: 'agent-mode'; mode: string }
  | { kind: 'profile'; profileId: string }
  | { kind: 'server-default' };

interface PermissionSnapshot {
  threadId: string;
  hostId: 'local';
  revision: number;
  phase: 'loading' | 'ready' | 'unsupported' | 'error';
  selection: PermissionSelection | null;
  source: 'thread' | 'host-default' | 'unknown';
  options: readonly {
    selection: PermissionSelection;
    label: string;
    enabled: boolean;
    reason: string | null;
    requiresConfirmation: boolean;
    confirmation: PermissionConfirmation | null;
  }[];
  diagnostic: { code: string; message: string } | null;
}
```

Only choices actually produced by Native for the selected conversation may be submitted. The Adapter resolves labels, requirements, model restrictions, custom-profile availability and conversion using Native semantics. Unknown mappings are unsupported, not guessed from a translated label. The source distinguishes an explicit thread choice from a Native host default. No raw config, scopes, manager, callback or runtime workspace paths are exposed.

The Desktop Adapter extends its authenticated read/events/write capabilities with `permissions.get`, a `permissions.changed` event, and `permissions.update`. Reads require `codex.backend.read`; subscriptions use `codex.backend.events`; updates require separately authenticated `codex.backend.write` RPC. A UI workspace ticket alone does not authorize settings writes. The first implementation supports the strictly confirmed current local conversation and rejects an unconfirmed/mismatching identity. Writes additionally require a resumed conversation owned by this Native window; reads can inspect its confirmed follower. It does not navigate, resume background threads or open a new connection to satisfy a permissions request.

The main-world consumer first calls `context.rpc.request({name:'codex.backend.write',api:1,scope:'target'},'getApi',{})`. Its `{api:1,symbol:'codlet.codex.desktop.v1',ticket}` descriptor identifies `globalThis[Symbol.for(descriptor.symbol)]`. Call that object's `registerPermissions(context,descriptor.ticket)` once with the live consumer context and its single-use write ticket. It returns a synchronous `dispose():void` function and registers `context.onDeactivate`. Keep this registration for the plugin generation, independently of workbench exit and temporary UI leases. `permissions.update` still travels through the write RPC and matches its immutable caller to the registered plugin ID/generation. Explicit registration disposal, owner retirement and Adapter retirement revoke its identities; a new generation requires a new write ticket. There are at most 32 owners and 256 registered thread identities; no policies are stored in these registrations.

`permissions.get({threadId,hostId?:'local'})` returns `PermissionSnapshot`. Native changes push `{type:'permissions.changed',threadId,hostId:'local',revision}` through the existing event mechanism, with its normal event cursor. The event intentionally carries no full snapshot: consumers coalesce matching thread events into one `permissions.get` refresh. Consumer rerendering does not require a polling loop. The producer removes its listeners when the authenticated owner retires.

`permissions.update({threadId,hostId?:'local',selection,expectedRevision,confirmed?:boolean},{signal?})` validates the current selection, authoritative ready options and supplied revision before conversion and immediately before dispatch. It reserves that thread before its first asynchronous read, converts through Native and uses the existing manager's per-thread settings update path. It changes no host-default preference. A stale revision/selection, unsupported conversion or required-policy mismatch rejects before a write. A `requiresConfirmation:true` choice requires an explicit consumer confirmation and `confirmed:true` for that same thread/revision. Cancelling the confirmation makes no write. Switching threads or changing the revision invalidates the dialog.

Native Legacy Full access opens its actual `Ht` confirmation before applying the choice. Its option therefore carries `{kind:'native-full-access',title,body,capabilities:string[],risk,modelWarning:string|null,confirmLabel,cancelLabel}`. Text comes from the corresponding Native `composer.mode.agentMode.fullAccessConfirm.*` messages with checked fallbacks. `capabilities` preserves file deletion/upload, terminal/software/system changes, and websites/data/plugins; `risk` preserves sensitive-data exposure/loss and prompt injection. Native's model classifier preserves the stronger Cyber/daybreak warning and recommendation. If the current Native model cannot be proved, that option stays disabled. The consumer displays this descriptor through Core UI rather than guessing from the mode string. No Native confirmation is added to choices that have none.

```ts
interface PermissionReceipt {
  threadId: string;
  hostId: 'local';
  selection: PermissionSelection;
  status: 'confirmed' | 'staged';
  revision: number;
}
```

`confirmed` requires a verified acknowledgement and Native read-back of the requested thread setting. `staged` means Native accepted the setting for its existing next-turn path without a confirmed server setting update; it must not be presented as durable remote persistence. Cancellation before dispatch makes no write; cancellation after possible dispatch reports `outcome_unknown` rather than success. Native submission must consume the updated per-thread setting without overwriting it with the old host default. That submission path is part of implementation acceptance, not merely a display check.

The send guard covers only registered local `thread/resume` and `turn/start`, at the final existing postbox dispatch after other Adapter hooks. It waits for Native's pending settings update and reads Native's latest canonical settings at that moment. It modifies only permission fields; approvals and other threads pass through. The guard retains only owner/thread identities through workbench exit, allowing the latest explicit Native permission choice to win. Any error after the update may have run—including selection loss or read-back failure—reports `outcome_unknown` and retains the live owner's guard. A successful `completed` lifecycle for the matching started `thread/settings/update`, plus read-back, is required for `confirmed`; unrelated/error acknowledgements cannot claim persistence. The producer keeps one current snapshot, returns fresh DTOs, and emits identity/revision events without caching menus for visited threads.

A read never registers or changes an unmodified thread. Before an explicit API update, the snapshot follows the actual existing Legacy submission inputs: with `shouldSendPermissionOverrides:true`, Native's current `agentMode`/`permissionProfileId`; with false, `{kind:'server-default'}` and `source:'unknown'`, displayed as the existing conversation default. It never silently adopts a different historical canonical policy. After an explicit update, the live registration makes the canonical snapshot and final dispatch agree. Native's `Tta` carries these three submission inputs; `Ata` only creates Legacy policy overrides when the override flag is true. The consumer must support the server-default read baseline without treating it as a new write choice. A resume attempted inside this same pending settings lifecycle fails with `permissions_busy` rather than waiting on itself.

An unregistered Legacy baseline always uses `source:'unknown'`, including when its effective value happens to equal the canonical value: equality alone does not prove independence. An explicit same-choice click can therefore establish the per-thread guard; `source:'thread'` is reserved here for the registered canonical path. Registration removal invalidates the current snapshot so other live consumers do not retain the old source.

Permission events compare a small current Native settings/model stamp and observe only Native permission-control commits. Streaming text updates, editor text and owned Core controls do not resample the picker. Observers and subscriptions end with the provider; public event callbacks end with their authenticated consumer. There is no polling timer or per-panel policy cache.

## Temporary UI replacement

`session.acquireComposerControl({control:'permissions',threadId})` returns an owner-scoped `{container,ready,updateBinding,dispose}` lease. The container is the consumer's Core UI mount point near the strictly bound current Native permission trigger. The lease reversibly masks/disables that trigger; it does not detach/rebuild the editor, copy its draft or modify permission values. Native unrelated model, attachment and send controls remain usable.

`updateBinding({threadId:null})` masks unconfirmed permission contents during navigation; the consumer disables its own control. A confirmed local ID rebinds only after Native input ownership agrees. Native DOM replacement moves/reconciles the owned container through the normal event lifecycle. `dispose()` and owner retirement remove the container/listeners and restore still-owned Native styles/attributes using a journal. The consumer separately unmounts its Core UI root. No window-caption or panel-layout policy belongs to this lease.

The consumer owns the control's placement inside its layout, selected/pending state, menu interaction and the necessary staged/unknown feedback. The Adapter owns Native discovery, normalized options/conversion, authenticated per-thread dispatch, lifecycle and its own performance checks. Neither party initializes all cached thread policies or maintains a per-panel permission cache in the Adapter. Other suitable Core capabilities may still be used directly.

## Implementation gates

The live legacy picker has been proved to bind the correct current conversation. It also writes host defaults, so the consumer replaces the small control instead of forcing experimental flags or undoing global writes. The reader follows its committed input branch and uses Native's pure option reducer/converter/wire mapper and actual menu visibility/disabled state. Config inputs must agree semantically; bounded existing Windows requirements and Native cwd/thread roots are required. Multiple cached model names are accepted only when their Native confirmation classifications are equivalent and none is pending; automatic-review restrictions still come from the unique current Native agent record and actual menu disabled state. Missing or conflicting inputs return unsupported/loading, never guessed policies. `server-default` can describe an unmodified read baseline but is not currently offered as a Legacy write option. The implementation is under finite read-only Native preflight; synthetic send/owner/cancellation tests do not certify an actual permission change or persisted real turn.
