/**
 * The `x-memoar-source-path` header value for a path or file name.
 *
 * Percent-encoded UTF-8 with every byte outside the RFC 3986 unreserved set
 * escaped, as the contract asks. `encodeURIComponent` leaves `!'()*` alone, and
 * the server decodes only values made of unreserved characters and escapes, so
 * those five are escaped as well. A browser also refuses to send a header with
 * a character above U+00FF in it, so a file named in Japanese could not be
 * uploaded at all without this.
 */
export function encodeSourcePath(path: string): string {
  return encodeURIComponent(path).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}
