# Development storage

- Before Cargo builds/tests or independent desktop acceptance runs, run
  `node scripts/check-dev-storage.mjs`. Pass `--target-dir` when Cargo uses a
  directory configured outside `CARGO_TARGET_DIR`. Resolve that directory with
  `cargo metadata --locked --format-version 1 --no-deps` when needed.
- Use the checked-in development/test profiles and one target directory per
  platform/toolchain. Use `full-debug` only for a debugging session that needs
  variable/type information; clean that profile after the process has stopped.
- If the storage check fails, reclaim obsolete generated output before starting
  another build or desktop run. Do not remove output used by active processes.
- After independent desktop acceptance, verify its owned processes have exited
  and remove its redundant executable/runtime copies, temporary profile `home`,
  downloaded plugin caches and superseded candidates. Retain reports, session
  JSONL, databases and the latest useful delivery packages.
- Resolve cleanup targets inside the intended generated-output directory, reject
  symlinks/junctions, and use literal paths. Do not use force deletion flags.
