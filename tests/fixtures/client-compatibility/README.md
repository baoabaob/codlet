# Remote compatibility fixture

Use this optional fixture in a fresh, owned desktop acceptance profile alongside
the real UI/Desktop adapters. It exercises the public Renderer management RPC
against the fixed production HTTPS catalog: background refresh, current adapter
requirements, manual checks, fixed-source validation and list/status visibility.
It neither creates model messages nor changes plugin registrations or settings.
The hidden report is sampled by an owned acceptance probe through the DOM.

Offline/cache, ETag, invalid and oversized responses, monotonic revisions,
preference changes and request cancellation use owned loopback tests in
`src/client_compatibility/tests.rs`; they require no live GitHub mutation.
