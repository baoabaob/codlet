#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'Run native acceptance on an Apple Silicon Mac; a cross check cannot run these tests' >&2
  exit 1
fi
codlet_source_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$codlet_source_root"
export MACOSX_DEPLOYMENT_TARGET=13.0
cargo clippy --locked --target aarch64-apple-darwin --all-targets -- -D warnings
cargo test --locked --target aarch64-apple-darwin --all-targets
echo 'Native Core tests passed; follow the macOS guide for actual client and visual acceptance'
