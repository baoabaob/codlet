#!/bin/sh
set -eu
if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo 'Build on an Apple Silicon Mac with Xcode Command Line Tools and Rust installed' >&2
  exit 1
fi
codlet_source_root=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$codlet_source_root"
export MACOSX_DEPLOYMENT_TARGET=13.0
codlet_profile=${1:-debug}
case "$codlet_profile" in
  debug) cargo build --locked --target aarch64-apple-darwin --bin codlet --no-default-features ;;
  release) cargo build --locked --release --target aarch64-apple-darwin --bin codlet --no-default-features ;;
  *) echo 'Usage: sh scripts/build-macos.sh [debug|release]' >&2; exit 2 ;;
esac
codlet_target_root=$(cargo metadata --locked --format-version 1 --no-deps | python3 -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')
python3 scripts/install-js-runtime.py --platform darwin-arm64 --destination "$codlet_target_root/aarch64-apple-darwin/$codlet_profile"
echo "Built: $codlet_target_root/aarch64-apple-darwin/$codlet_profile/codlet"
echo 'Run that executable with launch, or launch --safe-mode for recovery'
