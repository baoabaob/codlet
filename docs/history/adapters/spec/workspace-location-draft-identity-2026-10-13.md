# Native location restoration: draft identity and commit ordering

The first A/B candidate could reject an ordinary thread return with `workspace_location_state_evicted`. Its confirmation ran as soon as the router reached the saved URL, while the previous thread's input could still be mounted, and it also required the captured controller/scope references to survive. Neither condition establishes whether a Native draft was lost.

The corrected confirmation first waits for the target Native kind, conversation and strict local input binding. It then compares the private Native draft namespace and validates that the current controller is owned by an initialized Native EditorProvider with that namespace as its key. Native view/controller/scope references may change. A target with another draft namespace still fails explicitly; the previous page's transitional input is not treated as an eviction.

On Native 26.1007, the shared formatter (local `C0r`, export `cG`) supplies the keys used by the original thread and home Composer paths. Local tasks use `clientThreadId`; home uses Native's home/GPT draft namespace. `rpt` and `wzt` pass this key to `GDe`/`Rhl`. Native `Rhl` creates its controller with the original default text/document, forwards document changes/disposal to Native callbacks, and can destroy/recreate its controller. This is why reference equality is inappropriate. These names identify the inspected source, not fixed runtime aliases: discovery matches the semantic formatter contract.

The Adapter calls only that pure identity formatter. It observes the initialized controller's provider/key and semantic scope fields, never calls `getPersistedText`, reads a document, copies a draft, restores text, or sends a message. The location handle stores bounded identity metadata instead of retaining an obsolete input/controller object. Native is responsible for loading the saved draft through its own original Composer path.

Offline regressions cover URL publication before the target input, same-namespace controller reconstruction, home with an unsent draft namespace, rejection of a different target namespace, and rejection of a controller initialized under another provider key. This source correction still needs the consumer-owned Native retest of ordinary return and a real new unsent page; it is not a claim that live draft retention has passed.

The frozen fix intentionally retains `independentViewport:false`, keeping the separate viewport candidate out of this diagnosis. The failed 1387fa9 sample and its reports remain intact.
