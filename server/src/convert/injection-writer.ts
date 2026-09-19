import type { ContentBlock, Session, Turn } from "../../libs/canonical/src/generated.js";
import { bytes, freshReport, textForDegraded, type ConversionBundle, type ConversionReport } from "./types.js";

/** A turn rendered for the prelude, with the cost of including it. */
interface Section {
  turn: Turn;
  text: string;
}

/**
 * One block as the prelude shows it.
 *
 * A marker means the prelude could not show the block's shape, which is never
 * true of plain text. Every block used to get one, so a paragraph came out as
 * `[Memoar text] …` — and a prelude is pasted into another tool, captured from
 * it, and converted again, so the next pass wrapped the wrapper:
 * `[Memoar text] [Memoar text] …`, growing a layer per round with nothing
 * counting it as degraded.
 */
function excerpt(block: ContentBlock): string {
  return block.kind === "text" ? block.text ?? "" : textForDegraded(block);
}

function render(session: Session, turn: Turn): Section {
  return { turn, text: `## [${session.id} turn ${turn.ordinal}] ${turn.role}\n${turn.blocks.map(excerpt).join("\n")}\n` };
}

/** "38", or "38-3961" — an omission is reported as a range, not turn by turn. */
function describeRange(from: number, to: number): string {
  return from === to ? `${from}` : `${from}-${to}`;
}

/**
 * Writes a paste-in prelude for a target with no native format.
 *
 * What it must decide is which part of a long conversation survives a token
 * budget: the first turn, which states the task, and then as much of the end as
 * fits, contiguously. That is what somebody resuming needs — not the opening
 * alone, and not whichever later turns happened to be short enough to squeeze
 * in, which would prefer the "ok"s over the substance.
 */
export class InjectionFallbackWriter {
  constructor(private readonly maxTokens = 4000) {}

  write(session: Session, target: string, archiveEvidenceMarkdown?: string): ConversionBundle {
    const report = freshReport();
    report.fallback = true;
    const budget = this.maxTokens * 4;
    const sections = session.turns.map((turn) => render(session, turn));
    const { opening, tail } = this.select(sections, budget, report);

    const included = opening ? [opening, ...tail] : tail;
    report.mapped = included.length;
    const omitted = this.omissions(sections, included, report);
    const usedCharacters = included.reduce((total, section) => total + section.text.length, 0);

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
      ...(opening && tail.length ? [opening.text, "", `_… ${omitted} …_`, ""] : []),
      ...(opening && !tail.length ? [opening.text, ""] : []),
      tail.map((section) => section.text).join("\n"),
      "",
      "## Truncation report",
      `Token budget: ${this.maxTokens} (~${budget} characters). Used: ~${Math.ceil(usedCharacters / 4)} tokens.`,
      `Included ${included.length} of ${session.turns.length} turns: the first, then the most recent that fit.`,
      omitted ? `Omitted ${omitted}. Retrieve them from the Memoar archive, session ${session.id}.` : "No turns were omitted.",
    ].join("\n");

    return {
      target,
      sessionId: session.id,
      files: [{ path: `memoar-injection-${session.id}.md`, mediaType: "text/markdown", bytes: bytes(prelude) }],
      resumeCommand: `Start ${target} and paste memoar-injection-${session.id}.md as the first message`,
      report,
    };
  }

  /** The task statement, then the longest contiguous run of recent turns that fits. */
  private select(sections: Section[], budget: number, report: ConversionReport): { opening: Section | null; tail: Section[] } {
    if (sections.length === 0) return { opening: null, tail: [] };
    // A quarter at most, so a long opening cannot crowd out the recent work it
    // is supposed to introduce.
    const first = sections[0]!;
    const opening = first.text.length <= budget / 4 ? first : null;

    let remaining = budget - (opening?.text.length ?? 0);
    const tail: Section[] = [];
    for (let index = sections.length - 1; index > (opening ? 0 : -1); index -= 1) {
      const section = sections[index]!;
      if (section.text.length > remaining) break;
      remaining -= section.text.length;
      tail.unshift(section);
    }
    if (tail.length === 0 && !opening) return { opening: this.truncated(first, budget, report), tail: [] };
    if (tail.length === 0 && sections.length > 1) {
      // Nothing recent fits whole. A truncated tail of the last turn beats
      // returning only an opening that says what the work was going to be.
      const last = this.truncated(sections[sections.length - 1]!, remaining, report);
      return { opening, tail: last ? [last] : [] };
    }
    return { opening, tail };
  }

  private truncated(section: Section, budget: number, report: ConversionReport): Section | null {
    if (budget <= 0) return null;
    const cut = section.text.length - budget;
    report.degraded.push({
      turnId: section.turn.id,
      blockId: section.turn.blocks[0]?.id ?? section.turn.id,
      kind: "text",
      reason: `Turn truncated to fit the injection token budget: ${cut} characters removed`,
    });
    return { turn: section.turn, text: `${section.text.slice(0, budget)}\n[Memoar truncated ${cut} characters]\n` };
  }

  /** One dropped entry per contiguous run, so the report cannot outgrow the payload. */
  private omissions(sections: Section[], included: Section[], report: ConversionReport): string {
    const kept = new Set(included.map((section) => section.turn.ordinal));
    const ranges: string[] = [];
    let start: number | null = null;
    for (const section of sections) {
      const ordinal = section.turn.ordinal;
      if (!kept.has(ordinal)) {
        start ??= ordinal;
        continue;
      }
      if (start !== null) ranges.push(describeRange(start, ordinal - 1));
      start = null;
    }
    if (start !== null) ranges.push(describeRange(start, sections[sections.length - 1]!.turn.ordinal));
    for (const range of ranges) {
      report.dropped.push({ reference: `turns:${range}`, reason: "injection_token_budget_exceeded" });
    }
    return ranges.length ? `turns ${ranges.join(", ")}` : "";
  }
}
