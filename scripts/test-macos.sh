#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'Run native acceptance on an Apple Silicon Mac; a cross check cannot run these tests' >&2
  exit 1
fi
codlet_source_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$codlet_source_root"
export MACOSX_DEPLOYMENT_TARGET=13.0
codlet_target_root=$(cargo metadata --locked --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')
python3 scripts/install-js-runtime.py --platform darwin-arm64 --destination "$codlet_target_root/aarch64-apple-darwin/debug"
python3 scripts/install-js-runtime.py --platform darwin-arm64 --destination "$codlet_target_root/aarch64-apple-darwin/debug/deps"
cargo clippy --locked --target aarch64-apple-darwin --all-targets --all-features -- -D warnings
cargo test --locked --target aarch64-apple-darwin --all-targets --all-features -- --test-threads=2
echo 'Native Core tests passed; follow the macOS guide for actual client and visual acceptance'
