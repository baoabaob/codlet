# Troubleshooting

Run CLI commands using the same executable and `CODLET_HOME` as the affected session. For a portable Windows installation, `Codlet-CLI.cmd` selects the portable `data/` directory automatically.

```sh
codlet status --json
codlet doctor --json
codlet plugin list --json
```

`status` reports the current owner and session; `doctor` inspects runtime, registry, resources, and compatibility without submitting a model task. If a submitted management operation timed out, inspect its receipt with `codlet plugin operation RECEIPT --json` before deciding whether another submission is needed.

## Startup and installation

The native Windows launcher reports running recognized clients before launch. Close them normally or cancel; unsaved work is never a reason for the launcher to force-kill the app. Its initial normal-close wait is bounded. If the client remains open, retry after closing it yourself.

Launch logs are under the selected Codlet data directory's `launcher-logs/`. Startup confirmation is limited to 90 seconds. On timeout, already started processes remain available for investigation; the launcher reports the failure instead of hiding an indefinite wait. MSI process-check logs are `%TEMP%/Codlet-Installer-{ProductCode}.log`. An unattended installation refuses a busy client before changing installation files (MSI error 1603, process-gate result 1618).

The macOS launcher similarly requests normal quit, waits up to 15 seconds, and permits cancellation. Preview apps are ad-hoc signed, not Developer ID signed/notarized. Do not globally disable OS protections to test them.

For an independent developer lab, follow the printed startup/error/coordinator paths. Recovery requires the previous owner to have exited; see [development](development.md).

## Safe mode

```sh
codlet launch --safe-mode
```

Safe mode is an explicit choice for that launch, not automatic crash detection. It bypasses all plugin activation, including Host code and the GUI, while keeping Core status/management available. It does not require loading a broken plugin to start, and cannot be combined with watching source changes.

Use the CLI to disable or revoke a plugin, or remove its registration while preserving source. Safe mode rejects operations that activate/import/update plugins or delete source. Exit and launch normally when repairs are complete. No separate permanent safe-mode shortcut is installed.

## Export diagnostics

```powershell
codlet diagnostics --output C:\existing-folder\codlet-diagnostics.zip --json
```

Choose a new absolute ZIP path in an existing directory; export refuses overwrite. The archive contains a manifest, a sanitized doctor summary, and a README, with a 4 MiB limit. Successful export returns success even when the included doctor result reports a problem.

Diagnostic bundles omit authentication, conversations, arbitrary user files, raw logs, and actual registry paths. Plugin IDs and capability names remain useful diagnostic information. Nothing is uploaded automatically. Inspect any separate raw logs before sharing: plugin-generated errors can contain paths or other plugin-provided text. Runtime logs rotate at 1 MiB with two older files retained.

## Memory after repeated plugin reloads

The remaining Chromium isolated-world retention is documented in [known issues](known-issues.md). A complete close and relaunch of the owned client clears that session; a page reload is not a reliable substitute. Current evidence does not establish an unbounded idle leak or multi-day behavior.
