import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoarApiClient, MemoarApiError } from './api';

/** A client with an endpoint, since the shared one has none under test. */
function client(): MemoarApiClient {
  return new MemoarApiClient('https://api.memoar.test/v1');
}

/**
 * What a failed request says.
 *
 * The client used to throw with the raw response body as the message, and every
 * view that catches an error prints that message. A mistyped password put the
 * whole problem document on screen — `{"type":"https://memoar.dev/problems/
 * unauthorized","title":"Unauthorized","status":401,...}` — as the error text,
 * unstyled and wider than the card it was in.
 */
function respondWith(status: number, body: unknown, contentType = 'application/problem+json') {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
    typeof body === 'string' ? body : JSON.stringify(body),
    { status, headers: { 'content-type': contentType } },
  )));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('a failed request', () => {
  it('reads the problem document rather than printing it', async () => {
    respondWith(401, {
      type: 'https://memoar.dev/problems/unauthorized',
      title: 'Unauthorized',
      status: 401,
      code: 'invalid_credentials',
      detail: 'Invalid credentials',
      requestId: 'a16b95fd-b802-4f49-a550-bf0012cf4f0e',
    });

    const failure = await client().authMethods().catch((reason: unknown) => reason);

    expect(failure).toBeInstanceOf(MemoarApiError);
    const error = failure as MemoarApiError;
    expect(error.message).toBe('Invalid credentials');
    // Nothing from the wire format reaches the message a person reads.
    expect(error.message).not.toContain('{');
    expect(error.message).not.toContain('memoar.dev/problems');
    expect(error.code).toBe('invalid_credentials');
    expect(error.requestId).toBe('a16b95fd-b802-4f49-a550-bf0012cf4f0e');
    expect(error.status).toBe(401);
  });

  it('falls back to the title when there is no detail', async () => {
    respondWith(409, { title: 'Email already registered', status: 409, code: 'conflict' });

    const error = await client().authMethods().catch((reason: unknown) => reason) as MemoarApiError;

    expect(error.message).toBe('Email already registered');
  });

  it('says something useful when the body is not a problem document at all', async () => {
    // A proxy or load balancer answering instead of the archive: an HTML error
    // page dumped on screen is worse than a sentence about the status.
    respondWith(502, '<html><body><h1>502 Bad Gateway</h1></body></html>', 'text/html');

    const error = await client().authMethods().catch((reason: unknown) => reason) as MemoarApiError;

    expect(error.message).toBe('The archive is having trouble. Try again shortly.');
    expect(error.message).not.toContain('<html>');
  });

  it('says something useful when there is no body', async () => {
    respondWith(429, '');

    const error = await client().authMethods().catch((reason: unknown) => reason) as MemoarApiError;

    expect(error.message).toBe('Too many requests. Wait a moment and try again.');
  });
});
