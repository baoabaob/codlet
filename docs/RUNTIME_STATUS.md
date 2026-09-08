# Runtime Host Status (Schema 1)

`codlet status` and `codlet status --json` query the foreground Host created by
`codlet launch`. They do not discover or connect to CDP, enumerate Codex processes,
read plugin configuration, execute JavaScript, or start/stop/restart Codex.
`m0-probe` and `m0-runtime` do not publish this endpoint.

Live enable/disable/reload use the separate [runtime control endpoint](RUNTIME_CONTROL.md).
This status schema remains read-only.

## CLI contract

JSON stdout contains one report, including on failure. Exit code is 0 for
`running` or `not_running`, 1 for every other outcome. Errors may also be summarized
on stderr. Human output includes each target and plugin, its lifecycle,
`context-present`, `activation-confirmed`, and `active`.

No endpoint:

```json
{"schema_version":1,"status":"not_running","snapshot":null,"error":null}
```

A running Host example (identities and timestamps here are illustrative):

```json
{
  "schema_version": 1,
  "status": "running",
  "snapshot": {
    "host_pid": 1234,
    "codlet_version": "0.1.0",
    "state": "ready",
    "sequence": 14,
    "sampled_at_unix_ms": 1788750000000,
    "codex": {
      "pid": 5678,
      "package_full_name": "fixture_1.2.3.4_x64",
      "package_version": "1.2.3.4",
      "executable": "C:\\fixture\\Codex.exe"
    },
    "renderer": {
      "targets": [{
        "target_id": "main",
        "session_id": "session-main-1",
        "session_live": true,
        "plugins": [{
          "id": "codlet",
          "version": "0.1.0",
          "generation": 1,
          "lifecycle": "active",
          "context_present": true,
          "activation_confirmed": true,
          "active": true
        }]
      }],
      "recent_events": [],
      "truncated": false
    },
    "termination": null
  },
  "error": null
}
```

| Status | Meaning |
| --- | --- |
| `running` | A verified Host returned a snapshot; inspect `snapshot.state`. |
| `not_running` | The per-user endpoint does not exist (`ERROR_FILE_NOT_FOUND`). No other failure is collapsed into this state. Older Hosts without this endpoint are not discoverable. |
| `busy` | The single pipe instance is occupied. Retry a later status query. No automatic reconnect loop. |
| `timeout` | The client exhausted its absolute transaction IO budget. |
| `incompatible` | The Host uses another schema version, or explicitly rejects the request version. |
| `untrusted_server` | Server SID, image path, PID, or process liveness could not be verified; includes a Host from a different Codlet build directory. |
| `communication_error` | Pipe access/open/IO failed, a frame or JSON response was malformed, or the response shape was inconsistent. |
| `invalid_request` | Host rejected malformed JSON, unknown/duplicate fields, or a command other than `status`. |
| `snapshot_too_large` | Host could not encode the sample within the response frame limit. |

## Snapshot semantics

- `starting`: configuration and both conflict scans passed; the pipe, events and
  worker were created. `codex` is null until this launch creates its child. Target
  discovery and initial plugin activation may still be in progress.
- `ready`: initial discovery/attachment attempts finished. Individual attempts
  may have failed. This does not assert that a GUI mounted, that all plugins are
  active, or that the real Codex gate passed.
- `terminated`: the foreground runtime observed child exit or an error, or is
  dropping. Targets are cleared, but child identity remains as historical data.
  `termination` records the observed reason. This state is irreversible.

The worker serves an immutable sample; it never asks the renderer owner to do
work. The owner publishes at lifecycle transitions, context events and the normal
50 ms foreground loop. `sequence` increases on publication and
`sampled_at_unix_ms` is its wall-clock time, not the query time. During a long
renderer RPC, the sample can remain unchanged. A successful status query establishes
that the Host process and IPC worker responded, not that renderer work is current.
Use the timestamp to assess age; wall-clock adjustments can move time backward.

Targets are the renderer owner's current session records, sorted by target ID;
ended/detached targets are removed. Plugins come from those sessions, not from
configuration enablement. A loaded-but-disabled plugin is not included. Lifecycle
is `activating`, `ready`, `active`, or `stopping` from the actual owner record.
`active` requires a live session, a present context, an observed successful
activation in that context, owner lifecycle `active`, and no pending document recovery.

After an owned context is destroyed/cleared or replaced, `activation_confirmed`
becomes false. Context-created events must match the exact main frame and a
non-default isolated world; a same-named subframe cannot overwrite that identity.
Context creation alone can still yield `context_present=true`, `lifecycle=active`,
but `activation_confirmed=false` and `active=false`.

A supported main `Page.frameNavigated` event schedules document recovery outside
nested RPC dispatch. The renderer owner retires the previous resources and scope,
issues fresh authorizations and document-specific bindings, then awaits activation
in provider-before-consumer order. The plugin generation remains unchanged, while
world/binding names gain a document epoch so recycled numeric context IDs cannot
authenticate an old call. `document_recovering`, `document_recovered`, and
`recovery_failed` describe these transitions. A failed recovery leaves no active
candidate and waits for another main-document navigation before retrying. Status
queries still perform no renderer work and do not prove DOM mounting.

At most 128 targets and 256 plugins per target are sampled. Target/session/plugin
identity strings and versions are limited to 1024 UTF-8 bytes, with `truncated`
set if the target/plugin sample was limited. `recent_events` retains the latest
32 attachment/cleanup/navigation/session errors or transitions, with each text
field shortened to 1024 UTF-8 bytes. It is a bounded diagnostic tail, not an audit
log or a complete inventory of previously ended targets.

Termination is a transient best-effort sample, not a persisted tombstone or a
guaranteed final response. Normal completion publishes it before CDP shutdown;
Drop publishes it before cancelling IPC. After handles close, queries return
`not_running`. Abrupt process termination relies on Windows handle cleanup and
cannot publish a final sample. `host_dropped` does not assert the child exited.

## Local protocol and trust

Endpoint: `\\.\pipe\Codlet.RuntimeStatus.<sid-bytes-as-lowercase-hex>`.
The SID encoding is the same binary token SID used by the launch mutex. The name
does not contain a schema version, so a future incompatible Host is still found.

The server creates one duplex byte-mode overlapped pipe with
`FILE_FLAG_FIRST_PIPE_INSTANCE`, maximum instances 1, non-inheritable handles,
`PIPE_REJECT_REMOTE_CLIENTS`, and a protected DACL containing one full-access ACE
for the current user's SID (`D:P(A;;GA;;;SID)`). A squatted name makes launch fail
before child creation; Codlet never joins an existing pipe as a server. The pipe
handle remains owned across transactions and is reused after disconnect.

Before sending a request, the client obtains the server PID from Windows, opens
that process with query and synchronization access, checks its token user SID,
and compares the Windows-recorded Win32 image path with this client's own image
path. Path comparison folds ASCII case only; alternate paths, aliases or another
build directory can be conservatively rejected. It does not resolve the server
path through the filesystem. The client holds that process handle throughout
the exchange, repeats pipe PID/liveness checks before ACK, checks process liveness
after ACK, and requires `snapshot.host_pid` to match the verified PID. Client
SQOS is anonymous, so a squatting server cannot impersonate the connecting user.

This protects against accidental/wrong-user servers, remote clients and a
different local executable posing as Codlet. It is not code signing or executable
content attestation. Code already running as the same user can replace a writable
Codlet executable, inject into it, duplicate handles or deny service. Administrators,
SYSTEM and a compromised OS are outside this trust boundary. The protocol itself
has no mutation or script-execution operation.

## Framing and resource limits

Each connection carries exactly one request and one response:

1. Four-byte unsigned little-endian JSON byte length, then UTF-8 JSON request.
   The only request is `{"schema_version":1,"command":"status"}`.
2. Four-byte unsigned little-endian JSON byte length, then UTF-8 JSON response.
3. Client sends the single acknowledgment byte `0x06` after consuming the response.
   The server disconnects and listens again. No pipelining or persistent sessions.

Request limit: 1024 bytes. Response limit: 262144 bytes. Zero/oversize frame lengths
are rejected before allocating their payload. Incomplete or invalid frames close
the connection; invalid bounded JSON requests receive a versioned error when
possible. Response serialization itself uses a bounded writer.

The server's absolute 750 ms budget spans request reads, response writes and ACK;
partial progress cannot extend it. The client's absolute 1500 ms IO budget begins
before opening/verifying the local pipe. A busy open returns immediately. OS token
and process-identity queries are synchronous local Win32 calls, not renderer work.
There is one worker and no per-client thread/queue growth. The renderer shares
only a short mutex-protected immutable snapshot pointer, never pipe IO.

On timeout or shutdown, `CancelIoEx` cancels the pending operation and
`GetOverlappedResult` drains completion before its buffer or OVERLAPPED is freed.
Drop signals the stop event and joins the worker, including during listen/read/
write/ACK waits. No `FlushFileBuffers` is used because it waits for client reads.
Local NPFS cancellation is the OS completion boundary; no client cooperation is
required. Early client disconnects (including `ERROR_NO_DATA` before connect)
reset the instance and resume listening. Fatal listener errors are reported to
the foreground Host's stderr.

See Microsoft documentation for [CreateNamedPipeW](https://learn.microsoft.com/en-us/windows/win32/api/namedpipeapi/nf-namedpipeapi-createnamedpipew),
[CancelIoEx](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelioex), and
[named pipe clients](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-client).

## Validation

Rust unit tests exercise real in-process named pipes with unique fixture names:
strict/versioned requests, no Host, wrong build identity, protected SID-only ACL,
first instance, pre-connect/early disconnects, hostile lengths/JSON, hung clients,
busy results, client timeouts, malformed/future responses, bounded serialization,
and cancellation/rebinding after listen/read/write/ACK Drop. Concurrent publication
tests prevent lost sequence updates and resurrection after termination.

The existing fake child exercises actual renderer attach, activation wait/rollback,
multiple targets, self-disable/cleanup failure, context destruction/recreation and
sample publication. CLI tests verify structured output without configuration
reads/writes and rejection of unsupported arguments. These fixtures do not create
an official Codex process and do not replace the explicit external real gate.
