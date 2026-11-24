"use strict";

// install.ps1 runs under Windows PowerShell 5.1 and PowerShell 7. These tests
// need some `pwsh` (or `powershell` on Windows) and are skipped without one.
// The release workflow runs them on its Windows runner.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const test = require("node:test");
const { assetName } = require("../lib/platform");

const installer = path.resolve(__dirname, "../install.ps1");

function findPowerShell() {
  for (const candidate of ["pwsh", "powershell"]) {
    try {
      execFileSync(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { stdio: "pipe" });
      return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

const shell = findPowerShell();
const skip = shell ? false : "no PowerShell on this machine";

function run(env) {
  return new Promise((resolve) => {
    execFile(
      shell,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", installer],
      { encoding: "utf8", env: { ...process.env, MEMOAR_VERSION: "", MEMOAR_DOWNLOAD_BASE: "", ...env } },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr })
    );
  });
}

function serve(files) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      const body = files[request.url];
      if (body === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200).end(body);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("PowerShell installer maps both Windows architectures to the launcher's assets", { skip }, async () => {
  for (const [arch, architecture] of [["AMD64", "x64"], ["x64", "x64"], ["ARM64", "arm64"], ["Arm64", "arm64"]]) {
    const result = await run({ MEMOAR_ARCH: arch, MEMOAR_PRINT_ASSET: "1" });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), assetName("win32", architecture));
  }
  const refused = await run({ MEMOAR_ARCH: "x86", MEMOAR_PRINT_ASSET: "1" });
  assert.notEqual(refused.code, 0);
});

test("PowerShell installer defaults to the latest GitHub release", { skip }, async () => {
  const latest = await run({ MEMOAR_ARCH: "x64", MEMOAR_PRINT_URL: "1" });
  assert.equal(latest.stdout.trim(), "https://github.com/almyty-inc/memoar/releases/latest/download/memoar-x86_64-pc-windows-msvc.exe");
  const pinned = await run({ MEMOAR_ARCH: "arm64", MEMOAR_VERSION: "v0.4.0", MEMOAR_PRINT_URL: "1" });
  assert.equal(pinned.stdout.trim(), "https://github.com/almyty-inc/memoar/releases/download/v0.4.0/memoar-aarch64-pc-windows-msvc.exe");
  const mirror = await run({ MEMOAR_ARCH: "x64", MEMOAR_DOWNLOAD_BASE: "https://mirror.example/m", MEMOAR_PRINT_URL: "1" });
  assert.notEqual(mirror.code, 0, "a mirror without a version must be refused");
});

async function installFrom(checksum) {
  const asset = "memoar-x86_64-pc-windows-msvc.exe";
  const content = Buffer.from("fixture memoar binary\n");
  const digest = checksum || crypto.createHash("sha256").update(content).digest("hex");
  const server = await serve({
    [`/v9.9.9/${asset}`]: content,
    [`/v9.9.9/${asset}.sha256`]: `${digest} *${asset}\n`
  });
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), "memoar-ps1-"));
  try {
    const result = await run({
      MEMOAR_ARCH: "x64",
      MEMOAR_VERSION: "9.9.9",
      MEMOAR_DOWNLOAD_BASE: `http://127.0.0.1:${server.address().port}`,
      MEMOAR_INSTALL_DIR: installDir,
      MEMOAR_NO_MODIFY_PATH: "1"
    });
    return { result, installed: path.join(installDir, "memoar.exe"), content };
  } finally {
    server.close();
  }
}

test("PowerShell installer verifies the checksum and installs", { skip }, async () => {
  const { result, installed, content } = await installFrom();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(installed), content);
});

test("PowerShell installer refuses a checksum mismatch and installs nothing", { skip }, async () => {
  const { result, installed } = await installFrom("0".repeat(64));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr + result.stdout, /checksum mismatch/);
  assert.equal(fs.existsSync(installed), false);
});
