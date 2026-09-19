# Sharing, transfer, and conversion

Sharing changes visibility. Conversion changes representation. Neither operation changes the captured canonical session.

## Share a session

1. Open the session and start a redaction review.
2. Inspect every finding and the exact content that will leave the private scope.
3. Select anything else that must not leave, which stores a `redaction_mask` annotation naming the block and the range within its text.
4. Mark the review complete.
5. Create a viewer link or an importer link with an optional expiry.

### What a share link actually serves

Everything that leaves the tenant — a viewer link, an imported copy, a transfer — is projected first:

- Every range masked during the review is replaced with `[REDACTED <kind>]`. Masks are anchored to a content block and to character offsets within that block's text, because block text is the only text that is ever served. The secret scanner's own findings carry byte offsets into the uploaded file instead, so they are recorded for the findings count and the review UI and are removed by pattern rather than by range.
- The tenant's own redaction settings decide the patterns: `secretScan` (API keys, JWTs, `NAME=value` lines, private keys), `emailScan`, `pathScan` (home-directory paths), and any `customPatterns`. They apply to what the scanner looks for on the way in and to what the projection masks on the way out.
- Raw tool-call and tool-result payloads are stripped whatever the settings say.

Re-capturing a transcript that is still growing re-runs the scanner, and that replaces only the scanner's own findings. Masks placed by hand survive every later capture.

Revoking a grant blocks future access. Imported copies keep their provenance even if the original grant is later revoked.

## Transfer a session

A direct transfer names a recipient account. The recipient must accept it. Acceptance creates a canonical copy in the recipient archive with a provenance link to the sender and original session. The sender keeps the original unless a later product policy adds move semantics.

## Convert a session

Memoar writes native bundles for Claude Code, Codex, and Antigravity CLI. The conversion report lists every exact mapping, degraded block, and unavailable artifact. The local capture agent materializes the bundle into the target store and prints its resume command.

When a target format is unsupported or too brittle, Memoar produces an injection prelude from a cited pack. This fallback starts a new session with relevant context. It does not claim to resume native state.
