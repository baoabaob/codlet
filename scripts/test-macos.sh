#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'Run native acceptance on an Apple Silicon Mac; a cross check cannot run these tests' >&2
  exit 1
fi
codlet_source_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$codlet_source_root"
export MACOSX_DEPLOYMENT_TARGET=13.0
# macOS exposes /var through a system symlink. Fixtures must start from the
# physical temporary root so path-ownership checks still reject real symlinks.
TMPDIR=$(CDPATH='' cd -- "${TMPDIR:-/tmp}" && pwd -P)
export TMPDIR
codlet_target_root=$(cargo metadata --locked --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')
python3 scripts/install-js-runtime.py --platform darwin-arm64 --destination "$codlet_target_root/aarch64-apple-darwin/debug"
python3 scripts/install-js-runtime.py --platform darwin-arm64 --destination "$codlet_target_root/aarch64-apple-darwin/debug/deps"
cargo clippy --locked --target aarch64-apple-darwin --all-targets --all-features -- -D warnings
# The private process owner is an actual Core CLI mode, not a libtest mode.
# Build this checkout's sibling binary before unit tests select that fixed path.
cargo build --locked --target aarch64-apple-darwin --all-features --bin codlet
cargo test --locked --target aarch64-apple-darwin --all-targets --all-features -- --test-threads=2
echo 'Native Core tests passed; follow the macOS guide for actual client and visual acceptance'
