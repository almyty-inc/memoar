# Memoar launcher and installer

This directory contains the release launcher source. It is private until a package name and release channel are approved; it is not currently published to a registry.

The Node launcher selects the release asset for the current operating system and architecture, downloads its mandatory `.sha256` sidecar, verifies the binary, and stores both under the user cache directory. Concurrent downloads share a lock. Set `MEMOAR_BINARY` to use a specific local build, or `MEMOAR_NO_DOWNLOAD=1` to require a local binary. If a download fails, the launcher checks the adjacent Rust workspace and `PATH`.

The POSIX installer performs the same OS/architecture selection and mandatory checksum verification. `MEMOAR_VERSION`, `MEMOAR_DOWNLOAD_BASE`, and `MEMOAR_INSTALL_DIR` configure it:

```sh
MEMOAR_INSTALL_DIR="$PWD/.memoar-bin" ./install.sh
```

Supported targets are macOS on Apple Silicon or x64, Linux on arm64 or x64, and Windows on arm64 or x64. The scripts do not create releases or publish packages.
