# Plugin installation lifecycle: 1.0.0-rc.5

Folder imports now copy the complete plugin folder into the registry's `packages/<plugin-id>` installation directory. When an ID is already installed, the user chooses **Update** to retain settings and credentials or **Replace** to start with empty data. The completion dialog offers **Delete source files**, selected by default; deletion happens when the user finishes the dialog and verifies that the original folder has not changed since import.

Uninstall removes the installation, preferences, grants, stored data and system credentials without a confirmation dialog. Replacement uses a recoverable package/data transaction: failed activation restores the previous package and data. Updates retain the existing data identity even when the source directory or release channel changes. GUI `1.0.0-rc.3` exposes these operations and requires Core's installation-lifecycle capability.

## Validation

- Rust library suite: 562 passed and 8 ignored in each of two consecutive parallel runs. Coverage includes copied assets and empty directories, explicit collision choices, data-reset recovery, package-shape replacement, source deletion checks, uninstall retry, and Windows Credential Manager cleanup.
- Host control and CLI regression suites: 27 passed after updating the folder-copy contract and fixing filesystem side effects on rejected commands. The remaining integration suites passed in the full all-features run.
- Strict Clippy passed for all targets and all features with warnings denied.
- GUI: 127 tests passed; the frontend build passed. Distribution packaging: 3 tests passed. Runtime skill bridge: 5 tests passed.
- An independent instance of Native `26.1013.3656.0` ran Core `1.0.0-rc.5` and GUI `1.0.0-rc.3` in a fresh private profile. The existing daily processes remained unchanged at startup.
- Actual Core operations installed a folder copy, preserved configuration and credentials across update, cleared them on replacement without transferring transient state, restored the previous data after an intentional activation failure, and removed registration, preferences, code and data on uninstall. Source deletion was exercised through the Core completion API after successful installation.
- The owned Native and helper processes exited. Redundant executable/runtime copies, temporary profile home and copied plugin packages were removed. Acceptance reports, event logs, session data and databases are retained under `.codlet-artifacts/core-native/core-ac028aeb-aeeb-4b82-8408-c161ea5bb1f5`.

The Native run used the reviewed development WebSocket path and synthetic account. It validates plugin lifecycle operations and runtime activation; it does not establish an authenticated model-stream result. GUI interaction behavior is covered by its frontend tests.
