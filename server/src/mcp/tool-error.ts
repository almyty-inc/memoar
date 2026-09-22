import { HttpException } from "@nestjs/common";

/**
 * The text a failing tool call hands back to the model.
 *
 * A tool error is the only thing the caller gets: there is no status code
 * beside it and no body to inspect, so whatever this returns is the whole of
 * what a model has to decide what to do next.
 *
 * `error.message` alone was not that. Nest builds a problem-details refusal by
 * passing an object to the exception — `{ type, title, status, code, detail }`
 * — and `HttpException.initMessage` only adopts a `message` property, which an
 * RFC 7807 body does not have. Everything else falls through to the branch that
 * names the *class*, so the redaction gate on `get_memory_document` — the one
 * refusal on this surface a model can actually act on, by telling its human
 * which file needs reviewing — arrived as the two words "Conflict Exception".
 *
 * So the payload is unwrapped here. `code` first, because that is the stable
 * token a client can branch on, then the sentence a person wrote explaining
 * what to do about it.
 */
export function toolErrorText(error: unknown): string {
  if (error instanceof HttpException) {
    const described = describe(error.getResponse());
    if (described) return described;
  }
  if (error instanceof Error && error.message) return error.message;
  return "tool_failed";
}

function describe(response: unknown): string | null {
  if (typeof response === "string") return response || null;
  if (typeof response !== "object" || response === null) return null;
  const body = response as Record<string, unknown>;
  const code = typeof body.code === "string" ? body.code : null;
  // `detail` is the problem-details sentence; `message` is what a plain
  // `new NotFoundException("Session not found")` leaves behind.
  const detail = [body.detail, body.message, body.title].find((value) => typeof value === "string" && value.length > 0);
  if (code && typeof detail === "string") return `${code}: ${detail}`;
  if (code) return code;
  return typeof detail === "string" ? detail : null;
}
