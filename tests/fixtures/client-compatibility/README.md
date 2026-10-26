# Historical remote compatibility fixture

This fixture targets Core 0.2.0-preview.24 in a fresh, owned desktop acceptance
profile alongside its UI/Desktop adapters. It records the public Renderer management RPC
against that release's fixed production HTTPS catalog: background refresh, adapter
requirements, manual checks, fixed-source validation and list/status visibility.
It neither creates model messages nor changes plugin registrations or settings.
The hidden report is sampled by an owned acceptance probe through the DOM. Its
fixed version assertion preserves that historical contract; use current release
validation and fresh receipts for a current Core acceptance run.

Offline/cache, ETag, invalid and oversized responses, monotonic revisions,
preference changes and request cancellation use owned loopback tests in
`src/client_compatibility/tests.rs`; they require no live GitHub mutation.
