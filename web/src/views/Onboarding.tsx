import { AlertCircle, ArrowRight, ShieldCheck } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../components/ui';
import { GithubMark, MemoarMark } from '../components/MemoarMark';
import { MemoarApiError, memoarApi, type AuthMethods } from '../lib/api';

type Mode = 'signIn' | 'createAccount';

/** The shortest password the archive will accept. Stated, not discovered. */
const MINIMUM_PASSWORD = 10;

/**
 * What to tell somebody whose sign-in did not work.
 *
 * The server's own wording is the fallback, not the first choice: it is written
 * for an API client, and the two failures people actually hit deserve a
 * sentence that says what to do next.
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
  // Only the providers this deployment can actually talk to. A button for one
  // it has no credentials for fails the moment somebody presses it.
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

  // The first thing to do on this page is type an email address, so the caret
  // is already there.
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
    Switching modes keeps the email — it is the same person — and drops the
    password, because the one they typed to sign in is not the one they mean to
    register with, and the browser is being told a different thing about the
    field either way (current-password against new-password).
  */
  const switchMode = () => {
    setMode(creating ? 'signIn' : 'createAccount');
    setPassword('');
    setError(null);
    passwordField.current?.focus();
    // The address follows the form, so /signup is somewhere you can be sent.
    onModeChange?.(!creating);
  };

  return (
    <div className="auth-page">
      <section className="auth-card">
        <div className="auth-brand"><span className="brand-mark"><MemoarMark size={18} /></span><strong>memoar</strong></div>
        {/* Both modes fill the same box. The card is centred in the column, so a
            subtitle that grows by one line moves every field under the cursor. */}
        <div className="auth-copy">
          <h1>{creating ? 'Start your archive.' : 'Open your archive.'}</h1>
          <p>
            {creating
              ? 'One archive of your coding sessions, from every agent you use.'
              : 'Continue from any coding agent, on any connected machine.'}
          </p>
        </div>

        {methods && methods.oauth.length > 0 ? (
          <>
            <div className="oauth-buttons">
              {methods.oauth.includes('github') ? (
                <Button onClick={() => onOAuth('github')}><GithubMark size={16} /> Continue with GitHub</Button>
              ) : null}
              {methods.oauth.includes('google') ? (
                <Button onClick={() => onOAuth('google')}><span className="google-mark">G</span> Continue with Google</Button>
              ) : null}
            </div>
            <div className="or-divider"><span />or continue with email<span /></div>
          </>
        ) : null}

        <form onSubmit={(event) => void submit(event)} className="auth-form">
          <label>Email
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
          {/* The rule lives in the label, where it stays readable while you
              type. As a placeholder it vanished at the first keystroke. */}
          <label>{creating ? `Password (${MINIMUM_PASSWORD} characters or more)` : 'Password'}
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
          {error ? (
            <p className="error-note" role="alert">
<AlertCircle size={16} aria-hidden="true" /><span>{error}</span></p>
          ) : null}
          <Button type="submit" variant="primary" disabled={loading}>
            {loading
              ? (creating ? 'Creating archive…' : 'Opening archive…')
              : (creating ? 'Create archive' : 'Sign in')}
            <ArrowRight size={15} />
          </Button>
        </form>

        {/*
          The way to the other mode, and what this deployment will actually
          accept. It is a separate decision from the form above it and is spaced
          like one, rather than sitting flush against the button.
        */}
        <footer className="auth-foot">
          {/*
            Nothing is claimed until the answer is in. Reading `methods?.signup`
            directly made the page state this archive was closed to new accounts
            for as long as the request took, and then contradict itself. The
            slot keeps its height so the correction does not move the page.
          */}
          {methods === null ? (
            <p className="auth-signup">&nbsp;</p>
          ) : methods.signup === 'open' ? (
            <p className="auth-signup">
              {creating ? 'Already have an archive?' : 'New here?'}{' '}
              <button type="button" className="link-button" onClick={switchMode}>
                {creating ? 'Sign in' : 'Create an archive'}
              </button>
            </p>
          ) : (
            <p className="auth-signup">This archive is not open for new accounts.</p>
          )}
          <p className="auth-trust"><ShieldCheck size={14} aria-hidden="true" /> Sessions stay private to your archive until you share them.</p>
        </footer>
      </section>

      <aside className="auth-aside">
        <div>
          <p className="auth-aside-lede">Resume any coding session in any agent.</p>
          <p>Memoar archives sessions from Claude Code, Codex, Cursor and others, then converts them so work continues where you left it — branch history intact.</p>
          <ul className="auth-aside-points">
            <li>Every transcript kept as it was written, content-addressed.</li>
            <li>Search across every agent and machine at once.</li>
            <li>Convert a session into the format the next agent expects.</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}
