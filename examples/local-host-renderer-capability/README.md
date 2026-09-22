# Combined Host / renderer example

This package exposes `example.combined.host@1` from its managed Node entry. Its
isolated renderer awaits that endpoint during activation. Core supplies the
renderer caller's logical ID, generation, target ID and document epoch; the Host
attaches that target through raw CDP and returns its own generation plus those
caller facts.

Register and start with the executable from the same portable distribution:

```powershell
codlet plugin add .\examples\local-host-renderer-capability --trust --grant host.process --grant cdp.raw
codlet launch --watch
```

For a package added after launch, use a second terminal with the same executable:

```powershell
codlet plugin enable example.combined
codlet doctor --json
codlet plugin reload example.combined
codlet plugin disable example.combined
```

The example adds no page UI. In its isolated renderer world it stores the completed
reply in `globalThis.__codletCombinedExample`. The Host owns a raw session and a
page global named `__codletCombinedHost_<generation>`. Renderer cleanup deletes
the isolated result; native cleanup then removes the page marker and detaches its
session. The actual-JS fixture exercises this same example and checks resource
ownership through enable, reload, failure restoration and disable.

Both entries have one receipt and generation. Saving either main JS file triggers
one whole-package watch selection; failed candidates restore both previous source
snapshots at a fresh generation when current trust permits. The manifest remains
schema 1. See [the combined package contract](../../docs/spec/plugin-format.md)
for declaration ownership, dependent closures, source guards and diagnostics.
