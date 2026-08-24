import { createHash } from "node:crypto";
import { CONTRACT_VERSION } from "../../libs/canonical/src/generated.js";
import { bytes, type ConversionBundle } from "./types.js";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]));
  }
  return value;
}

export function serializedBundleObject(bundle: ConversionBundle): Record<string, unknown> {
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
