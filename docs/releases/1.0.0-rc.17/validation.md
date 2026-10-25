# Codlet 1.0.0-rc.17 validation

This Windows release keeps Native requests independent of Core update admission
and adds compatibility with Native package `26.1021.3705.0`, app `26.1021.31345`,
build `21828`. It includes Desktop `0.2.19`, UI `0.1.15` and the rc.16 child-task
selection fix.

## Native acceptance

The ordinary-user VM run on 2026-10-25 used acceptance executable
`47d8b87e8f0ab6130a2800be94598068d76af425384386b80433cedd021b8290`
from source `c17427281b41de4543e09ef1753da657b4838653`. The official package and
Native executable signatures were valid. [The receipt](desktop-receipts.json)
records the package/ASAR hashes and the complete compact verdict.

The run created a synthetic saved conversation through an isolated local model
fixture, opened it using Native navigation, observed idle → working → idle with
root-task identity preserved, read Native permissions, mounted its transcript
in the split workspace, and retained the Native composer after leaving the
workspace. The navigation action was present, all required adapters activated,
plugin errors were zero, and normal shutdown left no owned Native/Core processes.
The official update bridge was also observed available with its original restart
behavior preserved during the preceding Native startup check.

This is a focused compatibility check. Physical IME, attachment retention,
repeated pane movement, zoom/scroll endurance and macOS were not repeated here;
their prior evidence remains scoped to its original version. Earlier failed
startup and empty-thread fixture attempts are retained separately and are not
counted as successful acceptance.

## Native request continuity

Targeted checks cover 300 consecutive Native failures without ledger growth,
Native execution with a full and paused Core ledger, exact result/error identity,
immediate renderer dispatch during unknown update outcomes, and permission-guard
restoration. Core source failure can fall through only before Native dispatch;
already-dispatched operations are never replayed.

The final source follow-up preserves backend send order when route preparation
fails and defers Core source suspension while that preparation is pending. Its
29 targeted HTTP/stdio/source-lifecycle checks pass. The Native VM receipt above
predates only this follow-up and release metadata; the UI/profile implementation
in that run is the one delivered here.

Actual-source analysis passes 27 workspace checks, 15 Desktop checks and the four
main-process source contracts. The initial source pass ran the broader adapter
suite (456 pass, two optional skips); later changes used targeted checks. Native
shortcut discovery additionally passes direct and lazy-route graph regression
checks and resolves the exact two settings assets in the signed package.

## Installation

This release changes resident Core/bridge code. Windows MSI users upgrade with
the installer after exiting the current client. No online-only package is
published for an already-running rc.15 process with the old ledger. The installer
self-check and public package hash receipts are added after packaging.
