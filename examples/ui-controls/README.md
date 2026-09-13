# Official UI controls example

An isolated-world renderer requesting only `ui.dom` and `codex.ui.navigation.page@1`. It uses the actual official Button and Switch components through UI API 2, with a page-scoped counter, asynchronous action and inline reset confirmation.

Source: `frontend/src/examples/ui-controls.jsx`; the build emits this directory's `renderer.js`. Closing the native page unmounts the component and cancels its timer; disabling the plugin retires the page and its shared runtime resources. No private Desktop objects or management authority are used. See [UI API 2](../../docs/UI_HELPERS_AND_NAVIGATION_2026-09-11.md).
