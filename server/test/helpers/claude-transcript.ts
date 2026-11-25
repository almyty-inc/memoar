import { createHash } from "node:crypto";

/**
 * A synthetic Claude Code transcript shaped like the ones the agent uploads.
 *
 * Real transcripts are mostly tool traffic. A prompt is followed by assistant
 * turns that call tools, and each call is answered by a user turn carrying the
 * tool's output, which is where the bytes are: a 100 MB transcript in the dev
 * archive held about 14,000 turns and 14,000 blocks. Every line here is made of
 * generated words, so nothing in it came from a real session.
 */
export interface SyntheticTranscriptOptions {
  /** Roughly how large the file should be. */
  targetBytes: number;
  /** The transcript's own session id. Derived from `seed` when omitted. */
  sessionId?: string;
  /** Varies ids and text, so two transcripts never share turn ids. */
  seed?: string;
  /** Bytes of tool output per tool result. Real ones average about 8 KB. */
  toolOutputBytes?: number;
}

const WORDS = ["archive", "session", "parser", "worker", "queue", "turn", "block", "index", "migration", "tenant", "search", "build", "deploy", "review", "commit", "branch", "schema", "fixture", "budget", "latency"];

/** A uuid derived from a name, so the same options give the same file. */
export function syntheticUuid(name: string): string {
  const hex = createHash("sha256").update(name).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function words(count: number, offset: number): string {
  const out: string[] = [];
  for (let index = 0; index < count; index += 1) out.push(WORDS[(index * 7 + offset) % WORDS.length]!);
  return out.join(" ");
}

export function syntheticClaudeTranscript(options: SyntheticTranscriptOptions): Buffer {
  const seed = options.seed ?? "synthetic";
  const sessionId = options.sessionId ?? syntheticUuid(`${seed}:session`);
  const outputBytes = options.toolOutputBytes ?? 8_000;
  // One output body, sliced per result: building a fresh one per line made the
  // generator slower than the code it exercises.
  const output = words(Math.ceil(outputBytes / 6) + 40, 3);
  const lines: string[] = [];
  let bytes = 0;
  let parent: string | null = null;
  let ordinal = 0;
  const push = (type: "user" | "assistant", content: unknown[], extra: Record<string, unknown> = {}): void => {
    const uuid = syntheticUuid(`${seed}:turn:${ordinal}`);
    const line = JSON.stringify({
      parentUuid: parent,
      isSidechain: false,
      userType: "external",
      cwd: "/workspace/synthetic",
      sessionId,
      version: "2.0.0",
      gitBranch: "main",
      type,
      uuid,
      timestamp: new Date(Date.UTC(2026, 10, 25, 9, 0, 0) + ordinal * 1000).toISOString(),
      message: { role: type, content, ...extra },
    });
    lines.push(line);
    bytes += line.length + 1;
    parent = uuid;
    ordinal += 1;
  };
  for (let exchange = 0; bytes < options.targetBytes; exchange += 1) {
    push("user", [{ type: "text", text: `Step ${exchange}: ${words(30, exchange)}` }]);
    for (let call = 0; call < 3 && bytes < options.targetBytes; call += 1) {
      const callId = `toolu_${seed}_${exchange}_${call}`;
      push("assistant", [
        { type: "text", text: `Checking ${words(12, exchange + call)}` },
        { type: "tool_use", id: callId, name: "Bash", input: { command: `grep -rn ${WORDS[call]} src`, description: words(6, call) } },
      ], { model: "claude-synthetic", usage: { input_tokens: 1200, output_tokens: 80 } });
      const start = (exchange * 13 + call * 7) % 40;
      push("user", [{ type: "tool_result", tool_use_id: callId, content: output.slice(start, start + outputBytes) }]);
    }
  }
  return Buffer.from(`${lines.join("\n")}\n`);
}
