#!/usr/bin/env bash
# Packages the desktop application for the desktop this runs on.
#
#   agent/scripts/package-desktop.sh [out-dir]
#
# Writes one archive into out-dir (default: agent/dist/desktop) and prints its
# path as the last line of output:
#
#   macOS    memoar-desktop-<version>-macos-<arch>.zip      Memoar.app, ad hoc signed
#   Linux    memoar-desktop-<version>-linux-<arch>.tar.gz   runner, bundle, .desktop file
#   Windows  memoar-desktop-<version>-windows-<arch>.zip    Memoar.exe and its bundle
#
# <arch> is x64 or arm64. MEMOAR_DESKTOP_VERSION overrides the version in
# nsh.json, for a release built from a tag. Under GitHub Actions the path is
# also written to $GITHUB_OUTPUT as `package`. NSH builds each desktop's
# runner natively, so each archive is built on its own operating system: run
# this on macOS, Linux and Windows (Git Bash) runners, with `shell: bash`.
#
# Linux needs GTK 4.14 or later and WebKitGTK 6.0 with their development files
# (Ubuntu 24.04: libgtk-4-dev libwebkitgtk-6.0-dev, which brings libsoup 3 and
# JavaScriptCore). The packaged app needs libgtk-4-1 and libwebkitgtk-6.0-4 at
# run time. The .tar.gz declares no dependencies, so install them first.
set -euo pipefail

. "$(dirname -- "$0")/desktop-nsh.sh"
ensure_nsh

target=$(host_target)
out_dir=${1:-"$desktop_dir/../../dist/desktop"}
mkdir -p "$out_dir"
out_dir=$(CDPATH= cd -- "$out_dir" && pwd)

version=${MEMOAR_DESKTOP_VERSION:-$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$desktop_dir/nsh.json")}
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) arch=$(uname -m) ;;
esac
name="memoar-desktop-$version-$target-$arch"

staging="$desktop_dir/.nsh/package-$target"
rm -rf "$staging"
cd "$desktop_dir"
nsh package --target "$target" --out "$staging" \
  --icon icons/icon.png --app-version "$version"

case "$target" in
  macos)
    app=$(find "$staging" -maxdepth 1 -name '*.app' | head -n 1)
    package="$out_dir/$name.zip"
    rm -f "$package"
    ditto -c -k --keepParent "$app" "$package"
    ;;
  linux)
    built=$(find "$staging" -maxdepth 1 -name '*.tar.gz' | head -n 1)
    package="$out_dir/$name.tar.gz"
    cp "$built" "$package"
    ;;
  windows)
    built=$(find "$staging" -maxdepth 1 -name '*.zip' | head -n 1)
    package="$out_dir/$name.zip"
    cp "$built" "$package"
    ;;
esac

if [ ! -s "$package" ]; then
  echo "memoar desktop: nsh package produced nothing in $staging" >&2
  ls -la "$staging" >&2
  exit 1
fi
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "package=$package" >>"$GITHUB_OUTPUT"
fi
echo "$package"
