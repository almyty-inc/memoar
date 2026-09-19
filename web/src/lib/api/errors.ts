export class MemoarApiError extends Error {
  readonly status: number;
  /** The machine-readable code from the problem document, for callers that
      want to say something specific about one kind of failure. */
  readonly code: string | undefined;
  /** Correlates with the server log. Worth showing when nothing else helps. */
  readonly requestId: string | undefined;

  constructor(status: number, message: string, details?: { code?: string | undefined; requestId?: string | undefined }) {
    super(message);
    this.name = 'MemoarApiError';
    this.status = status;
    this.code = details?.code;
    this.requestId = details?.requestId;
  }
}

/** What to say when the server sends a status and nothing worth reading. */
function statusSentence(status: number): string {
  if (status === 401) return 'You are not signed in.';
  if (status === 403) return 'You do not have access to that.';
  if (status === 404) return 'That does not exist, or is not yours.';
  if (status === 409) return 'That conflicts with something that already exists.';
  if (status === 413) return 'That file is larger than the archive accepts.';
  if (status === 429) return 'Too many requests. Wait a moment and try again.';
  if (status >= 500) return 'The archive is having trouble. Try again shortly.';
  return `The request failed (${status}).`;
}

/**
 * The server speaks RFC 9457 problem documents. Read them.
 *
 * Printing the raw body put `{"type":"https://memoar.dev/problems/unauthorized",
 * "title":"Unauthorized","status":401,...}` on screen every time somebody
 * mistyped a password — as the error message, in every view that shows one.
 */
export async function problemError(response: Response): Promise<MemoarApiError> {
  const body = await response.text().catch(() => '');
  let problem: { title?: unknown; detail?: unknown; code?: unknown; requestId?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') problem = parsed;
  } catch {
    // Not a problem document: a proxy error page, or an empty body.
  }
  const detail = typeof problem.detail === 'string' ? problem.detail : undefined;
  const title = typeof problem.title === 'string' ? problem.title : undefined;
  return new MemoarApiError(response.status, detail ?? title ?? statusSentence(response.status), {
    code: typeof problem.code === 'string' ? problem.code : undefined,
    requestId: typeof problem.requestId === 'string' ? problem.requestId : undefined,
  });
}
