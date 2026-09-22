# Raw Host with its own page bridge

This single Host package uses public CDP to attach page targets, install its own
binding and page script, and exchange JSON messages. It has no renderer entry,
capability dependency, official adapter or managed renderer bootstrap.

```powershell
codlet plugin add .\examples\raw-m2 --trust --grant host.process --grant cdp.raw
codlet launch
```

To exercise the independent path, disable the optional GUI and UI adapter
before launch, or use a separate development registration as described in the
[development guide](../../docs/development.md). The example selects
page targets without depending on Codex private URLs. It adds no visible page UI.

In a page's main execution context, this example exposes:

```js
await globalThis.__codletRawM2.request({ message: 'hello' });
// { echo: { message: 'hello' }, targetId: '...', generation: 1 }
```

The script is installed for subsequent documents too. Each document creates a
fresh token and request table; replies target the actual execution context from
its CDP binding event. A destroyed document cannot receive a later response.
New page targets get the same bridge. The example only echoes values; it does
not translate page input into filesystem, network or process commands.

It keeps at most eight targets and four requests in each page and the Host bridge.
Messages are limited to 8 KiB and page waits expire after two seconds. The optional
`delayMs` argument (0–250 ms) is useful for navigation testing.
If the bounded CDP event subscription ends, the Host reports a failure and Core
retires it; the example does not silently keep a bridge whose events were lost.
The public `methods` subscription filter selects only target lifecycle and binding
messages, so unrelated execution-context notifications do not consume its queue.

Normal disable/reload disposes the page bridge, removes the binding and new-document
script, and detaches each known session through the finite cleanup API. Core also
retires its tracked raw session ownership. Revoking `cdp.raw` makes old managed
calls unavailable; that does not promise reversal of arbitrary page effects that
the plugin can no longer remove. Node remains an ordinary user process.

The actual-JavaScript M2 fixture executes this exact Host source and its injected
page code through activation, two windows, navigation, target creation/destruction,
and shutdown. Its Node VM peer does not emulate Chromium or DOM compatibility.
See [Core RPC](../../docs/spec/rpc.md) for the optional managed protocol,
and [OS brokers](../../docs/spec/permissions.md) for separately approved system
access.
