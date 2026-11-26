import type { ContentBlock, Session } from "../../libs/canonical/src/generated.js";

export type ConversionTarget = "claude-code" | "codex" | "antigravity-cli";

export interface ConversionFile {
  path: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface ConversionReport {
  mapped: number;
  degraded: { turnId: string; blockId: string; kind: string; reason: string }[];
  dropped: { reference: string; reason: string }[];
  fallback: boolean;
}

export interface ConversionBundle {
  target: string;
  sessionId: string;
  files: ConversionFile[];
  resumeCommand: string;
  report: ConversionReport;
}

/**
 * How the caller wants the session placed.
 *
 * `workspacePath` is the directory the person will resume from. `memoar convert
 * --here` sends the current directory. Each tool files a session by the
 * directory it was started in, so a session written for the archived
 * workspace is invisible to a resume run anywhere else.
 */
export interface WriteOptions {
  workspacePath?: string;
}

export function textForDegraded(block: ContentBlock): string {
  const payload = block.text ?? block.name ?? block.artifactRef ?? JSON.stringify(block.data ?? {});
  return `[Memoar ${block.kind}] ${payload}`;
}

export function freshReport(): ConversionReport {
  return { mapped: 0, degraded: [], dropped: [], fallback: false };
}

export function bytes(value: string): Uint8Array { return Buffer.from(value, "utf8"); }

export interface NativeWriter {
  readonly target: ConversionTarget;
  write(session: Session, options?: WriteOptions): ConversionBundle;
}
