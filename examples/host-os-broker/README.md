# Explicit OS broker example

This Host-only package uses the public filesystem, network and system brokers.
It needs no renderer, GUI, official adapter or raw CDP permission. Its source and
requested permissions can be inspected before registration.

Start the local HTTP fixture in one terminal from a portable distribution:

```powershell
.\runtime\node-v24.21.0-win-x64\node.exe .\examples\host-os-broker\serve-fixture.cjs
```

In another terminal, inspect and explicitly grant this example's scopes:

```powershell
$pluginRoot = (Resolve-Path .\examples\host-os-broker).Path
$readRoot = Join-Path $pluginRoot 'approved-data'
.\codlet.exe plugin add $pluginRoot
.\codlet.exe plugin add $pluginRoot --trust --grant host.process --grant host.fs --grant host.network --grant host.system --read-root $readRoot --network-origin http://127.0.0.1:8765
.\codlet.exe plugin enable example.os-broker
.\codlet.exe launch
```

When a matching Codlet runtime already exists, enable uses that runtime's receipt.
Otherwise the saved preference applies at the next launch. Registration prints the
declared permissions, explicit grants and broker policy before saving. If another
port is needed, pass it to `serve-fixture.cjs`, update `approved-data/settings.json`
and explicitly grant that exact origin.

`broker-report.json` records the authorized text read, directory/stat results,
HTTP response and bounded system information. The `readAgain` method of
`example.os-broker.inspect@1` lets another authorized capability consumer repeat
the same broker read. Revoke filesystem authority with:

```powershell
.\codlet.exe plugin revoke example.os-broker host.fs
.\codlet.exe plugin permissions example.os-broker
```

The revoke receipt saves the reduced full registration, invalidates the old
generation's managed endpoints and retires its dependent closure. It does not
delete plugin source or erase the observation file. Restoring authority requires
an explicit grant/scope update and a fresh enable; the previous token cannot be
reactivated.

The example writes its report with ordinary Node filesystem access. Node runs as
the current user and is not an OS sandbox. Broker grants constrain these managed
endpoints; they do not reverse external effects already performed by code. See
[the OS broker contract](../../docs/OS_BROKER_2026-09-10.md) for exact limits and
the isolated acceptance cases.
