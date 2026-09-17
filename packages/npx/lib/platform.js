"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");

/**
 * Where release binaries live.
 *
 * The launcher asks for `${base}/v${version}/${asset}`, which is the layout a
 * GitHub Release produces. Point MEMOAR_DOWNLOAD_BASE somewhere else to install
 * from a mirror or from a bucket of your own.
 *
 * Until a release exists at this address the download fails and the launcher
 * falls back to a locally built binary, which is what it did before there was
 * any default at all.
 */
const DEFAULT_DOWNLOAD_BASE = "https://github.com/almyty-inc/memoar/releases/download";

/**
 * Which agent release this launcher installs.
 *
 * Deliberately not the launcher's own package version. The two are separate
 * artifacts: a fix to the launcher — a wrong URL, a README — ships without
 * rebuilding the agent, and the agent's version is tied to the canonical
 * contract, which does not move because a Node package needed republishing.
 *
 * A test holds this to the version in agent/Cargo.toml, because it selects the
 * release tag the binary is fetched from.
 */
const AGENT_VERSION = "0.3.0";

const TARGETS = Object.freeze({
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "win32-x64": "x86_64-pc-windows-msvc"
});

function targetFor(platform = process.platform, architecture = process.arch) {
  const target = TARGETS[`${platform}-${architecture}`];
  if (!target) {
    throw new Error(`Memoar does not publish a binary for ${platform}-${architecture}`);
  }
  return target;
}

function executableName(platform = process.platform) {
  return platform === "win32" ? "memoar.exe" : "memoar";
}

function assetName(platform = process.platform, architecture = process.arch) {
  return `memoar-${targetFor(platform, architecture)}${platform === "win32" ? ".exe" : ""}`;
}

function cachePath(options = {}) {
  const version = options.version || AGENT_VERSION;
  const platform = options.platform || process.platform;
  const architecture = options.architecture || process.arch;
  const root = options.cacheRoot || process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(root, "memoar", version, assetName(platform, architecture));
}

function checksumPath(binary) {
  return `${binary}.sha256`;
}

/** Where to fetch from: an explicit option, the environment, or the release channel. */
function downloadBase(options = {}) {
  const base = options.downloadBase || process.env.MEMOAR_DOWNLOAD_BASE || DEFAULT_DOWNLOAD_BASE;
  return base.replace(/\/$/, "");
}

/**
 * The exact address of one platform's binary.
 *
 * The release workflow names its assets with `assetName`, so the two cannot
 * drift without a test noticing.
 */
function downloadUrl(options = {}) {
  const version = options.version || AGENT_VERSION;
  const asset = assetName(options.platform || process.platform, options.architecture || process.arch);
  return `${downloadBase(options)}/v${version}/${asset}`;
}

function isExecutable(candidate, platform = process.platform) {
  if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
    return false;
  }
  if (platform === "win32") {
    return true;
  }
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function explicitCandidate(options = {}) {
  const candidate = options.binary || process.env.MEMOAR_BINARY;
  if (!candidate) {
    return null;
  }
  const resolved = path.resolve(candidate);
  if (!isExecutable(resolved, options.platform)) {
    throw new Error(`MEMOAR_BINARY is not executable: ${resolved}`);
  }
  return resolved;
}

function cachedCandidate(options = {}) {
  const candidate = cachePath(options);
  const sidecar = checksumPath(candidate);
  if (!isExecutable(candidate, options.platform) || !fs.existsSync(sidecar)) {
    return null;
  }
  try {
    const expected = parseChecksum(fs.readFileSync(sidecar, "utf8"));
    verifySha256(candidate, expected);
    return candidate;
  } catch {
    fs.rmSync(candidate, { force: true });
    fs.rmSync(sidecar, { force: true });
    return null;
  }
}

function localCandidates(options = {}) {
  if (options.localCandidates) {
    return options.localCandidates;
  }
  const platform = options.platform || process.platform;
  const binary = executableName(platform);
  const packageRoot = path.resolve(__dirname, "..");
  const candidates = [
    path.join(packageRoot, "vendor", targetFor(platform, options.architecture), binary),
    path.resolve(packageRoot, "../../agent/target/release", binary),
    path.resolve(packageRoot, "../../agent/target/debug", binary)
  ];
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (directory) {
      candidates.push(path.join(directory, binary));
    }
  }
  return candidates;
}

function localCandidate(options = {}) {
  const launcher = safeRealpath(process.argv[1]);
  for (const candidate of localCandidates(options)) {
    if (isExecutable(candidate, options.platform) && safeRealpath(candidate) !== launcher) {
      return path.resolve(candidate);
    }
  }
  return null;
}

function safeRealpath(candidate) {
  if (!candidate) {
    return null;
  }
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

async function ensureBinary(options = {}) {
  const explicit = explicitCandidate(options);
  if (explicit) {
    return explicit;
  }
  const cached = cachedCandidate(options);
  if (cached) {
    return cached;
  }
  if (options.preferLocal || process.env.MEMOAR_PREFER_LOCAL === "1") {
    const local = localCandidate(options);
    if (local) {
      return local;
    }
  }
  let downloadError;
  if (process.env.MEMOAR_NO_DOWNLOAD !== "1" && options.download !== false) {
    try {
      const downloader = options.downloader || downloadBinary;
      return await downloader(options);
    } catch (error) {
      downloadError = error;
    }
  }
  const local = localCandidate(options);
  if (local) {
    return local;
  }
  const detail = downloadError ? ` Download failed: ${downloadError.message}` : "";
  throw new Error(`No Memoar binary is available.${detail}`);
}

async function downloadBinary(options = {}) {
  const version = options.version || AGENT_VERSION;
  const platform = options.platform || process.platform;
  const architecture = options.architecture || process.arch;
  const asset = assetName(platform, architecture);
  const url = downloadUrl({ ...options, version, platform, architecture });
  const destination = cachePath({ ...options, version, platform, architecture });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const lock = await acquireLock(`${destination}.lock`, options.lockTimeoutMs || 30000);
  try {
    const existing = cachedCandidate({ ...options, version, platform, architecture });
    if (existing) {
      return existing;
    }
    const expected = options.sha256 || process.env.MEMOAR_BINARY_SHA256 ||
      parseChecksum(await fetchText(`${url}.sha256`, 5));
    const temporary = `${destination}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
    try {
      await fetchToFile(url, temporary, 5);
      verifySha256(temporary, expected);
      if (platform !== "win32") {
        fs.chmodSync(temporary, 0o755);
      }
      fs.renameSync(temporary, destination);
      const sidecarTemporary = `${checksumPath(destination)}.${process.pid}.tmp`;
      fs.writeFileSync(sidecarTemporary, `${expected.toLowerCase()}  ${asset}\n`, { mode: 0o600 });
      fs.renameSync(sidecarTemporary, checksumPath(destination));
      return destination;
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      fs.rmSync(destination, { force: true });
      fs.rmSync(checksumPath(destination), { force: true });
      throw error;
    }
  } finally {
    lock.release();
  }
}

async function acquireLock(lockPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = fs.openSync(lockPath, "wx", 0o600);
      fs.writeFileSync(handle, `${process.pid}\n`);
      return {
        release() {
          fs.closeSync(handle);
          fs.rmSync(lockPath, { force: true });
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > 5 * 60 * 1000) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for download lock ${lockPath}`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

function fetchToFile(url, destination, redirectsRemaining) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https:") ? https : http;
    const request = transport.get(url, { headers: { "user-agent": "memoar-npx/0.1.1" } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectsRemaining === 0) {
          reject(new Error("too many download redirects"));
          return;
        }
        const next = new URL(response.headers.location, url).toString();
        fetchToFile(next, destination, redirectsRemaining - 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`binary download returned HTTP ${response.statusCode}`));
        return;
      }
      const output = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
      response.pipe(output);
      output.on("finish", () => output.close(resolve));
      output.on("error", reject);
    });
    request.on("error", reject);
  });
}

function fetchText(url, redirectsRemaining) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith("https:") ? https : http;
    const request = transport.get(url, { headers: { "user-agent": "memoar-npx/0.1.1" } }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirectsRemaining === 0) {
          reject(new Error("too many checksum redirects"));
          return;
        }
        fetchText(new URL(response.headers.location, url).toString(), redirectsRemaining - 1)
          .then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`checksum download returned HTTP ${response.statusCode}`));
        return;
      }
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        text += chunk;
        if (text.length > 16384) {
          request.destroy(new Error("checksum response is too large"));
        }
      });
      response.on("end", () => resolve(text));
    });
    request.on("error", reject);
  });
}

function parseChecksum(text) {
  const match = text.trim().match(/^([a-fA-F0-9]{64})(?:\s|$)/);
  if (!match) {
    throw new Error("checksum response did not begin with a SHA-256 digest");
  }
  return match[1].toLowerCase();
}

function verifySha256(file, expected) {
  if (!/^[a-fA-F0-9]{64}$/.test(expected)) {
    throw new Error("expected checksum is not a SHA-256 digest");
  }
  const actual = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== expected.toLowerCase()) {
    throw new Error(`binary checksum mismatch: expected ${expected}, got ${actual}`);
  }
}

module.exports = {
  AGENT_VERSION,
  DEFAULT_DOWNLOAD_BASE,
  TARGETS,
  assetName,
  cachePath,
  cachedCandidate,
  downloadBase,
  downloadBinary,
  downloadUrl,
  ensureBinary,
  executableName,
  localCandidate,
  parseChecksum,
  targetFor,
  verifySha256
};
