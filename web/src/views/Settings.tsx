import {
  AlertTriangle,
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Eye,
  FileKey,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  ScanSearch,
  ServerCog,
  Settings,
  Shield,
  Sparkles,
  Trash2,
  UserRound,
} from 'lucide-react';
import { useState } from 'react';
import { accountInitials } from '../lib/account';
import type { CurrentUser, ApiKey } from '../lib/types';
import { Badge, Button, CopyButton, IconButton, Modal, Toggle, cn, formatDate, formatRelative } from '../components/ui';

type SettingsTab = 'general' | 'keys' | 'privacy' | 'retention';

const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Settings }> = [
  { id: 'general', label: 'General', icon: UserRound },
  { id: 'keys', label: 'API keys & MCP', icon: KeyRound },
  { id: 'privacy', label: 'Redaction', icon: Shield },
  { id: 'retention', label: 'Retention', icon: Clock3 },
];

export function SettingsView({ apiKeys, mcpEndpoint, user, onCreateKey }: { apiKeys: ApiKey[]; mcpEndpoint: string; user: CurrentUser | null; onCreateKey: (name: string, scopes: string[]) => Promise<string> }) {
  const [tab, setTab] = useState<SettingsTab>('keys');
  const [createOpen, setCreateOpen] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('Codex MCP');
  const [keyScopes, setKeyScopes] = useState<string[]>(['sessions:read', 'collections:read', 'pack:read']);
  const [keySaving, setKeySaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [secretScan, setSecretScan] = useState(true);
  const [pathScan, setPathScan] = useState(true);
  const [emailScan, setEmailScan] = useState(true);

  const createKey = async () => {
    setKeySaving(true);
    setKeyError(null);
    try {
      setCreatedSecret(await onCreateKey(keyName.trim(), keyScopes));
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : 'API key creation failed');
    } finally {
      setKeySaving(false);
    }
  };

  return (
    <div className="page settings-page">
      <section className="page-heading"><div className="eyebrow"><Settings size={13} /> Archive controls</div><h1>Settings</h1><p>Manage access, retrieval credentials, privacy rules, and lifecycle defaults.</p></section>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {tabs.map((item) => {
            const Icon = item.icon;
            return <button type="button" key={item.id} className={cn(tab === item.id && 'active')} aria-current={tab === item.id ? 'page' : undefined} onClick={() => setTab(item.id)}><Icon size={16} />{item.label}<ChevronRight size={14} /></button>;
          })}
        </nav>

        <div className="settings-content">
          {tab === 'keys' ? (
            <>
              <section className="settings-section">
                <header><div><h2>API keys</h2><p>Keys authenticate CLI, automation, and remote MCP clients.</p></div><Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> Create key</Button></header>
                <div className="key-list">
                  {apiKeys.map((key) => (
                    <article className="key-row" key={key.id}>
                      <span className="key-icon"><FileKey size={17} /></span>
                      <div><strong>{key.name}</strong><code>{key.prefix}••••••••</code><div>{key.scopes.map((scope) => <Badge key={scope}>{scope}</Badge>)}</div></div>
                      <div className="key-usage"><span>Last used {formatRelative(key.lastUsedAt)}</span><small>Created {formatDate(key.createdAt)}</small></div>
                      <IconButton label={`More options for ${key.name}`}><MoreHorizontal size={17} /></IconButton>
                    </article>
                  ))}
                </div>
                <div className="key-warning"><LockKeyhole size={15} /><p>Secrets are shown once. Memoar stores only a salted hash and the visible prefix.</p></div>
              </section>

              <section className="settings-section mcp-section">
                <header><div><h2>Remote MCP</h2><p>Let Claude Code, Codex, and other MCP clients retrieve cited archive evidence.</p></div><Badge className="status-active"><span /> Available</Badge></header>
                <div className="endpoint-row"><span><ServerCog size={16} /></span><div><small>Streamable HTTP endpoint</small><code>{mcpEndpoint}</code></div><CopyButton value={mcpEndpoint} /></div>
                <div className="mcp-clients">
                  {['Claude Code', 'Codex', 'Cursor'].map((client, index) => (
                    <button type="button" key={client}><span><Bot size={16} /></span><div><strong>{client}</strong><small>{index === 0 ? 'Connected 8m ago' : 'View setup command'}</small></div>{index === 0 ? <Badge className="status-active"><Check size={11} /> Connected</Badge> : <ArrowRight size={15} />}</button>
                  ))}
                </div>
                <div className="mcp-discipline"><Sparkles size={16} /><p><strong>Retrieval discipline is built in.</strong> Tools guide agents from search to excerpt to pack before full-session access.</p></div>
              </section>
            </>
          ) : null}

          {tab === 'privacy' ? (
            <section className="settings-section">
              <header><div><h2>Redaction rules</h2><p>Scan captured blocks before upload and before any visibility change.</p></div><Badge><ScanSearch size={12} /> 14 masks active</Badge></header>
              <div className="toggle-list"><Toggle checked={secretScan} onChange={setSecretScan} label="Credentials and private keys" hint="API keys, JWTs, .env blocks, and PEM material" /><Toggle checked={pathScan} onChange={setPathScan} label="Local filesystem paths" hint="Replace home directory segments with [redacted]" /><Toggle checked={emailScan} onChange={setEmailScan} label="Email addresses" hint="Mask likely personal and commit author addresses" /></div>
              <div className="custom-rules"><h3>Custom patterns</h3><div><code>ACME_[A-Z0-9]{'{'}24{'}'}</code><Badge>Account-wide</Badge><IconButton label="Delete custom rule"><Trash2 size={14} /></IconButton></div><Button size="sm"><Plus size={14} /> Add pattern</Button></div>
            </section>
          ) : null}

          {tab === 'retention' ? (
            <section className="settings-section">
              <header><div><h2>Retention</h2><p>Lifecycle policies apply to normalized sessions and their raw artifacts.</p></div></header>
              <div className="retention-options"><label><span><strong>Keep archive indefinitely</strong><small>Recommended while Memoar is your recovery source.</small></span><input type="radio" name="retention" defaultChecked /></label><label><span><strong>Delete after 365 days</strong><small>Pinned and collected sessions are exempt.</small></span><input type="radio" name="retention" /></label><label><span><strong>Custom policy</strong><small>Choose scope and recovery window.</small></span><input type="radio" name="retention" /></label></div>
              <div className="danger-zone"><AlertTriangle size={18} /><div><strong>Delete entire archive</strong><p>Queues permanent removal after a 30-day recovery window.</p></div><Button variant="danger" size="sm">Request deletion</Button></div>
            </section>
          ) : null}

          {tab === 'general' ? (
            <section className="settings-section">
              <header><div><h2>Account</h2><p>The identity this archive belongs to.</p></div></header>
              {/*
                Everything here reflects the signed-in account. It previously
                showed a hardcoded name and address, and sat beside an archive
                picker, a timezone picker and an appearance toggle that were
                wired to nothing. Controls that cannot act do not belong in a
                settings page: they read as capabilities the product has.
              */}
              <div className="profile-card">
                <span className="avatar large">{user ? accountInitials(user.displayName) : '·'}</span>
                <div><strong>{user?.displayName ?? 'Not signed in'}</strong><p>{user?.email ?? '—'}</p></div>
              </div>
            </section>
          ) : null}
        </div>
      </div>

      <Modal open={createOpen} title={createdSecret ? 'Copy your new key' : 'Create API key'} description={createdSecret ? 'This secret will not be shown again.' : 'Give this key only the permissions its client needs.'} onClose={() => { setCreateOpen(false); setCreatedSecret(null); setKeyError(null); }}>
        {!createdSecret ? (
          <>
            <div className="modal-body form-stack">
              <label className="field-label">Key name<input value={keyName} onChange={(event) => setKeyName(event.target.value)} autoFocus /></label>
              <fieldset className="scope-options"><legend>Scopes</legend>{['sessions:read', 'collections:read', 'pack:read', 'notes:write'].map((scope) => <label key={scope}><input type="checkbox" checked={keyScopes.includes(scope)} onChange={(event) => setKeyScopes((current) => event.target.checked ? [...current, scope] : current.filter((value) => value !== scope))} /><span><code>{scope}</code><small>{scope.includes('write') ? 'Create durable notes' : 'Read archive data'}</small></span></label>)}</fieldset>
              {keyError ? <p role="alert">{keyError}</p> : null}
            </div>
            <footer className="modal-actions"><Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button><Button variant="primary" disabled={keySaving || !keyName.trim() || !keyScopes.length} onClick={() => void createKey()}><Fingerprint size={15} /> {keySaving ? 'Creating…' : 'Create key'}</Button></footer>
          </>
        ) : (
          <>
            <div className="modal-body created-key"><span><KeyRound size={22} /></span><div><small>API key</small><code>{createdSecret}</code></div><CopyButton value={createdSecret} label="Copy secret" /><div className="key-warning"><Eye size={15} /><p>Store this secret in your client now. Closing this dialog hides it permanently.</p></div></div>
            <footer className="modal-actions"><Button variant="primary" onClick={() => { setCreateOpen(false); setCreatedSecret(null); }}>I saved this key</Button></footer>
          </>
        )}
      </Modal>
    </div>
  );
}
