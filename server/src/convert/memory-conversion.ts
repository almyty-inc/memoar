import { createHash } from "node:crypto";
import { BadRequestException } from "@nestjs/common";
import { CONTRACT_VERSION, type MemoryScope } from "../../libs/canonical/src/generated.js";
import { bytes } from "./types.js";
import { memoryDestination, rootPrefix, rulesFileName, type MemoryDialect } from "./memory-dialects.js";

/** One captured file, as the conversion reads it: where it was, and what it said. */
export interface MemorySource {
  path: string;
  text: string;
}

export interface MemoryConversionFile {
  path: string;
  mediaType: string;
  base64: string;
  sha256: string;
  size: number;
  /** The captured files this file was built from, in the order they appear in it. */
  sources: string[];
}

export interface MemoryConversionBundle {
  contractVersion: string;
  bundleVersion: "1";
  kind: "memory";
  source: string;
  target: MemoryDialect;
  scope: MemoryScope;
  workspacePath?: string;
  files: MemoryConversionFile[];
  report: { documents: number; concatenated: boolean };
  bundleSha256: string;
}

/**
 * A memory file is text the person wrote, so a conversion moves the bytes and
 * nothing else. Markdown is the media type every one of these dialects is read
 * as, including the extensionless ones (`.goosehints`, `.rules`).
 */
const MEDIA_TYPE = "text/markdown";

function endsWithNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * The line that says where a part came from, written only when several captured
 * files are being poured into one target file.
 *
 * An HTML comment, because every dialect in the table is read as Markdown and a
 * comment is the one thing that survives into all of them without being read as
 * an instruction. One file to one file carries no note at all: that case is
 * byte-identical, and a note would make it not so.
 */
function sourceNote(path: string): string {
  return `<!-- memoar: from ${path} -->\n\n`;
}

/**
 * Turns the selected documents into the files the target tool reads.
 *
 * Two shapes, decided by the destination and nothing else:
 *
 * - The dialect reads one path (`~/.codex/AGENTS.md`). One document lands in it
 *   byte for byte. Several concatenate, sorted by source path so the same input
 *   always produces the same bytes, each part introduced by a note naming the
 *   file it came from — otherwise the result is a wall of instructions with no
 *   way back to which of your files said what.
 * - The dialect reads a rules directory (`~/.roo/rules`). Every document keeps
 *   its own file, byte for byte, named from its source path. Nothing is
 *   concatenated, because the dialect has somewhere to put each one.
 */
export function planMemoryFiles(
  target: MemoryDialect,
  scope: MemoryScope,
  sources: readonly MemorySource[],
): MemoryConversionFile[] {
  const destination = memoryDestination(target, scope);
  if (!destination) {
    throw new BadRequestException({
      type: "https://memoar.dev/problems/unsupported-memory-dialect",
      title: "That tool has no such file",
      status: 400,
      code: "unsupported_memory_dialect",
      target,
      scope,
      detail: `${target} documents no ${scope} instruction file, so there is nowhere to write one.`,
    });
  }
  const ordered = [...sources].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")));
  const prefix = rootPrefix(scope);
  if (destination.kind === "file") {
    const body = ordered.length === 1
      ? ordered[0]!.text
      : ordered.map((entry) => `${sourceNote(entry.path)}${endsWithNewline(entry.text)}`).join("\n");
    return [describe(`${prefix}${destination.path}`, body, ordered.map((entry) => entry.path))];
  }
  const files = ordered.map((entry) =>
    describe(`${prefix}${destination.path}/${rulesFileName(entry.path)}`, entry.text, [entry.path]));
  const collision = files.find((file, index) => files.findIndex((other) => other.path === file.path) !== index);
  if (collision) {
    throw new BadRequestException({
      type: "https://memoar.dev/problems/memory-name-collision",
      title: "Two files would take the same name",
      status: 400,
      code: "memory_name_collision",
      path: collision.path,
      sources: files.filter((file) => file.path === collision.path).flatMap((file) => file.sources),
      detail: "Two captured files reduce to the same name inside the rules directory. One of them would be lost, so nothing is written.",
    });
  }
  return files;
}

function describe(path: string, text: string, sources: string[]): MemoryConversionFile {
  const encoded = bytes(text);
  return {
    path,
    mediaType: MEDIA_TYPE,
    base64: Buffer.from(encoded).toString("base64"),
    sha256: createHash("sha256").update(encoded).digest("hex"),
    size: encoded.byteLength,
    sources,
  };
}

/**
 * The digest the materializer recomputes before it writes anything.
 *
 * Over the manifest rather than over the bytes: the same shape the session
 * bundle uses, so one reader verifies both, and the per-file `sha256` already
 * covers the content.
 */
export function memoryBundleSha256(bundle: Omit<MemoryConversionBundle, "bundleSha256">): string {
  const manifest = {
    contractVersion: bundle.contractVersion,
    bundleVersion: bundle.bundleVersion,
    kind: bundle.kind,
    source: bundle.source,
    target: bundle.target,
    scope: bundle.scope,
    workspacePath: bundle.workspacePath ?? null,
    files: bundle.files.map((file) => ({ path: file.path, mediaType: file.mediaType, sha256: file.sha256, size: file.size })),
    report: bundle.report,
  };
  return createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex");
}

export function buildMemoryBundle(input: {
  source: string;
  target: MemoryDialect;
  scope: MemoryScope;
  workspacePath?: string;
  sources: readonly MemorySource[];
}): MemoryConversionBundle {
  const files = planMemoryFiles(input.target, input.scope, input.sources);
  const withoutDigest: Omit<MemoryConversionBundle, "bundleSha256"> = {
    contractVersion: CONTRACT_VERSION,
    bundleVersion: "1",
    kind: "memory",
    source: input.source,
    target: input.target,
    scope: input.scope,
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    files,
    report: {
      documents: input.sources.length,
      concatenated: files.some((file) => file.sources.length > 1),
    },
  };
  return { ...withoutDigest, bundleSha256: memoryBundleSha256(withoutDigest) };
}
