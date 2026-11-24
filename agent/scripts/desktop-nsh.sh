# Sourced by test-desktop.sh and package-desktop.sh: the pinned NSH CLI and
# where the desktop app lives. Keep NSH_VERSION equal to the `nsh-*` versions
# in agent/crates/memoar-desktop/Cargo.toml.

NSH_VERSION=0.2.0
desktop_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../crates/memoar-desktop" && pwd)

# Installs `nsh` from crates.io unless the pinned version is already on PATH.
ensure_nsh() {
  if command -v nsh >/dev/null 2>&1 && nsh -V 2>/dev/null | grep -q "^nsh $NSH_VERSION"; then
    return
  fi
  echo "memoar desktop: installing nsh $NSH_VERSION" >&2
  cargo install nsh-cli --version "$NSH_VERSION" --locked
}

# The desktop this runs on, as `nsh package --target` names it.
host_target() {
  case "$(uname -s)" in
    Darwin) echo macos ;;
    Linux) echo linux ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT) echo windows ;;
    *)
      echo "memoar desktop: unsupported system $(uname -s)" >&2
      return 1
      ;;
  esac
}

# `.exe` on Windows, nothing elsewhere.
exe_suffix() {
  if [ "$(host_target)" = windows ]; then echo .exe; fi
}
