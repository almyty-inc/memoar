#!/bin/sh
# Installs the Memoar CLI from a GitHub Release.
#
#   curl -fsSL https://github.com/almyty-inc/memoar/releases/latest/download/install.sh | sh
#
# It picks the binary for this OS, CPU and C library, downloads it with its
# .sha256 sidecar, refuses it when the digest does not match, and moves it into
# place atomically.
#
#   MEMOAR_VERSION        a release such as 0.4.0 (default: the latest release)
#   MEMOAR_INSTALL_DIR    where the binary goes (default: ~/.local/bin)
#   MEMOAR_DOWNLOAD_BASE  a mirror laid out as <base>/v<version>/<asset>,
#                         which needs MEMOAR_VERSION
#   MEMOAR_LIBC           gnu or musl, to override detection on Linux
#   MEMOAR_OS, MEMOAR_ARCH             override uname, for tests
#   MEMOAR_PRINT_ASSET=1, MEMOAR_PRINT_URL=1   print the choice and exit
set -eu

repository_releases=https://github.com/almyty-inc/memoar/releases
version=${MEMOAR_VERSION:-}
version=${version#v}
base=${MEMOAR_DOWNLOAD_BASE:-}
install_dir=${MEMOAR_INSTALL_DIR:-"${HOME}/.local/bin"}
os_name=${MEMOAR_OS:-$(uname -s)}
arch_name=${MEMOAR_ARCH:-$(uname -m)}

say() { printf 'memoar: %s\n' "$*"; }
fail() { printf 'memoar: %s\n' "$1" >&2; exit "${2:-1}"; }

# A shell under Rosetta reports x86_64 on Apple silicon. The native binary is
# the one to install there.
if [ "$os_name" = Darwin ] && [ "$arch_name" = x86_64 ] && [ -z "${MEMOAR_ARCH:-}" ]; then
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
    arch_name=arm64
  fi
fi

detect_libc() {
  if [ -n "${MEMOAR_LIBC:-}" ]; then
    printf '%s' "$MEMOAR_LIBC"
  elif ls /lib/ld-musl-* >/dev/null 2>&1 || (ldd --version 2>&1 | grep -qi musl); then
    printf musl
  else
    printf gnu
  fi
}

case "$os_name" in
  Darwin) os_target=apple-darwin; extension= ;;
  Linux)
    libc=$(detect_libc)
    case "$libc" in
      gnu|musl) os_target="unknown-linux-$libc"; extension= ;;
      *) fail "MEMOAR_LIBC must be gnu or musl, not $libc" 2 ;;
    esac ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT) os_target=pc-windows-msvc; extension=.exe ;;
  *) fail "unsupported operating system: $os_name" 2 ;;
esac

case "$arch_name" in
  arm64|aarch64) cpu_target=aarch64 ;;
  x86_64|amd64) cpu_target=x86_64 ;;
  *) fail "unsupported architecture: $arch_name" 2 ;;
esac

asset="memoar-${cpu_target}-${os_target}${extension}"
if [ "${MEMOAR_PRINT_ASSET:-0}" = 1 ]; then
  printf '%s\n' "$asset"
  exit 0
fi

if [ -n "$base" ]; then
  [ -n "$version" ] || fail "MEMOAR_DOWNLOAD_BASE needs MEMOAR_VERSION, because a mirror has no latest" 2
  asset_url="${base%/}/v${version}/${asset}"
elif [ -n "$version" ]; then
  asset_url="${repository_releases}/download/v${version}/${asset}"
else
  asset_url="${repository_releases}/latest/download/${asset}"
fi

if [ "${MEMOAR_PRINT_URL:-0}" = 1 ]; then
  printf '%s\n' "$asset_url"
  exit 0
fi

[ -n "$install_dir" ] || fail "install directory cannot be empty" 2
case "$install_dir" in
  /|.) fail "refusing unsafe install directory: $install_dir" 2 ;;
esac
command -v curl >/dev/null 2>&1 || fail "curl is required"

scratch=$(mktemp -d "${TMPDIR:-/tmp}/memoar-install.XXXXXX")
cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT HUP INT TERM

say "downloading $asset_url"
curl -fsSL --proto '=https,file,http' --retry 3 "$asset_url" -o "$scratch/$asset" \
  || fail "download failed: $asset_url"
curl -fsSL --proto '=https,file,http' --retry 3 "$asset_url.sha256" -o "$scratch/$asset.sha256" \
  || fail "checksum download failed: $asset_url.sha256"
expected=$(awk 'NR == 1 && $1 ~ /^[0-9a-fA-F]+$/ && length($1) == 64 { print tolower($1); exit }' "$scratch/$asset.sha256")
[ -n "$expected" ] || fail "checksum file did not contain SHA-256"

if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$scratch/$asset" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  actual=$(shasum -a 256 "$scratch/$asset" | awk '{print $1}')
else
  fail "sha256sum or shasum is required"
fi
[ "$actual" = "$expected" ] || fail "binary checksum mismatch: expected $expected, got $actual"

mkdir -p "$install_dir"
staged="$install_dir/.memoar-install.$$"
cp "$scratch/$asset" "$staged"
chmod 0755 "$staged"
mv -f "$staged" "$install_dir/memoar${extension}"
installed="$install_dir/memoar${extension}"

reported=$("$installed" --version 2>/dev/null || true)
printf 'Installed %s at %s\n' "${reported:-Memoar ${version:-(latest)}}" "$installed"

case ":${PATH}:" in
  *":${install_dir}:"*) ;;
  *)
    say "$install_dir is not on your PATH. Add it with one of:"
    printf '  sh, bash, zsh:  export PATH="%s:$PATH"   (in ~/.profile, ~/.bashrc or ~/.zshrc)\n' "$install_dir"
    printf '  fish:           fish_add_path %s\n' "$install_dir"
    ;;
esac
