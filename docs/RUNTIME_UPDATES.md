# Codlet runtime updates

Codlet currently has no published release repository. The checked-in
`runtime/update-channel.json` therefore has `source: null`. This is a development
state: the header reports the compiled Cargo version, Settings explains the unconfigured source, no update request is sent,
and the app does not claim that this is the newest released version. Users do not
enter a release URL in the GUI.

This updater replaces only Codlet's owned binaries and Node payload. The separate
official-update owner can coordinate it with the client's own installer through
an explicit **Update both** confirmation. Ordinary Codlet updates retain the
**check → click Download → click Install and restart** flow. See
[the Windows handoff record](OFFICIAL_UPDATE_HANDOFF_2026-09-19.md).

## Release configuration

The developer ships one local `runtime/update-channel.json` beside the owned
installation. RPC methods cannot change its URL, origins or profile. Its interval
is the default (900 seconds when omitted). Registry-scoped preferences can disable
automatic Codlet checks or override their interval from 300 to 86400 seconds;
manual checks remain available when a source is configured. Errors back off to
the larger of six hours and the chosen interval. Checks run on a bounded
background worker, and automatic checks cannot replace a queued, downloading,
downloaded or installation-pending candidate. A configured worker that has never
checked and has automatic checks disabled reports `idle`, not `upToDate`.

For a public GitHub repository, configure:

```json
{
  "schema": 1,
  "channel": "stable",
  "checkIntervalSeconds": 900,
  "source": {
    "kind": "github",
    "repositoryUrl": "https://github.com/OWNER/REPOSITORY",
    "manifestAsset": "codlet-update-stable.json"
  }
}
```

`OWNER/REPOSITORY` is a developer placeholder, not an existing Codlet release
source. GitHub checks use the public latest release without authentication. Its
tag must be the manifest version, optionally prefixed with `v`. The channel
manifest and ZIP must be uploaded assets in that same release. GitHub size and
SHA-256 metadata are checked when provided, and the channel manifest always pins
the ZIP's SHA-256 and size.

A developer-operated HTTPS channel may instead use:

```json
{
  "schema": 1,
  "channel": "stable",
  "checkIntervalSeconds": 900,
  "source": {
    "kind": "https",
    "manifestUrl": "https://updates.example.com/codlet/stable.json",
    "allowedAssetOrigins": ["https://downloads.example.com"]
  }
}
```

The manifest URL is pinned to its configured HTTPS origin. Artifact redirects
must stay within the configured HTTPS origin list. Credentials, HTTP, arbitrary
RPC URLs and redirects to unconfigured origins are rejected. GitHub downloads
have a separate fixed GitHub-origin allowlist.

## Build release files locally

First build a complete portable or isolated-client directory using the existing
distribution builder. The selected directory must contain its compiled executable
and `runtime/node-runtime.json`, plus the pinned Node executable and license.
The updater builder never builds or executes those payload files.

```powershell
.\scripts\Build-RuntimeUpdate.ps1 `
  -InputDirectory C:\build\codlet-portable `
  -Profile portable -Version 0.2.0 `
  -OutputDirectory C:\build\update-portable

.\scripts\Build-RuntimeUpdate.ps1 `
  -InputDirectory C:\build\codlet-test-client `
  -Profile isolatedClient -Version 0.2.0 `
  -MergeChannelManifest C:\build\update-portable\codlet-update-stable.json `
  -OutputDirectory C:\build\update-isolated
```

These example paths/version are developer inputs. Each output directory must be
new. The script emits the real ZIP, its `.sha256` file, the exact inner
`runtime-update-manifest.json`, and `codlet-update-stable.json`. The second command
combines both profile artifacts into one release manifest. For HTTPS hosting,
also pass `-ArtifactBaseUrl` for the ZIP's final HTTPS directory. All SHA-256 and
byte counts come from the actual generated files.

Upload the two ZIPs and the combined channel manifest to the chosen release only
after ordinary release review. Optional `.sha256` files can also be published.
For version `0.2.0`, the GitHub tag is `v0.2.0` or `0.2.0`. This repository's
automation does not create a remote, sign binaries, publish assets or install an
unpublished executable on the user's machine.

## Exact payload profiles

The ZIP root contains `runtime-update-manifest.json`, whose schema is 1 and whose
kind is `codlet-runtime-update`. It declares version, platform (`win-x64`), profile,
Node version/pins and a file list containing each path, byte count and SHA-256.

| Profile | Required executable | Required runtime files |
| --- | --- | --- |
| `portable` | `codlet.exe` | `runtime/node-runtime.json`, versioned `node.exe` and `LICENSE` |
| `isolatedClient` | `codlet-lab.exe` | The same Node files |

`-IncludeOtherExecutable` can package an already-owned secondary Codlet executable.
Installation refuses to add that secondary executable when the owner did not
already have it. An omitted secondary executable remains untouched.

No plugin directories, launcher scripts, authentication, user settings, data or
update-source configuration are permitted in the payload list. ZIP32 Stored and
Deflate are supported. Limits are 512 MiB downloaded, 1 GiB expanded, 512 MiB per
file and 4096 explicit/implicit entries. Traversal, Windows aliases, case collisions,
links, special files, ZIP64, encrypted entries, overlapping/ambiguous headers,
unexpected data, CRC failures, wrong PE architecture and digest mismatch fail
before an installation can be requested.

## Owner handoff and restart

The Core owner supplies an exact restart executable, argument vector, working
directory, explicit environment overrides and launcher-file identities. Restart
inherits the existing owner's helper environment; the plan contains only the
fixed overrides and does not snapshot the entire process environment. Unknown launchers report
`install_unavailable`. A GUI caller cannot supply commands, PIDs or paths.

Preparing an installation rechecks every current and staged payload hash. It copies
the trusted helper and the current pinned Node executable outside the files that
will be replaced, creates a bounded checked plan, and returns its SHA-256. No file
is installed during this preparation.

Owners place update state at `<installRoot>/.codlet-updates/<registryScope>`, so
installations on one drive can use a registry on another drive while retaining
same-volume replacement. That directory is outside the exact payload file list
and is not moved during installation. A custom cross-volume staging layout is
rejected before handoff, and known read-only/unwritable installation paths are
rejected before any owner is closed.

The helper starts as:

```text
nodePath helperPath --plan planPath --sha256 planSha256
```

After verifying its plan and own identities, the helper acquires the
installation-wide `.codlet-runtime-update.lock.json`
using exclusive creation. The lock covers every registry sharing that installation
and remains held through restart or rollback. It records the exact helper process
identity, plan hash and a nonce; cleanup removes only that helper's unchanged lock.
Conflicts fail before readiness. Crashed/uncertain locks are retained for owner
recovery rather than guessed safe and deleted.

It rechecks current/staged bytes and restart context, writes a receipt, and emits `runtime-update-helper-ready` with the matching `id`
and `planSha256`. It then waits at most 15 seconds for the fixed `handoffAckPath`
file containing those two fields. A missing/mismatched acknowledgement makes it
exit without modifying payload, even if the old owner later closes.

Only after acknowledgement does the owner request normal closure of its own
Desktop/Host/backend/coordinator. The helper waits for exact PID/creation-FILETIME
identities to disappear; it never kills a process. It must be launched outside the
owner's job object so that normal Core shutdown does not terminate the helper.

Once all old owners have exited, the helper uses filesystem renames to back up
each declared owned file and place each new file. It does not swap or delete the
whole installation directory. For the isolated launcher, the owner may authorize
one exact configuration path: only `labBinarySha256` and `nodeRelative` are updated,
using values derived from the verified manifest. Existing uppercase SHA pins are
accepted. All other JSON fields stay equal; rollback restores the original bytes.

The owner restart command returns:

| Exit | Meaning and helper behavior |
| --- | --- |
| `0` | Owner readiness was confirmed; retain an `installed` receipt. |
| `42` or timeout | New owner retirement cannot be proved; retain backup and `rollbackBlocked`, do not roll back or start a second owner. |
| Other failure | Owner has confirmed all new components stopped; restore checked old payload/config bytes, then invoke the same old restart command once. |

If saving the final receipt fails after a successful or uncertain restart, the
helper retains the installation lock and blocks rollback. A journal error never
authorizes modifying files beneath a potentially running new owner.

If all old owners have already closed but installation fails before the first
payload move, the helper rechecks the still-original payload and launcher and
restarts that old owner once. If those identities can no longer be trusted, it
stays blocked rather than executing changed files.

System restart executables such as Windows PowerShell can have WinSxS hard links;
they are hashed read-only and are never replaced. Mutable payload, launcher script,
configuration and receipt files retain the no-hard-links rule.

The service observes helper failure receipts while the original application is
still alive. A confirmed failure before any modification restores `downloaded`
with an error so a fresh owner handoff may be tried. Uncertain restart/rollback
keeps installation blocked for owner attention. Persisted staged metadata is
reloaded on later starts only after matching the channel fingerprint and rechecking
the manifest and every payload digest. Completed backups and install receipts
remain in the owner's update state directory for diagnosis; no generic recursive
cleanup of installation/user data is performed.

## Public service actions

The four `runtime.manage` methods are `runtimeUpdateStatus`, `checkRuntimeUpdate`,
`downloadRuntimeUpdate`, and `installRuntimeUpdate`, each accepting an empty object.
They return promptly with the compiled version, phase, candidate identity,
progress, scheduling timestamps and install availability. Semantic version ordering
selects strictly newer releases; missing source remains `development`.

The GUI uses `versionStatus(null)` for lightweight combined Codlet/client status,
including when the Codlet source is unconfigured. It polls while its native page
is visible (five seconds idle, one second during update work), without fetching
the whole plugin list, and stops this poll on hide/departure. All version details
and explicit check/download/install actions are in Settings. The management
heading shows the compiled version and only adds a warning icon for a confirmed
new Codlet candidate or confirmed client mismatch/update. Clicking that warning
opens Settings and focuses the version section after settings data settles.

`getSettings` / `saveSettings` persist the automatic-check preference and interval
independently of the fixed release source. See [the management contract](RUNTIME_MANAGE_2026-09-10.md)
for CAS and failure recovery. Official-client version monitoring stays on its
separate 15-minute cadence.

Fixture tests cover public-source transport, malicious ZIPs, persisted staged
recovery, live-owner waiting, unacknowledged handoff, fixed configuration patches,
successful restart, failed restart/rollback, exit-42 blocking, final-receipt write
failures, competing registries sharing one installation and payload/link
protection. They do not represent a published release or an installation of new
Codlet binaries on the user's real runtime.
