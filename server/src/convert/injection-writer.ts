import type { Session } from "../../libs/canonical/src/generated.js";
import { bytes, freshReport, textForDegraded, type ConversionBundle } from "./types.js";

export class InjectionFallbackWriter {
  constructor(private readonly maxTokens = 4000) {}

  write(session: Session, target: string, archiveEvidenceMarkdown?: string): ConversionBundle {
    const report = freshReport();
    report.fallback = true;
    const maximumCharacters = this.maxTokens * 4;
    const includedSections: string[] = [];
    const includedOrdinals: number[] = [];
    const omittedOrdinals: number[] = [];
    let usedCharacters = 0;
    for (const turn of session.turns) {
      const section = `## [${session.id} turn ${turn.ordinal}] ${turn.role}\n${turn.blocks.map(textForDegraded).join("\n")}\n`;
      if (usedCharacters + section.length > maximumCharacters) {
        omittedOrdinals.push(turn.ordinal);
        report.dropped.push({ reference: `turn:${turn.id}`, reason: "injection_token_budget_exceeded" });
        continue;
      }
      usedCharacters += section.length;
      includedSections.push(section);
      includedOrdinals.push(turn.ordinal);
    }
    report.mapped = includedOrdinals.length;
    const truncationReport = [
      "## Truncation report",
      `Token budget: ${this.maxTokens} (~${maximumCharacters} characters). Used: ~${Math.ceil(usedCharacters / 4)} tokens.`,
      `Included ${includedOrdinals.length} of ${session.turns.length} turns.`,
      omittedOrdinals.length
        ? `Omitted turns (budget exceeded): ${omittedOrdinals.join(", ")}. Retrieve them from the Memoar archive, session ${session.id}.`
        : "No turns were omitted.",
    ].join("\n");
    const prelude = [
      "# Memoar context prelude",
      `Original session: ${session.id}`,
      `Original source: ${session.source.tool}`,
      "",
      "Every excerpt below cites its source as [sessionId turn ordinal].",
      "",
      ...(archiveEvidenceMarkdown ? ["## Related archive evidence (cited)", "", archiveEvidenceMarkdown, ""] : []),
      "## Session transcript (token-budgeted)",
      "",
      includedSections.join("\n"),
      "",
      truncationReport,
    ].join("\n");
    return {
      target,
      sessionId: session.id,
      files: [{ path: `memoar-injection-${session.id}.md`, mediaType: "text/markdown", bytes: bytes(prelude) }],
      resumeCommand: `Start ${target} and paste memoar-injection-${session.id}.md as the first message`,
      report,
    };
  }
}
