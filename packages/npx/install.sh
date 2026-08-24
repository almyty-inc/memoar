#!/bin/sh
set -eu

version=${MEMOAR_VERSION:-0.2.0}
base=${MEMOAR_DOWNLOAD_BASE:-}
install_dir=${MEMOAR_INSTALL_DIR:-"${HOME}/.local/bin"}
os_name=${MEMOAR_OS:-$(uname -s)}
arch_name=${MEMOAR_ARCH:-$(uname -m)}

case "$os_name" in
  Darwin) os_target=apple-darwin; extension= ;;
  Linux) os_target=unknown-linux-gnu; extension= ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT) os_target=pc-windows-msvc; extension=.exe ;;
  *) echo "memoar: unsupported operating system: $os_name" >&2; exit 2 ;;
esac

case "$arch_name" in
  arm64|aarch64) cpu_target=aarch64 ;;
  x86_64|amd64) cpu_target=x86_64 ;;
  *) echo "memoar: unsupported architecture: $arch_name" >&2; exit 2 ;;
esac

asset="memoar-${cpu_target}-${os_target}${extension}"
if [ "${MEMOAR_PRINT_ASSET:-0}" = 1 ]; then
  printf '%s\n' "$asset"
  exit 0
fi

if [ -z "$base" ]; then
  echo "memoar: MEMOAR_DOWNLOAD_BASE is required until a release channel is approved" >&2
  exit 2
fi

if [ -z "$install_dir" ]; then
  echo "memoar: install directory cannot be empty" >&2
  exit 2
fi

case "$install_dir" in
  /|.) echo "memoar: refusing unsafe install directory: $install_dir" >&2; exit 2 ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  echo "memoar: curl is required" >&2
  exit 1
fi

scratch=$(mktemp -d "${TMPDIR:-/tmp}/memoar-install.XXXXXX")
cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT HUP INT TERM
asset_url="${base%/}/v${version}/${asset}"
curl -fsSL "$asset_url" -o "$scratch/$asset"
curl -fsSL "$asset_url.sha256" -o "$scratch/$asset.sha256"
expected=$(awk 'NR == 1 && $1 ~ /^[0-9a-fA-F]{64}$/ { print tolower($1); exit }' "$scratch/$asset.sha256")
if [ -z "$expected" ]; then
  echo "memoar: checksum file did not contain SHA-256" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$scratch/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$scratch/$asset" | awk '{print $1}')
else
  echo "memoar: sha256sum or shasum is required" >&2
  exit 1
fi
if [ "$actual" != "$expected" ]; then
  echo "memoar: binary checksum mismatch" >&2
  exit 1
fi

mkdir -p "$install_dir"
staged="$install_dir/.memoar-install.$$"
install -m 0755 "$scratch/$asset" "$staged"
mv -f "$staged" "$install_dir/memoar${extension}"
printf 'Installed Memoar %s at %s\n' "$version" "$install_dir/memoar${extension}"
