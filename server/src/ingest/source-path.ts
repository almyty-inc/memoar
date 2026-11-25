/**
 * Reading the capture path out of the `x-memoar-source-path` header.
 *
 * Node hands header values over as latin1, one character per byte, and the
 * agent sent the path as raw UTF-8. So `/Users/ünï 日本/x` was stored as
 * `/Users/Ã¼nÃ¯ æ...`, two or three characters for every non-ASCII one, and the
 * path became the session's workspace and part of its identity in that form.
 *
 * The contract now says the value is percent-encoded UTF-8 with every byte
 * outside the RFC 3986 unreserved set encoded, the separators included. That
 * is plain ASCII on the wire, which survives any proxy and any header parser.
 * An older agent still sends the raw path, and two things tell the two apart:
 *
 * - An encoded value contains no `/` or `\`, because those are encoded, and a
 *   capture path always has one. A raw path is therefore never mistaken for an
 *   encoded one, even if it contains a literal `%41`.
 * - A raw path with non-ASCII in it arrives as latin1 mojibake. Its characters
 *   are all below U+0100, so they map back to the original bytes one to one,
 *   and those bytes are valid UTF-8 only if that is what was sent.
 */

/** Unreserved characters and percent escapes only, with at least one escape. */
const PERCENT_ENCODED = /^[A-Za-z0-9._~-]*(?:%[0-9A-Fa-f]{2}[A-Za-z0-9._~-]*)+$/u;

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });

/** The path a header value names, whichever agent sent it. */
export function decodeSourcePathHeader(value: string): string {
  if (PERCENT_ENCODED.test(value)) {
    try {
      return decodeURIComponent(value);
    } catch {
      // Well-formed escapes that are not UTF-8. Not something an agent
      // following the contract sends, so the value is kept as it came.
      return value;
    }
  }
  return repairLatin1Utf8(value);
}

/**
 * Undoes one latin1 reading of UTF-8 bytes, and changes nothing else.
 *
 * Applies only to a value whose characters all fit in one byte, with at least
 * one above ASCII, and whose bytes then decode as strict UTF-8. Text that is
 * genuinely latin1 almost never passes: a lone `é` is the byte E9, which is not
 * UTF-8 on its own. Running it again on its own output changes nothing, unless
 * the original path itself contained text that reads as UTF-8 mojibake.
 */
export function repairLatin1Utf8(value: string): string {
  if (!/[\u0080-ÿ]/u.test(value) || /[^\u0000-ÿ]/u.test(value)) return value;
  try {
    return STRICT_UTF8.decode(Buffer.from(value, "latin1"));
  } catch {
    return value;
  }
}
