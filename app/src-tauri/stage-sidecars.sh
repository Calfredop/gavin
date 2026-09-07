#!/bin/sh
# Build gavin-daemon and gavin-mcp and put them where Tauri's
# `bundle.externalBin` expects to find them.
#
# The two binaries have to ship INSIDE the bundle: `resolve_daemon_binary_path`
# and `resolve_mcp_binary_path` both join against `current_exe().parent()`,
# and the absolute gavin-mcp path gavin writes into a workspace's agent
# config has to keep resolving after an update. `externalBin` is what puts
# them there -- and it looks for each source file with the host target
# triple appended, stripping it again when it bundles. So the build cannot
# just leave them in `target/<profile>/`; something has to copy them under
# the suffixed names, and this is that something.
#
# Bundling only. `externalBin` deliberately lives in
# `tauri.bundle.conf.json` rather than the base config, because
# `tauri-build` validates it from the app crate's BUILD SCRIPT: with it in
# `tauri.conf.json`, a plain `cargo test --workspace` on a clean checkout
# fails with "resource path binaries/gavin-daemon-<triple> doesn't exist".
# See BUNDLING.md. `tauri dev` needs none of this -- there the app finds
# its siblings in `target/debug/`, where cargo already put them.
#
# POSIX sh: this runs from the Tauri CLI's shell, which is `sh -c` on unix
# and is not the developer's zsh.
set -eu

profile_dir=debug
cargo_args=""
if [ "${1:-}" = "--release" ]; then
  profile_dir=release
  cargo_args="--release"
fi

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root=$here/../..
# `rustc -vV`'s host line is the triple Tauri appends; asking rustc rather
# than guessing from `uname` is what keeps this right on both an Apple
# Silicon mac (aarch64-apple-darwin) and a glibc/musl split on Linux.
triple=$(rustc -vV | sed -n 's/^host: //p')
target_dir=${CARGO_TARGET_DIR:-$root/target}

# shellcheck disable=SC2086 # cargo_args is deliberately word-split
cargo build $cargo_args --manifest-path "$root/Cargo.toml" -p gavin-daemon -p gavin-mcp

mkdir -p "$here/binaries"
for bin in gavin-daemon gavin-mcp; do
  src=$target_dir/$profile_dir/$bin
  if [ ! -f "$src" ]; then
    echo "stage-sidecars: $src is missing after a successful cargo build" >&2
    exit 1
  fi
  # Copy to a temporary name and move it into place: overwriting a binary
  # that a previous `tauri dev` still has running is ETXTBSY on Linux,
  # while a rename over it is not.
  cp "$src" "$here/binaries/$bin-$triple.tmp"
  chmod +x "$here/binaries/$bin-$triple.tmp"
  mv "$here/binaries/$bin-$triple.tmp" "$here/binaries/$bin-$triple"
done
