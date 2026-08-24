import type { ContentBlock, Session, Turn } from "../../libs/canonical/src/generated.js";

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

export function textForDegraded(block: ContentBlock): string {
  const payload = block.text ?? block.name ?? block.artifactRef ?? JSON.stringify(block.data ?? {});
  return `[Memoar ${block.kind}] ${payload}`;
}

export function nativeBlocks(turn: Turn, report: ConversionReport): Record<string, unknown>[] {
  return turn.blocks.map((block) => {
    if (block.kind === "text" || block.kind === "thinking" || block.kind === "tool_call" || block.kind === "tool_result") {
      report.mapped += 1;
      return {
        id: block.id,
        kind: block.kind,
        ...(block.text ? { text: block.text } : {}),
        ...(block.name ? { name: block.name } : {}),
        ...(block.callId ? { callId: block.callId } : {}),
        ...(block.data ? { data: block.data } : {}),
      };
    }
    report.degraded.push({ turnId: turn.id, blockId: block.id, kind: block.kind, reason: "Target has no stable native representation" });
    return { id: block.id, kind: "text", text: textForDegraded(block) };
  });
}

export function freshReport(): ConversionReport {
  return { mapped: 0, degraded: [], dropped: [], fallback: false };
}

export function bytes(value: string): Uint8Array { return Buffer.from(value, "utf8"); }

export interface NativeWriter {
  readonly target: ConversionTarget;
  write(session: Session): ConversionBundle;
}
