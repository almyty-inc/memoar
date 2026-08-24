import type { ArchivedSession } from "./archive-store.js";

export interface SecretPattern {
  kind: "api_key" | "jwt" | "env" | "private_key";
  expression: RegExp;
}

export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: "api_key", expression: /\b(?:sk|ghp|xoxb|memoar)_[A-Za-z0-9_-]{16,}\b/gu },
  { kind: "jwt", expression: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu },
  { kind: "env", expression: /^(?:[A-Z][A-Z0-9_]{2,})\s*=\s*[^\s#]+$/gmu },
  { kind: "private_key", expression: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu },
];

export function maskSecretLiterals(text: string): string {
  let masked = text;
  for (const { kind, expression } of SECRET_PATTERNS) {
    masked = masked.replace(expression, `[REDACTED ${kind}]`);
  }
  return masked;
}

/**
 * Outbound projection for anything that leaves the owner's archive (transfer
 * copies, share views, exports): masked secret literals are removed from every
 * text field and raw tool payloads are stripped, so reviewed masks cannot leak
 * through a projection.
 */
export function applyRedactionProjection(session: ArchivedSession): ArchivedSession {
  const clone = structuredClone(session);
  for (const turn of clone.turns) {
    turn.blocks = turn.blocks.map((block) => ({
      ...block,
      ...(typeof block.text === "string" ? { text: maskSecretLiterals(block.text) } : {}),
      ...((block.kind === "tool_call" || block.kind === "tool_result") && block.data
        ? { data: { memoarRedacted: "raw payload removed by redaction projection" } }
        : {}),
    }));
  }
  return clone;
}
