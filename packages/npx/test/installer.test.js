"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

const installer = path.resolve(__dirname, "../install.sh");

function installerEnv(overrides) {
  return { ...process.env, MEMOAR_VERSION: "0.1.1", ...overrides };
}

test("POSIX installer maps supported OS and architecture pairs", () => {
  const cases = [
    ["Darwin", "arm64", "gnu", "memoar-aarch64-apple-darwin"],
    ["Darwin", "x86_64", "gnu", "memoar-x86_64-apple-darwin"],
    ["Linux", "aarch64", "gnu", "memoar-aarch64-unknown-linux-gnu"],
    ["Linux", "x86_64", "gnu", "memoar-x86_64-unknown-linux-gnu"],
    ["Linux", "aarch64", "musl", "memoar-aarch64-unknown-linux-musl"],
    ["Linux", "x86_64", "musl", "memoar-x86_64-unknown-linux-musl"],
    ["Windows_NT", "arm64", "gnu", "memoar-aarch64-pc-windows-msvc.exe"],
    ["Windows_NT", "amd64", "gnu", "memoar-x86_64-pc-windows-msvc.exe"]
  ];
  for (const [platform, architecture, libc, expected] of cases) {
    const output = execFileSync("sh", [installer], {
      encoding: "utf8",
      env: installerEnv({
        MEMOAR_OS: platform,
        MEMOAR_ARCH: architecture,
        MEMOAR_LIBC: libc,
        MEMOAR_PRINT_ASSET: "1"
      })
    });
    assert.equal(output.trim(), expected);
  }
});

test("POSIX installer names the same assets the launcher downloads", () => {
  const { assetName } = require("../lib/platform");
  const pairs = [
    ["Darwin", "arm64", "gnu", "darwin", "arm64"],
    ["Linux", "x86_64", "musl", "linux", "x64"],
    ["Windows_NT", "arm64", "gnu", "win32", "arm64"]
  ];
  for (const [os, arch, libc, platform, architecture] of pairs) {
    const output = execFileSync("sh", [installer], {
      encoding: "utf8",
      env: installerEnv({ MEMOAR_OS: os, MEMOAR_ARCH: arch, MEMOAR_LIBC: libc, MEMOAR_PRINT_ASSET: "1" })
    });
    assert.equal(output.trim(), assetName(platform, architecture, libc));
  }
});

function installerUrl(overrides) {
  return execFileSync("sh", [installer], {
    encoding: "utf8",
    env: installerEnv({ MEMOAR_OS: "Linux", MEMOAR_ARCH: "x86_64", MEMOAR_LIBC: "gnu", MEMOAR_PRINT_URL: "1", ...overrides })
  }).trim();
}

test("POSIX installer defaults to the latest GitHub release", () => {
  assert.equal(
    installerUrl({ MEMOAR_VERSION: "", MEMOAR_DOWNLOAD_BASE: "" }),
    "https://github.com/almyty-inc/memoar/releases/latest/download/memoar-x86_64-unknown-linux-gnu"
  );
  assert.equal(
    installerUrl({ MEMOAR_VERSION: "v0.4.0", MEMOAR_DOWNLOAD_BASE: "" }),
    "https://github.com/almyty-inc/memoar/releases/download/v0.4.0/memoar-x86_64-unknown-linux-gnu"
  );
  assert.equal(
    installerUrl({ MEMOAR_VERSION: "0.4.0", MEMOAR_DOWNLOAD_BASE: "https://mirror.example/memoar/" }),
    "https://mirror.example/memoar/v0.4.0/memoar-x86_64-unknown-linux-gnu"
  );
});

test("POSIX installer refuses a mirror without a version", () => {
  assert.throws(
    () => execFileSync("sh", [installer], {
      stdio: "pipe",
      env: installerEnv({
        MEMOAR_OS: "Linux",
        MEMOAR_ARCH: "x86_64",
        MEMOAR_VERSION: "",
        MEMOAR_DOWNLOAD_BASE: "https://mirror.example/memoar"
      })
    }),
    (error) => error.status === 2 && /needs MEMOAR_VERSION/.test(String(error.stderr))
  );
});

function fixtureRelease(checksumOverride) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memoar-install-release-"));
  const release = path.join(root, "v0.1.1");
  fs.mkdirSync(release, { recursive: true });
  const asset = "memoar-x86_64-unknown-linux-gnu";
  const content = "#!/bin/sh\nprintf 'fixture memoar\\n'\n";
  fs.writeFileSync(path.join(release, asset), content, { mode: 0o755 });
  const checksum = checksumOverride || crypto.createHash("sha256").update(content).digest("hex");
  fs.writeFileSync(path.join(release, `${asset}.sha256`), `${checksum}  ${asset}\n`);
  return { root, content };
}

test("POSIX installer verifies checksum and installs atomically to configured directory", () => {
  const fixture = fixtureRelease();
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "memoar-install-bin-"));
  execFileSync("sh", [installer], {
    encoding: "utf8",
    env: installerEnv({
      MEMOAR_OS: "Linux",
      MEMOAR_ARCH: "x86_64",
      MEMOAR_LIBC: "gnu",
      MEMOAR_DOWNLOAD_BASE: `file://${fixture.root}`,
      MEMOAR_INSTALL_DIR: installDir
    })
  });
  const binary = path.join(installDir, "memoar");
  assert.equal(fs.readFileSync(binary, "utf8"), fixture.content);
  assert.equal(execFileSync(binary, { encoding: "utf8" }), "fixture memoar\n");
});

test("POSIX installer rejects checksum mismatch without installing", () => {
  const fixture = fixtureRelease("0".repeat(64));
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "memoar-install-bad-"));
  assert.throws(
    () => execFileSync("sh", [installer], {
      stdio: "pipe",
      env: installerEnv({
        MEMOAR_OS: "Linux",
        MEMOAR_ARCH: "x86_64",
        MEMOAR_LIBC: "gnu",
        MEMOAR_DOWNLOAD_BASE: `file://${fixture.root}`,
        MEMOAR_INSTALL_DIR: installDir
      })
    }),
    /Command failed/
  );
  assert.equal(fs.existsSync(path.join(installDir, "memoar")), false);
});
