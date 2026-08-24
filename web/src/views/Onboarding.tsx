import {
  ArrowRight,
  Check,
  CheckCircle2,
  Circle,
  CloudUpload,
  Code2,
  Command,
  Cpu,
  Download,
  Github,
  KeyRound,
  Laptop,
  LoaderCircle,
  LockKeyhole,
  ShieldCheck,
  Sparkles,
  Terminal,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Badge, Button, CopyButton, cn } from '../components/ui';

export function OnboardingView({ onComplete }: { onComplete: () => void }) {
  const [platform, setPlatform] = useState<'macOS' | 'Linux' | 'Windows'>('macOS');
  const [installed, setInstalled] = useState(false);
  const command = platform === 'Windows' ? 'npx memoar connect --windows' : 'npx memoar connect';

  return (
    <div className="onboarding-page">
      <div className="onboarding-grid-bg" />
      <header className="onboarding-head"><div className="eyebrow"><Sparkles size={13} /> Three minutes to a durable archive</div><h1>Connect your first machine.</h1><p>The local agent finds native session stores, uploads raw bytes, and keeps parsing in the cloud.</p></header>

      <div className="onboarding-layout">
        <ol className="setup-steps" aria-label="Setup progress">
          <li className="done"><span><Check size={15} /></span><div><strong>Account ready</strong><p>Personal archive created</p></div></li>
          <li className="active"><span>2</span><div><strong>Install capture agent</strong><p>Connect this machine</p></div></li>
          <li><span>3</span><div><strong>First sync</strong><p>Verify discovered sources</p></div></li>
        </ol>

        <section className="install-card">
          <header><span><Terminal size={20} /></span><div><h2>Install the Memoar agent</h2><p>Run one command in a terminal on the machine you want to archive.</p></div><Badge><ShieldCheck size={12} /> Signed binary</Badge></header>
          <div className="platform-tabs" role="tablist" aria-label="Operating system">
            {(['macOS', 'Linux', 'Windows'] as const).map((value) => <button type="button" role="tab" aria-selected={platform === value} className={cn(platform === value && 'active')} key={value} onClick={() => setPlatform(value)}>{value === 'macOS' ? <Command size={15} /> : value === 'Linux' ? <Terminal size={15} /> : <Laptop size={15} />}{value}</button>)}
          </div>
          <div className="install-command"><span>$</span><code>{command}</code><CopyButton value={command} label="Copy command" /></div>
          <div className="install-explainer">
            <div><span><Download size={16} /></span><p><strong>Downloads a signed binary</strong><small>Verified for {platform}</small></p></div>
            <div><span><KeyRound size={16} /></span><p><strong>Registers this machine</strong><small>Uses a short-lived setup token</small></p></div>
            <div><span><CloudUpload size={16} /></span><p><strong>Starts a private sync</strong><small>Secrets are scanned before upload</small></p></div>
          </div>
          <Button className="installed-button" variant={installed ? 'secondary' : 'primary'} onClick={() => setInstalled(true)}>{installed ? <CheckCircle2 size={16} /> : <Terminal size={16} />}{installed ? 'Agent connected' : 'I ran the command'}</Button>
        </section>

        <section className={cn('sync-card', installed && 'sync-active')}>
          <header><div><h2>Source discovery</h2><p>{installed ? 'Atlas is scanning native stores now.' : 'This starts after the agent connects.'}</p></div>{installed ? <Badge className="status-active"><span /> Live</Badge> : <Badge>Waiting</Badge>}</header>
          <div className="discovery-machine"><span><Cpu size={19} /></span><div><strong>{installed ? 'Atlas · MacBook Pro' : 'Your machine'}</strong><p>{platform} · local capture agent</p></div>{installed ? <CheckCircle2 size={18} className="success-icon" /> : <Circle size={18} />}</div>
          <div className="discovery-list">
            <div><span className="discovery-source source-claude"><Code2 size={15} /></span><div><strong>Claude Code</strong><p>~/.claude/projects</p></div>{installed ? <Badge>284 found</Badge> : <LoaderCircle size={15} />}</div>
            <div><span className="discovery-source source-codex"><Code2 size={15} /></span><div><strong>Codex</strong><p>~/.codex/sessions</p></div>{installed ? <Badge>167 found</Badge> : <LoaderCircle size={15} />}</div>
            <div><span className="discovery-source source-cursor"><Code2 size={15} /></span><div><strong>Cursor</strong><p>globalStorage/state.vscdb</p></div>{installed ? <Badge>91 found</Badge> : <LoaderCircle size={15} />}</div>
          </div>
          {installed ? <div className="sync-progress"><div><span>Uploading raw mirror</span><strong>68%</strong></div><span><span /></span><p>312 of 542 sessions are ready to browse. You can leave this page.</p></div> : null}
          <Button disabled={!installed} variant="primary" onClick={onComplete}>Browse available sessions <ArrowRight size={15} /></Button>
        </section>
      </div>

      <footer className="onboarding-security"><LockKeyhole size={15} /><span>Captured data is private by default. Sharing always requires a redaction review.</span></footer>
    </div>
  );
}

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
      <aside className="auth-aside"><div><span className="quote-mark">“</span><blockquote>Memoar let me resume a Claude Code investigation in Codex without flattening the branch history.</blockquote><p><strong>Avery R.</strong><span>Infrastructure engineer</span></p></div></aside>
    </div>
  );
}
