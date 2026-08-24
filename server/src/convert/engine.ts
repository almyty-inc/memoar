import type { Session } from "../../libs/canonical/src/generated.js";
import { AntigravityCliWriter, ClaudeCodeWriter, CodexWriter } from "./native-writers.js";
import { InjectionFallbackWriter } from "./injection-writer.js";
import type { ConversionBundle, ConversionTarget, NativeWriter } from "./types.js";

export class ConversionEngine {
  private readonly writers = new Map<ConversionTarget, NativeWriter>([
    ["claude-code", new ClaudeCodeWriter()],
    ["codex", new CodexWriter()],
    ["antigravity-cli", new AntigravityCliWriter()],
  ]);
  private readonly injection = new InjectionFallbackWriter();

  supportsNatively(target: string): boolean {
    return this.writers.has(target as ConversionTarget);
  }

  convert(session: Session, target: string, fallback: "fail" | "injection", archiveEvidenceMarkdown?: string): ConversionBundle {
    const writer = this.writers.get(target as ConversionTarget);
    if (writer) return writer.write(session);
    if (fallback === "injection") return this.injection.write(session, target, archiveEvidenceMarkdown);
    throw new Error(`unsupported_conversion_target:${target}`);
  }
}
