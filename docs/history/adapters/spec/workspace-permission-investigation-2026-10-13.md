# Native composer permission ownership investigation

This is source evidence and a proposed boundary, not a completed permission fix or real-client acceptance. No actual user permission/default was changed during investigation.

## Three Native picker implementations

Installed Native archive metadata SHA: `6b993af172cfc4425644e357856706390067ea457bc76bc11d0d3d5905c3bab5`. Its `permissions-mode-dropdown-7bfb50f8e130.js` source SHA is `6fc4519756720d0ef951d99c6b26dbfc5c4a2ea63c3f9f2a5313d5754020f5d7`. The wrapper chooses an implementation using runtime context and a capability signal; the screenshot alone cannot identify the branch.

| Implementation | Existing conversation write | Default write |
| --- | --- | --- |
| Account Work picker (`Kt` in this source) | Sets the account/conversation keyed Work permission override through the Native setter. | Does not use the legacy agent-mode setter. |
| Permission-selection picker (`tn`) | Calls the existing manager's `updateThreadPermissions(conversationId, settings)`; Native resolves config/requirements and allowed selections. | Writes a host preference for a new input without a conversation ID. |
| Legacy picker (`yn`) | Calls the Native agent-mode hook; it updates the selected conversation's settings. Custom profile selection uses `updateThreadSettingsForNextTurn`. | Built-in modes also write `agent-mode-by-host-id` and `permission-selection-by-host-id`. Some choices additionally update the preferred non-full-access mode. |

Native's agent-mode hook derives display/submission behavior from thread-specific settings, resolved config, model requirements and host defaults. Consequently, a changing label on several conversations does not by itself establish that several backend thread policies were written. Conversely, correct current input ownership does not establish that a default-writing Native control meets the consumer's independent-per-conversation requirement.

The Adapter's current workspace implementation does not add a permission setter or write these host-default preferences. The consumer's live picker branch and actual conversation binding must be checked before identifying the root cause.

## Existing Native update route

The cached Shared source SHA is `a1daa891e89a395b8db399ff6eaa365f12a86880c3d8cf891caf4ccbcb9eebf5`. Its manager delegates `updateThreadPermissions` to a per-conversation serialized settings update. `applyThreadSettings` follows the existing owner/follower route, calls `thread/settings/update` when supported, updates Native `latestThreadSettings`, and can update the active turn's approvals reviewer. It uses the existing Native connection and contains no host-default preference write. Native explicitly handles older protocol support; a completed setter call alone is not a guarantee that every field was durably stored remotely.

The cached policy fields are in `getConversation(id).latestThreadSettings`, not necessarily on the conversation's top-level object.

## Minimal live evidence

`tests/fixtures/workspace-acceptance/native-permission-ownership-readonly.js` examines only the existing main input and already-mounted permission trigger. It returns the implementation category, committed ancestry and conversation/host equality booleans, plus the presence of selected cached policy fields. It does not return IDs, permission values, paths, messages, documents or drafts. It calls no setter or backend request and performs no navigation, focus or input operation.

The consumer should collect this during a naturally selected existing conversation in its current frozen sample. This separates a null/wrong conversation binding from Native default-writing behavior without changing real permissions for diagnosis.

The first live selected sample confirmed the main input's strict binding and cached policy presence but could not prove the trigger's DOM-attached React chain. It therefore did not identify the implementation. Subsequent counts found its actual host under the proven input's child links, while the host's return chain remained unproved. The helper now carries the actual child/sibling parent path from that already-proven input, without relying on descendant return pointers. It reports proof/category, source-role counts and truncation counts; unknown identity comparisons are null. The descendant boundary is 128 levels relative to that input and 2048 nodes, independently of the input's existing bounded ancestor proof. This does not raise the production host-discovery limits. Regressions cover detached/missing return pointers, a 256-level proven input ancestor chain, absent nearby attachments and unknown implementations. An unproved DOM attachment is not evidence of a wrong Native conversation binding.

## Interface boundary if an additional capability is needed

A generic per-conversation permission read/update capability could wrap the existing Native manager and normalize allowed settings, cancellation and acknowledgement. It should require the appropriate authenticated write authority, preserve Native requirements/model restrictions, avoid changing host defaults, and keep manager/scopes private. Readiness and unsupported cases must be explicit. It must not create a second backend connection, maintain a per-panel policy cache, or initialize every cached conversation's policy automatically.

The consumer remains responsible for choosing the product behavior and input control. A Core facility that already provides the required semantics may be used directly. Replacing the small permission control is a consumer decision; intercepting global Native preference writes and writing old defaults back is not a reliable substitute for conversation-scoped semantics, particularly with multiple Native windows.

No new permission interface is advertised by this investigation. The live binding evidence and the consumer's chosen approach will determine whether an Adapter extension is warranted.
