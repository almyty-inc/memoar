import type { AuthMethods } from './contracts';
import { MemoarApiError, problemError } from './errors';
import type { CurrentUser } from '../types';

interface StoredSession {
  token: string;
  expiresAt: string | null;
}

export class ApiClientCore {
  private readonly baseUrl: string;
  private session: StoredSession | null;

  constructor(baseUrl: string, token: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.session = token ? { token, expiresAt: null } : null;
  }

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  /**
   * Refuses to answer without an archive to ask. There is no substitute for it:
   * an unconfigured endpoint is an error, never sample data.
   */
  protected requireArchive(): void {
    if (!this.configured) throw new MemoarApiError(0, 'No archive endpoint is configured for this build (VITE_API_URL).');
  }

  /** The endpoint an agent on a machine has to be pointed at. */
  get endpoint(): string {
    return this.baseUrl;
  }

  get authenticated(): boolean {
    return this.accessToken() !== null;
  }

  /**
   * When this browser session stops being accepted, in epoch milliseconds, or
   * null when there is no session or it carries no expiry.
   *
   * Tokens live an hour and are not refreshed, so the moment is knowable well
   * in advance. Nothing read it: the first anyone heard about it was a 401 on
   * the request they had just made, which evicted them to the sign-in screen
   * and took whatever they had typed with it.
   */
  get expiresAt(): number | null {
    if (!this.authenticated) return null;
    const at = this.session?.expiresAt;
    if (!at) return null;
    const value = new Date(at).valueOf();
    return Number.isFinite(value) ? value : null;
  }

  get mcpEndpoint(): string {
    return `${this.baseUrl.replace(/\/v1$/, '')}/mcp`;
  }

  setAccessToken(token: string, expiresAt: string): void {
    this.session = { token, expiresAt };
    window.sessionStorage.setItem('memoar.session', JSON.stringify(this.session));
  }

  clearSession(): void {
    this.session = null;
    window.sessionStorage.removeItem('memoar.session');
  }

  private accessToken(): string | null {
    if (!this.session) {
      const encoded = window.sessionStorage.getItem('memoar.session');
      if (encoded) {
        try {
          const value = JSON.parse(encoded) as StoredSession;
          if (typeof value.token === 'string') this.session = value;
        } catch {
          window.sessionStorage.removeItem('memoar.session');
        }
      }
    }
    if (this.session?.expiresAt && new Date(this.session.expiresAt).valueOf() <= Date.now()) {
      this.clearSession();
      return null;
    }
    return this.session?.token ?? null;
  }

  /**
   * One authenticated fetch. Kept separate from request() so responses that are
   * not JSON — an export download, for one — can be read without pretending to
   * be, while still sharing the token, timeout and 401 handling.
   */
  protected async fetchWithAuth(path: string, init?: RequestInit): Promise<Response> {
    this.requireArchive();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const token = this.accessToken();
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(typeof init?.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...init?.headers,
        },
      });
      if (response.status === 401) {
        this.clearSession();
        window.dispatchEvent(new CustomEvent('memoar:unauthorized'));
      }
      return response;
    } finally {
      window.clearTimeout(timer);
    }
  }

  protected async request<T>(path: string, init?: RequestInit): Promise<T> {
    {
      const response = await this.fetchWithAuth(path, init);
      if (!response.ok) throw await problemError(response);
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }

  /** What this deployment accepts, so the page offers only what works. */
  async authMethods(): Promise<AuthMethods> {
    return this.request<AuthMethods>('/auth/methods');
  }

  /** Creates the account and signs it in: one form, not two. */
  async register(email: string, password: string): Promise<CurrentUser> {
    const result = await this.request<{ accessToken: string; expiresAt: string; user: CurrentUser }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    this.setAccessToken(result.accessToken, result.expiresAt);
    return result.user;
  }

  async login(email: string, password: string): Promise<CurrentUser> {
    const result = await this.request<{ accessToken: string; expiresAt: string; user: CurrentUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    this.setAccessToken(result.accessToken, result.expiresAt);
    return result.user;
  }

  /**
   * Who is signed in, according to the server. A reload keeps the token but not
   * the login response, so the identity is re-fetched rather than cached and
   * re-displayed without any way to verify it is still true.
   */
  currentUser(): Promise<CurrentUser> {
    return this.request<CurrentUser>('/auth/me');
  }

  beginOAuth(provider: 'github' | 'google'): void {
    window.location.assign(`${this.baseUrl}/auth/oauth/${provider}`);
  }

  consumeOAuthCallback(): boolean {
    if (!window.location.hash.startsWith('#access_token=')) return false;
    const parameters = new URLSearchParams(window.location.hash.slice(1));
    const token = parameters.get('access_token');
    const expiresAt = parameters.get('expires_at');
    if (!token || !expiresAt || !Number.isFinite(new Date(expiresAt).valueOf())) return false;
    this.setAccessToken(token, expiresAt);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#/timeline`,
    );
    return true;
  }
}
