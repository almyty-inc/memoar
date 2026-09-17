"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  assetName,
  cachePath,
  cachedCandidate,
  downloadBinary,
  downloadUrl,
  ensureBinary,
  parseChecksum,
  targetFor,
  verifySha256
} = require("../lib/platform");

test("maps every supported Node platform and architecture", () => {
  assert.equal(targetFor("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(targetFor("darwin", "x64"), "x86_64-apple-darwin");
  assert.equal(targetFor("linux", "arm64"), "aarch64-unknown-linux-gnu");
  assert.equal(targetFor("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(targetFor("win32", "arm64"), "aarch64-pc-windows-msvc");
  assert.equal(targetFor("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.throws(() => targetFor("freebsd", "x64"), /does not publish/);
  assert.equal(assetName("win32", "x64"), "memoar-x86_64-pc-windows-msvc.exe");
});

test("has a release channel to download from without being told one", () => {
  // There was no default at all, so `npx memoar` could install nothing: it
  // demanded an environment variable naming a channel that did not exist. That
  // is the whole reason the published instruction failed on its first line.
  const previous = process.env.MEMOAR_DOWNLOAD_BASE;
  delete process.env.MEMOAR_DOWNLOAD_BASE;
  try {
    const url = downloadUrl({ platform: "linux", architecture: "x64", version: "0.3.0" });
    assert.match(url, /^https:\/\//);
    assert.equal(url, "https://github.com/almyty-inc/memoar-releases/releases/download/v0.3.0/memoar-x86_64-unknown-linux-gnu");
  } finally {
    if (previous === undefined) {
      delete process.env.MEMOAR_DOWNLOAD_BASE;
    } else {
      process.env.MEMOAR_DOWNLOAD_BASE = previous;
    }
  }
});

test("an explicit base still wins, for a mirror or a private bucket", () => {
  assert.equal(
    downloadUrl({ downloadBase: "https://downloads.example/memoar/", platform: "darwin", architecture: "arm64", version: "1.2.3" }),
    "https://downloads.example/memoar/v1.2.3/memoar-aarch64-apple-darwin"
  );
});

test("asks for the exact asset name the release workflow writes", () => {
  // The workflow builds `memoar-<target>` from the same target table. If these
  // drift, every install 404s and no test would have said so.
  assert.equal(assetName("linux", "x64"), "memoar-x86_64-unknown-linux-gnu");
  assert.equal(assetName("darwin", "arm64"), "memoar-aarch64-apple-darwin");
  assert.equal(assetName("win32", "x64"), "memoar-x86_64-pc-windows-msvc.exe");
});

test("uses an explicit local binary without downloading", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memoar-npx-"));
  const binary = path.join(directory, "memoar");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const resolved = await ensureBinary({ binary, platform: "linux", architecture: "x64" });
  assert.equal(resolved, binary);
});

test("falls back to a local development binary after download failure", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memoar-npx-"));
  const binary = path.join(directory, "memoar");
  fs.writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const resolved = await ensureBinary({
    version: "0.1.1",
    platform: "linux",
    architecture: "x64",
    cacheRoot: path.join(directory, "cache"),
    localCandidates: [binary],
    downloader: async () => {
      throw new Error("offline");
    }
  });
  assert.equal(resolved, binary);
});

test("cache location and checksum parsing are deterministic", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memoar-npx-"));
  const binary = path.join(directory, "memoar");
  fs.writeFileSync(binary, "memoar");
  const checksum = crypto.createHash("sha256").update("memoar").digest("hex");
  assert.equal(parseChecksum(`${checksum}  memoar\n`), checksum);
  assert.doesNotThrow(() => verifySha256(binary, checksum));
  assert.throws(() => verifySha256(binary, "0".repeat(64)), /checksum mismatch/);
  assert.throws(() => parseChecksum("not-a-digest"), /did not begin/);
  assert.equal(
    cachePath({ cacheRoot: directory, version: "0.1.1", platform: "linux", architecture: "x64" }),
    path.join(directory, "memoar", "0.1.1", "memoar-x86_64-unknown-linux-gnu")
  );
});

async function fixtureRelease(binary, checksumOverride) {
  let requests = 0;
  const checksum = checksumOverride || crypto.createHash("sha256").update(binary).digest("hex");
  const server = http.createServer((request, response) => {
    requests += 1;
    if (request.url.endsWith(".sha256")) {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(`${checksum}  memoar-x86_64-unknown-linux-gnu\n`);
      return;
    }
    response.writeHead(200, { "content-type": "application/octet-stream" });
    response.end(binary);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(resolve => server.close(resolve)),
    requests: () => requests
  };
}

test("downloads, verifies, caches, and re-verifies a release asset", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memoar-npx-http-"));
  const release = await fixtureRelease(Buffer.from("#!/bin/sh\nexit 0\n"));
  const options = {
    version: "0.1.1",
    platform: "linux",
    architecture: "x64",
    cacheRoot: directory,
    downloadBase: release.base
  };
  const binary = await downloadBinary(options);
  assert.equal(fs.readFileSync(binary, "utf8"), "#!/bin/sh\nexit 0\n");
  assert.equal(cachedCandidate(options), binary);
  assert.equal(await ensureBinary(options), binary);
  assert.equal(release.requests(), 2, "cache hit must not make another request");
  await release.close();
});

test("checksum mismatch leaves no cached executable", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memoar-npx-bad-"));
  const release = await fixtureRelease(Buffer.from("tampered"), "0".repeat(64));
  const options = {
    version: "0.1.1",
    platform: "linux",
    architecture: "x64",
    cacheRoot: directory,
    downloadBase: release.base
  };
  await assert.rejects(downloadBinary(options), /checksum mismatch/);
  assert.equal(cachedCandidate(options), null);
  assert.equal(fs.existsSync(cachePath(options)), false);
  await release.close();
});

test("concurrent callers share one locked download", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "memoar-npx-lock-"));
  const release = await fixtureRelease(Buffer.from("binary"));
  const options = {
    version: "0.1.1",
    platform: "linux",
    architecture: "x64",
    cacheRoot: directory,
    downloadBase: release.base
  };
  const [first, second] = await Promise.all([downloadBinary(options), downloadBinary(options)]);
  assert.equal(first, second);
  assert.equal(release.requests(), 2, "one checksum and one binary request expected");
  await release.close();
});

test("asks for the version of the agent that is actually released", () => {
  /*
    The launcher downloads `/v${its own version}/`, so its version is not
    cosmetic: it selects which release it installs. It sat at 0.2.0 while the
    agent was 0.3.0, which would have 404'd every install the moment the
    package was published — the failure arriving after `npx` had already
    fetched the launcher, which is a worse place to find out.
  */
  const manifest = fs.readFileSync(path.resolve(__dirname, "../../../agent/Cargo.toml"), "utf8");
  const workspaceVersion = manifest.match(/^\s*version\s*=\s*"([^"]+)"/m);
  assert.ok(workspaceVersion, "agent/Cargo.toml must declare a workspace version");
  assert.equal(
    require("../package.json").version,
    workspaceVersion[1],
    "the launcher's version selects the release it downloads, so it must be the agent's"
  );
});
