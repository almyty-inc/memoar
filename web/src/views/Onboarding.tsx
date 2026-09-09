import { ArrowRight, Github, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '../components/ui';
import { MemoarMark } from '../components/MemoarMark';
import { memoarApi, type AuthMethods } from '../lib/api';

type Mode = 'signIn' | 'createAccount';

export function SignInView({ onSignIn, onCreateAccount, onOAuth }: {
  onSignIn: (email: string, password: string) => Promise<void>;
  onCreateAccount: (email: string, password: string) => Promise<void>;
  onOAuth: (provider: 'github' | 'google') => void;
}) {
  const [mode, setMode] = useState<Mode>('signIn');
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

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await (creating ? onCreateAccount(email, password) : onSignIn(email, password));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : creating ? 'Account could not be created' : 'Sign-in failed');
      setLoading(false);
    }
  };

  return (
    <div className="auth-page">
      <section className="auth-card">
        <div className="auth-brand"><span className="brand-mark"><MemoarMark size={18} /></span><strong>memoar</strong></div>
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
                <Button onClick={() => onOAuth('github')}><Github size={16} /> Continue with GitHub</Button>
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
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              required
            />
          </label>
          <label>Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              // The length rule belongs where it is being applied. On sign-in
              // you type the password you already have.
              {...(creating ? { minLength: 10, placeholder: 'At least 10 characters' } : {})}
              autoComplete={creating ? 'new-password' : 'current-password'}
              required
            />
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <Button type="submit" variant="primary" disabled={loading}>
            {loading
              ? (creating ? 'Creating archive…' : 'Opening archive…')
              : (creating ? 'Create archive' : 'Sign in')}
            <ArrowRight size={15} />
          </Button>
        </form>

        {/* Says what this deployment will actually do, rather than promising a
            sign-up it may not accept. */}
        {methods?.signup === 'open' ? (
          <p className="auth-signup">
            {creating ? 'Already have an archive?' : 'New here?'}{' '}
            <button type="button" className="link-button" onClick={() => { setMode(creating ? 'signIn' : 'createAccount'); setError(null); }}>
              {creating ? 'Sign in' : 'Create an archive'}
            </button>
          </p>
        ) : (
          <p className="auth-signup">This archive is not open for new accounts.</p>
        )}

        <div className="auth-trust"><ShieldCheck size={14} /> Sessions stay private to your archive until you share them.</div>
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
