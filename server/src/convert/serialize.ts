import { createHash } from "node:crypto";
import { CONTRACT_VERSION } from "../../libs/canonical/src/generated.js";
import { assertMaterializablePaths } from "./bundle-guard.js";
import { bytes, type ConversionBundle } from "./types.js";

/**
 * The report, with its keys in one order both languages compute.
 *
 * `bundle.rs::canonical_json` sorts Rust `String`s, which is a byte
 * comparison. This sorted by `localeCompare`, which is a locale collation: it
 * puts `a` before `Z` where bytes put `Z` first, and ignores punctuation
 * differences bytes do not. The two agree on today's report keys and on nothing
 * guaranteed — and the digest is what the materializer recomputes before it
 * writes, so a key that sorted differently would fail every conversion on every
 * machine and none in CI.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export function serializedBundleObject(bundle: ConversionBundle): Record<string, unknown> {
  assertMaterializablePaths(bundle);
  const files = bundle.files
    .map((file) => ({
      path: file.path,
      mediaType: file.mediaType,
      base64: Buffer.from(file.bytes).toString("base64"),
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
      size: file.bytes.byteLength,
    }))
    .sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const report = canonicalize(bundle.report);
  const manifest = {
    contractVersion: CONTRACT_VERSION,
    bundleVersion: "1",
    target: bundle.target,
    sessionId: bundle.sessionId,
    files: files.map((file) => ({ path: file.path, mediaType: file.mediaType, sha256: file.sha256, size: file.size })),
    resumeCommand: bundle.resumeCommand,
    report,
  };
  const bundleSha256 = createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex");
  return {
    contractVersion: manifest.contractVersion,
    bundleVersion: manifest.bundleVersion,
    target: manifest.target,
    sessionId: manifest.sessionId,
    files,
    resumeCommand: manifest.resumeCommand,
    report,
    bundleSha256,
  };
}

export function serializeBundle(bundle: ConversionBundle): Uint8Array {
  return bytes(JSON.stringify(serializedBundleObject(bundle)));
}
