import { ArrowRight, Command, Github, ShieldCheck, Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '../components/ui';

export function SignInView({ onSignIn, onOAuth }: { onSignIn: (email: string, password: string) => Promise<void>; onOAuth: (provider: 'github' | 'google') => void }) {
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await onSignIn(email, password);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Sign-in failed');
      setLoading(false);
    }
  };
  return (
    <div className="auth-page">
      <section className="auth-card">
        <div className="auth-brand"><span className="brand-mark"><Command size={18} /></span><strong>memoar</strong></div>
        <div className="auth-copy"><div className="eyebrow"><Sparkles size={13} /> Welcome back</div><h1>Open your archive.</h1><p>Continue from any coding agent, on any connected machine.</p></div>
        <div className="oauth-buttons"><Button onClick={() => onOAuth('github')}><Github size={16} /> Continue with GitHub</Button><Button onClick={() => onOAuth('google')}><span className="google-mark">G</span> Continue with Google</Button></div>
        <div className="or-divider"><span />or continue with email<span /></div>
        <form onSubmit={(event) => void submit(event)} className="auth-form"><label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" required /></label><label>Password<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} placeholder="At least 10 characters" required /></label>{error ? <p role="alert">{error}</p> : null}<div className="auth-form-row"><label><input type="checkbox" /> Remember me</label><button type="button">Forgot password?</button></div><Button type="submit" variant="primary" disabled={loading}>{loading ? 'Opening archive…' : 'Sign in'}<ArrowRight size={15} /></Button></form>
        <p className="auth-signup">New to Memoar? <button type="button">Create an archive</button></p>
        <div className="auth-trust"><ShieldCheck size={14} /> Credentials are never stored in session fixtures.</div>
      </section>
      {/*
        This carried a testimonial attributed to "Avery R., Infrastructure
        engineer", who does not exist. An invented endorsement from an invented
        person is a claim the product cannot stand behind, so it states what
        Memoar does instead of pretending someone vouched for it.
      */}
      <aside className="auth-aside"><div><p className="auth-aside-lede">Resume any coding session in any agent.</p><p>Memoar archives sessions from Claude Code, Codex, Cursor and others, then converts them so work continues where you left it — branch history intact.</p></div></aside>
    </div>
  );
}
