import type { ArchivedSession } from "./archive-store.js";
import { DEFAULT_TENANT_SETTINGS, type RedactionSettingsRecord } from "./store/records.js";

export type SecretKind = "api_key" | "jwt" | "env" | "private_key" | "email" | "path" | "custom";

export interface SecretPattern {
  kind: SecretKind;
  expression: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  // The separator is `[_-]`, not `_`.
  //
  // This required an underscore, which is the separator used by exactly one of
  // the vendors named here: GitHub writes `ghp_…`, while OpenAI writes
  // `sk-proj-…`, Anthropic `sk-ant-api03-…` and Slack `xoxb-…`. So the pattern
  // matched the least common shape and missed the three a person is most likely
  // to paste, in transcripts and in instruction files alike — including the
  // literal `sk-…` in the note that asked for memory files to be scanned at all.
  { kind: "api_key", expression: /\b(?:sk|ghp|github_pat|xoxb|memoar)[_-][A-Za-z0-9_-]{16,}\b/gu },
  { kind: "jwt", expression: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu },
  { kind: "env", expression: /^(?:[A-Z][A-Z0-9_]{2,})\s*=\s*[^\s#]+$/gmu },
  /*
    The body is bounded, because an unmatched header is the common case.

    `[\s\S]+?` walks to the end of the document looking for the closing line. A
    transcript that merely *mentions* `-----BEGIN RSA PRIVATE KEY-----` — a
    conversation about key handling, say — has no closing line at all, so the
    scan drags across every remaining character. One real 30 MB artifact in the
    archive carries that header twice and the END line zero times: 29 million
    characters walked, twice, and the scanner threw
    `RangeError: Maximum call stack size exceeded`, which failed the parse and
    lost the whole session rather than one finding.

    8000 is far past any real PEM body — a 4096-bit RSA key is about 3.2 kB
    base64 — and turns an unbounded walk into a bounded one. Measured on that
    artifact: 35ms unbounded, 14ms bounded, same zero matches.
  */
  { kind: "private_key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]{1,8000}?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu },
];

/** An address, which is a person rather than a credential — hence its own switch. */
const EMAIL_PATTERN: SecretPattern = {
  kind: "email",
  expression: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/gu,
};

/**
 * Home directory paths, which carry the account name of whoever was working and
 * usually the name of a customer's project beside it.
 */
const PATH_PATTERN: SecretPattern = {
  kind: "path",
  expression: /(?:\/(?:Users|home)\/[^\s"'`,;:)\]}]+|[A-Za-z]:\\Users\\[^\s"'`,;:)\]}]+)/gu,
};

/**
 * The patterns one tenant's settings ask for.
 *
 * `redaction.{secretScan,pathScan,emailScan,customPatterns}` were validated,
 * stored and echoed back, and then read by nothing at all: the scanner and the
 * outbound projection both used the four hardcoded SECRET_PATTERNS whatever the
 * settings said. A tenant who turned emailScan on got a 200 and saw every
 * address served verbatim on the next share link — a privacy control reporting
 * success and doing nothing, which is worse than not offering one.
 */
export function redactionPatterns(settings: RedactionSettingsRecord = DEFAULT_TENANT_SETTINGS.redaction): SecretPattern[] {
  const patterns: SecretPattern[] = [];
  if (settings.secretScan) patterns.push(...SECRET_PATTERNS);
  if (settings.emailScan) patterns.push(EMAIL_PATTERN);
  if (settings.pathScan) patterns.push(PATH_PATTERN);
  for (const source of settings.customPatterns ?? []) {
    // Settings validation already rejects a pattern that will not compile, but
    // a stored pattern outlives the code that checked it: a projection must not
    // throw on its way out and serve the unmasked text instead.
    try {
      patterns.push({ kind: "custom", expression: new RegExp(source, "g") });
    } catch { /* an uncompilable stored pattern masks nothing, rather than breaking the share */ }
  }
  return patterns;
}

export function maskLiterals(text: string, patterns: readonly SecretPattern[]): string {
  let masked = text;
  for (const { kind, expression } of patterns) {
    masked = masked.replace(expression, `[REDACTED ${kind}]`);
  }
  return masked;
}

export function maskSecretLiterals(text: string): string {
  return maskLiterals(text, SECRET_PATTERNS);
}

/**
 * One range of one block that a person chose to hide.
 *
 * Offsets are **character offsets into that block's own text**, and the block
 * is named. The scanner's offsets are byte offsets into the raw artifact, which
 * addresses nothing that is ever served: the artifact is parsed into turns and
 * blocks, a growing transcript moves every offset in it, and no code path has
 * the raw bytes in hand at projection time. Block text is the only text that
 * leaves here, so it is the only thing a mask can be anchored to.
 */
export interface ReviewedMask {
  blockId: string;
  start: number;
  end: number;
  kind: string;
}

/** The block-anchored masks among a session's annotations, ignoring scanner findings. */
export function reviewedMasks(annotations: readonly { kind: string; blockId?: string; value: Record<string, unknown> }[]): ReviewedMask[] {
  const masks: ReviewedMask[] = [];
  for (const annotation of annotations) {
    if (annotation.kind !== "redaction_mask") continue;
    const blockId = annotation.blockId ?? (typeof annotation.value.blockId === "string" ? annotation.value.blockId : null);
    const start = Number(annotation.value.start);
    const end = Number(annotation.value.end);
    // A scanner finding carries no block and its offsets address the artifact.
    // Masking a block by them would blank an arbitrary run of somebody's prose.
    if (!blockId || !Number.isInteger(start) || !Number.isInteger(end) || end <= start || start < 0) continue;
    masks.push({ blockId, start, end, kind: typeof annotation.value.kind === "string" ? annotation.value.kind : "manual" });
  }
  return masks;
}

/** Replaces every reviewed range in one block's text, right to left so earlier offsets stay true. */
function applyMasks(text: string, masks: readonly ReviewedMask[]): string {
  let masked = text;
  for (const mask of [...masks].sort((left, right) => right.start - left.start)) {
    if (mask.start >= masked.length) continue;
    masked = `${masked.slice(0, mask.start)}[REDACTED ${mask.kind}]${masked.slice(Math.min(mask.end, masked.length))}`;
  }
  return masked;
}

export interface ProjectionOptions {
  /** The tenant's patterns; the four built-in secret patterns when absent. */
  patterns?: readonly SecretPattern[];
  /** What the person hid during the mandatory redaction review. */
  masks?: readonly ReviewedMask[];
}

/**
 * Outbound projection for anything that leaves the owner's archive (transfer
 * copies, share views, exports): the ranges the reviewer masked are removed,
 * the tenant's patterns are masked out of every text field, and raw tool
 * payloads are stripped.
 *
 * The reviewed masks used to be snapshotted into the review record, echoed back
 * by the controller, persisted — and consumed by nothing. A user selected a
 * customer's name, completed the review that createLink refuses to work
 * without, shared the link, and the name was served in full. The review was a
 * formality; this is what makes it mean something.
 */
export function applyRedactionProjection(session: ArchivedSession, options: ProjectionOptions = {}): ArchivedSession {
  const patterns = options.patterns ?? SECRET_PATTERNS;
  const byBlock = new Map<string, ReviewedMask[]>();
  for (const mask of options.masks ?? []) {
    byBlock.set(mask.blockId, [...(byBlock.get(mask.blockId) ?? []), mask]);
  }
  const clone = structuredClone(session);
  // Not only the blocks.
  //
  // A session's title is the conversation's own title or the task the person
  // typed, its summary is distilled from the transcript, and its workspace path
  // is where they were working — `/Users/frane/clients/acme`, which is what
  // `pathScan` exists to remove. All three left the tenant verbatim on every
  // share, import and transfer while the block text beside them was masked, so
  // a tenant that turned `emailScan` or `pathScan` on got the control they
  // asked for everywhere except the first line of the page.
  //
  // Reviewed masks are block-anchored and cannot reach here; patterns can, and
  // these are the fields a pattern is worth running over.
  clone.title = maskLiterals(clone.title, patterns);
  if (typeof clone.summary === "string") clone.summary = maskLiterals(clone.summary, patterns);
  clone.workspace = {
    ...clone.workspace,
    path: maskLiterals(clone.workspace.path, patterns),
    ...(typeof clone.workspace.gitRemote === "string" ? { gitRemote: maskLiterals(clone.workspace.gitRemote, patterns) } : {}),
  };
  for (const turn of clone.turns) {
    turn.blocks = turn.blocks.map((block) => ({
      ...block,
      // Masks first: their offsets describe the stored text, so anything that
      // rewrites the text has to run after them.
      ...(typeof block.text === "string"
        ? { text: maskLiterals(applyMasks(block.text, byBlock.get(block.id) ?? []), patterns) }
        : {}),
      ...((block.kind === "tool_call" || block.kind === "tool_result") && block.data
        ? { data: { memoarRedacted: "raw payload removed by redaction projection" } }
        : {}),
    }));
  }
  return clone;
}
