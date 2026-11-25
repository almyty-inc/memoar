/**
 * Every credential shape the archive and the capture agent mask, in one table.
 *
 * The capture agent holds the same table in
 * `agent/crates/memoar-daemon/src/secret_catalogue.rs`, and a test on each side
 * compares its table with `server/test/fixtures/secret-scanner/catalogue.json`.
 * The two scanners used to be written separately. Each missed keys the other
 * caught, and both missed AWS, Google, GitLab, npm and most Slack tokens.
 *
 * A pattern here has to mean the same thing to V8 and to Rust's `regex` crate,
 * so it keeps to their common ground:
 *
 * - No lookaround and no backreferences, which `regex` does not have.
 * - Explicit ASCII classes instead of `\s`, `\w`, `\d` and `.`, which the two
 *   engines define differently outside ASCII. `[\s\S]` means "any character"
 *   in both and is the one exception.
 * - `\b` is the only shorthand. The Rust side compiles it as the ASCII word
 *   boundary, which is what V8 uses here.
 * - A repetition that a failed match could backtrack through either has a
 *   small bound or runs over a class its next literal is not in, so V8 cannot
 *   be walked across a whole transcript by one rule. Large counted bounds are
 *   avoided too: Rust's lazy DFA holds one state per count, and ran a minute
 *   over input V8 scanned in under one second.
 * - A rule may name a group `secret`. Only that group is masked and the rest of
 *   the match, such as the key name in `password=…`, stays where it was. A rule
 *   without one masks its whole match.
 * - A value never takes a quote or a backslash. A capture is JSON lines, and a
 *   value that swallowed the `\"` closing a JSON-encoded string broke the line.
 *
 * Order matters. Masking runs top to bottom over the text the rule before left
 * behind, so a private key is removed before a `private_key=` rule could cut it
 * in half, and the vendor rules claim a token before the generic ones.
 */
export type SecretCatalogueKind = "api_key" | "jwt" | "private_key" | "credential" | "connection_string";

export interface SecretRule {
  /** Stable name for tests and parity checks. Never shown to a user. */
  id: string;
  /** What a finding is filed as. The web app labels these. */
  kind: SecretCatalogueKind;
  caseInsensitive: boolean;
  pattern: string;
}

/** Anything that can follow `=` or `:` as a value, short of a delimiter, quote or backslash. */
const VALUE = String.raw`[^ \t\r\n\x0B\x0C"',;{}\[\]\\]`;

export const SECRET_CATALOGUE: readonly SecretRule[] = [
  {
    /*
      The body is held to the PEM alphabet, not to a length.

      A transcript that only mentions the header has no END line. `[\s\S]+?`
      walked a 30 MB artifact to its end looking for one and threw. The fix was
      `[\s\S]{1,8000}?`, which V8 runs cheaply and Rust's regex crate does not:
      eight thousand counted copies of "any character" overflow its lazy DFA,
      and twenty thousand bare headers took a minute to scan in a debug build.
      A body of base64, whitespace and the backslash of a JSON-escaped `\n`
      stops at the first `-` or punctuation mark instead, which costs both
      engines one pass, and a key of any size still matches. The optional
      `Name: value` lines are the headers of legacy encrypted and PGP keys.
    */
    id: "pem-private-key",
    kind: "private_key",
    caseInsensitive: false,
    pattern: String.raw`-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----(?:(?:\r?\n|\\r?\\n)[A-Za-z][A-Za-z-]{0,31}: [A-Za-z0-9 ,.:;/+=()_-]{0,100}){0,4}[A-Za-z0-9+/=\\ \t\r\n]+-----END (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----`,
  },
  {
    // Anchored on the header name, not on the word `Bearer`, which is English.
    id: "authorization-header",
    kind: "credential",
    caseInsensitive: true,
    pattern: String.raw`(?:proxy-)?authorization["']?[ \t]*[:=][ \t]*["']?(?:(?:bearer|basic|token|digest)[ \t]+)?(?<secret>${VALUE}+)`,
  },
  { id: "aws-access-key-id", kind: "api_key", caseInsensitive: false, pattern: String.raw`\b(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}\b` },
  {
    id: "aws-secret-access-key",
    kind: "credential",
    caseInsensitive: true,
    pattern: String.raw`(?:aws[A-Za-z0-9_.-]{0,20})?secret[_-]?access[_-]?key["']?[ \t]*[:=][ \t]*["']?(?<secret>[A-Za-z0-9/+=]{40,128})`,
  },
  { id: "gcp-api-key", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bAIza[A-Za-z0-9_-]{35}` },
  { id: "google-oauth-client-secret", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bGOCSPX-[A-Za-z0-9_-]{28}` },
  {
    id: "azure-storage-key",
    kind: "connection_string",
    caseInsensitive: true,
    pattern: String.raw`(?:AccountKey|SharedAccessKey|SharedSecretValue)[ \t]*=[ \t]*(?<secret>[A-Za-z0-9+/]{20,256}={0,2})`,
  },
  { id: "azure-sas-signature", kind: "connection_string", caseInsensitive: false, pattern: String.raw`[?&;]sig=(?<secret>[A-Za-z0-9%+/=]{16,256})` },
  { id: "azure-ad-client-secret", kind: "api_key", caseInsensitive: false, pattern: String.raw`\b[A-Za-z0-9_~.]{3}[78]Q~[A-Za-z0-9_~.-]{31,34}` },
  { id: "github-token", kind: "api_key", caseInsensitive: false, pattern: String.raw`\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b` },
  { id: "github-fine-grained-pat", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bgithub_pat_[A-Za-z0-9_]{22,255}\b` },
  { id: "gitlab-token", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bgl(?:pat|dt|ptt|rt|soat|cbt|imt|ffct|agent|oas)-[A-Za-z0-9_.-]{20,255}` },
  { id: "slack-token", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bxox(?:e\.xox[bp]|[abposre])-[A-Za-z0-9-]{10,255}` },
  { id: "slack-app-token", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bxapp-[0-9]{1,4}-[A-Za-z0-9-]{10,255}` },
  {
    id: "slack-webhook",
    kind: "api_key",
    caseInsensitive: false,
    pattern: String.raw`hooks\.slack\.com/(?:services|workflows|triggers)/(?<secret>[A-Za-z0-9/_-]{20,255})`,
  },
  { id: "stripe-key", kind: "api_key", caseInsensitive: false, pattern: String.raw`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,255}\b` },
  { id: "stripe-webhook-secret", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bwhsec_[A-Za-z0-9]{24,255}\b` },
  { id: "npm-token", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bnpm_[A-Za-z0-9]{36}\b` },
  { id: "pypi-token", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bpypi-AgE[A-Za-z0-9_-]{50,}` },
  { id: "anthropic-key", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bsk-ant-[a-z]{2,8}[0-9]{2}-[A-Za-z0-9_-]{20,255}` },
  { id: "openai-key", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,255}` },
  { id: "huggingface-token", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bhf_[A-Za-z0-9]{30,255}\b` },
  { id: "twilio-api-key", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bSK[0-9a-fA-F]{32}\b` },
  {
    id: "twilio-auth-token",
    kind: "credential",
    caseInsensitive: true,
    pattern: String.raw`twilio[A-Za-z0-9_.-]{0,30}token["']?[ \t]*[:=][ \t]*["']?(?<secret>[a-f0-9]{32})`,
  },
  { id: "sendgrid-key", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}` },
  { id: "memoar-token", kind: "api_key", caseInsensitive: false, pattern: String.raw`\bmemoar_[A-Za-z0-9_-]{40,255}` },
  {
    // The backstop for every `sk-` and `sk_` key the vendor rules above do not
    // name: legacy OpenAI keys, DeepSeek, and whatever ships next.
    id: "generic-sk-key",
    kind: "api_key",
    caseInsensitive: false,
    pattern: String.raw`\bsk[_-][A-Za-z0-9_-]{16,255}`,
  },
  {
    id: "jwt",
    kind: "jwt",
    caseInsensitive: false,
    pattern: String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`,
  },
  {
    // Only the password is masked, so the URL still says which database it was.
    // Brackets are excluded, as in every value class here, so a token an
    // earlier rule replaced with a marker is not masked and counted twice.
    id: "url-credentials",
    kind: "connection_string",
    caseInsensitive: true,
    pattern: String.raw`\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mssql|sqlserver|clickhouse|cockroachdb|https?|s?ftp|smtps?|ldaps?|ssh|git)://[^:/@ \t\r\n"'\\\[\]]{0,256}:(?<secret>[^@/ \t\r\n"'\\\[\]]{1,256})@`,
  },
  {
    /*
      The key/value shape as people write it: `api_key=…`, `"apiKey": "…"`,
      `export OPENAI_API_KEY="…"`, `password: …`.

      The key may carry a prefix and a suffix, and the separator may carry a
      quote on either side. The value stops before the closing quote, so
      `"k": "v"` stays well-formed JSON. `token` alone is not a key word:
      `"max_tokens": 4096` is accounting, not a credential.
    */
    id: "generic-assignment",
    kind: "credential",
    caseInsensitive: true,
    pattern: String.raw`\b[A-Za-z0-9_.-]{0,64}(?:api[_-]?key|access[_-]?key|(?:auth|access|refresh|bearer|session|api|bot|npm|github|gitlab|gh|slack|hf|pypi)[_-]?token|client[_-]?secret|private[_-]?key|password|passwd|secret)[A-Za-z0-9_.-]{0,40}["']?[ \t]*[:=][ \t]*["']?(?<secret>${VALUE}+)`,
  },
];

/** Compiles one rule for V8: global for iteration, `d` for the `secret` group's offsets. */
export function compileRule(rule: SecretRule): RegExp {
  return new RegExp(rule.pattern, rule.caseInsensitive ? "gudi" : "gud");
}
