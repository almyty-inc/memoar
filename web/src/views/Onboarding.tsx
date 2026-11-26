import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../components/ui';
import { GithubMark } from '../components/MemoarMark';
import { MemoarApiError, memoarApi, type AuthMethods } from '../lib/api';
import { MINIMUM_PASSWORD } from '../lib/limits';

type Mode = 'signIn' | 'createAccount';

/**
 * What to tell somebody whose sign-in did not work. The server's wording is
 * the fallback: it is written for an API client, and the failures people hit
 * deserve a sentence that says what to do next.
 */
function authMessage(reason: unknown, creating: boolean): string {
  if (reason instanceof MemoarApiError) {
    if (reason.status === 401 || reason.code === 'invalid_credentials') {
      return 'That email and password do not match an archive.';
    }
    if (reason.status === 409) return 'An archive already exists for that email. Sign in instead.';
    if (reason.status === 429) return 'Too many attempts. Wait a minute and try again.';
    if (reason.status === 0) return 'This build has no archive endpoint configured.';
    return reason.message;
  }
  if (reason instanceof Error && reason.message) return reason.message;
  return creating ? 'The archive could not be created.' : 'Sign-in failed.';
}

/** One small centred form. No pitch: whoever is here already knows why. */
export function SignInView({ onSignIn, onCreateAccount, onOAuth, creating: startCreating = false, onModeChange }: {
  onSignIn: (email: string, password: string) => Promise<void>;
  onCreateAccount: (email: string, password: string) => Promise<void>;
  onOAuth: (provider: 'github' | 'google') => void;
  /** /signup opens straight on the create form, so it can be linked to. */
  creating?: boolean;
  onModeChange?: (creating: boolean) => void;
}) {
  const [mode, setMode] = useState<Mode>(startCreating ? 'createAccount' : 'signIn');
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Only the providers this deployment can actually talk to.
  const [methods, setMethods] = useState<AuthMethods | null>(null);

  useEffect(() => {
    let active = true;
    void memoarApi.authMethods()
      .then((available) => { if (active) setMethods(available); })
      .catch(() => { if (active) setMethods({ password: true, signup: 'closed', oauth: [] }); });
    return () => { active = false; };
  }, []);

  const creating = mode === 'createAccount';
  const emailField = useRef<HTMLInputElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);

  useEffect(() => { emailField.current?.focus(); }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await (creating ? onCreateAccount(email, password) : onSignIn(email, password));
    } catch (reason) {
      setError(authMessage(reason, creating));
      setLoading(false);
      passwordField.current?.select();
    }
  };

  /*
    Switching modes keeps the email and drops the password: the one typed to
    sign in is not the one meant to register with, and the browser is told a
    different thing about the field either way.
  */
  const switchMode = () => {
    setMode(creating ? 'signIn' : 'createAccount');
    setPassword('');
    setError(null);
    passwordField.current?.focus();
    onModeChange?.(!creating);
  };

  return (
    <div className="auth-page">
      <main className="auth-card">
        <p className="auth-brand">memoar</p>
        <h1>{creating ? 'Create an archive' : 'Sign in'}</h1>

        {methods && methods.oauth.length > 0 ? (
          <>
            <div className="auth-oauth">
              {methods.oauth.includes('github') ? (
                <Button onClick={() => onOAuth('github')}><GithubMark size={14} /> Continue with GitHub</Button>
              ) : null}
              {methods.oauth.includes('google') ? (
                <Button onClick={() => onOAuth('google')}>Continue with Google</Button>
              ) : null}
            </div>
            <p className="auth-or"><span>or</span></p>
          </>
        ) : null}

        <form onSubmit={(event) => void submit(event)} className="form-stack">
          <label className="field-label">Email
            <input
              ref={emailField}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              aria-invalid={error !== null}
              required
            />
          </label>
          {/* The rule lives in the label, where it stays readable while typing. */}
          <label className="field-label">{creating ? `Password (${MINIMUM_PASSWORD} characters or more)` : 'Password'}
            <input
              ref={passwordField}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              {...(creating ? { minLength: MINIMUM_PASSWORD } : {})}
              autoComplete={creating ? 'new-password' : 'current-password'}
              aria-invalid={error !== null}
              required
            />
          </label>
          {error ? <p className="error-note" role="alert">{error}</p> : null}
          <Button type="submit" variant="primary" disabled={loading}>
            {loading
              ? (creating ? 'Creating archive' : 'Signing in')
              : (creating ? 'Create archive' : 'Sign in')}
          </Button>
        </form>

        {/* Nothing is claimed until the answer is in, and the line keeps its
            height so the correction does not move the form. */}
        <p className="auth-foot">
          {methods === null ? ' ' : methods.signup === 'open' ? (
            <>
              {creating ? 'Already have an archive?' : 'No archive yet?'}{' '}
              <button type="button" className="link-button" onClick={switchMode}>
                {creating ? 'Sign in' : 'Create an archive'}
              </button>
            </>
          ) : 'This archive is not open for new accounts.'}
        </p>
      </main>
    </div>
  );
}
