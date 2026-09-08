import {
  Bot,
  ChevronRight,
  Clock3,
  Eye,
  FileKey,
  Fingerprint,
  KeyRound,
  LockKeyhole,
  Plus,
  ScanSearch,
  ServerCog,
  Settings,
  Shield,
  Sparkles,
  Trash2,
  UserRound,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { accountInitials } from '../lib/account';
import { memoarApi, type DistillationSettings, type TenantSettings } from '../lib/api';
import type { CurrentUser, ApiKey } from '../lib/types';
import { Badge, Button, CopyButton, IconButton, Modal, Toggle, cn, formatDate, formatRelative } from '../components/ui';

type SettingsTab = 'general' | 'keys' | 'privacy' | 'retention' | 'distillation';

const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Settings }> = [
  { id: 'general', label: 'General', icon: UserRound },
  { id: 'keys', label: 'API keys & MCP', icon: KeyRound },
  { id: 'privacy', label: 'Redaction', icon: Shield },
  { id: 'retention', label: 'Retention', icon: Clock3 },
  { id: 'distillation', label: 'Distillation', icon: Sparkles },
];

/** Cents, as an amount a person recognises. */
function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * How to point a client at this archive.
 *
 * Verified against the installed CLIs and against the endpoint itself: it
 * authenticates an API key through x-memoar-key, and a bearer token only when
 * the token came from the handshake. The first version of this omitted the
 * credential entirely, so following it produced a server that could not
 * authenticate — a command that runs and then does not work.
 *
 * Codex takes no custom header, only a bearer token from an environment
 * variable, which is what the handshake exists to mint.
 */
function mcpCommands(endpoint: string): { name: string; command: string }[] {
  const handshake = `${endpoint.replace(/\/mcp$/, '')}/v1/mcp/auth/handshake`;
  return [
    {
      name: 'Claude Code',
      command: `claude mcp add --transport http memoar ${endpoint} --header "X-Memoar-Key: $MEMOAR_API_KEY"`,
    },
    {
      name: 'Codex',
      command: `export MEMOAR_MCP_TOKEN=$(curl -s -X POST ${handshake} -H "x-memoar-key: $MEMOAR_API_KEY" -H 'content-type: application/json' -d '{"clientName":"codex","protocolVersion":"2025-06-18"}' | jq -r .accessToken) && codex mcp add memoar --url ${endpoint} --bearer-token-env-var MEMOAR_MCP_TOKEN`,
    },
  ];
}

export function SettingsView({ apiKeys, mcpEndpoint, user, onCreateKey, onKeyRevoked }: { apiKeys: ApiKey[]; mcpEndpoint: string; user: CurrentUser | null; onCreateKey: (name: string, scopes: string[]) => Promise<string>; onKeyRevoked: () => void }) {
  const [tab, setTab] = useState<SettingsTab>('keys');
  const [createOpen, setCreateOpen] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('Codex MCP');
  const [keyScopes, setKeyScopes] = useState<string[]>(['sessions:read', 'collections:read', 'pack:read']);
  const [keySaving, setKeySaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  // Settings are loaded from and written back to the archive. These were local
  // useState only: every toggle appeared to work and nothing was ever saved.
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newPattern, setNewPattern] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);
  // Distillation used to be a server-wide environment variable, which meant one
  // operator key paid for everybody and every account's sessions went through
  // the operator's provider. It is an account's own choice and an account's own
  // key, so it is a screen.
  const [distillation, setDistillation] = useState<DistillationSettings | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [distillationError, setDistillationError] = useState<string | null>(null);
  const [distillationSaving, setDistillationSaving] = useState(false);

  const revokeKey = async (keyId: string) => {
    setRevoking(keyId);
    setKeyError(null);
    try {
      await memoarApi.revokeApiKey(keyId);
      onKeyRevoked();
    } catch (error) {
      setKeyError(error instanceof Error ? error.message : 'API key could not be revoked');
    } finally {
      setRevoking(null);
    }
  };

  useEffect(() => {
    let active = true;
    void memoarApi.getSettings()
      .then((loaded) => { if (active) setSettings(loaded); })
      .catch((error: unknown) => { if (active) setSettingsError(error instanceof Error ? error.message : 'Settings could not be loaded'); });
    void memoarApi.getDistillationSettings()
      .then((loaded) => { if (active) setDistillation(loaded); })
      .catch((error: unknown) => { if (active) setDistillationError(error instanceof Error ? error.message : 'Distillation settings could not be loaded'); });
    return () => { active = false; };
  }, []);

  /**
   * Saves the distillation settings.
   *
   * `apiKey` is passed through exactly as given: absent leaves the stored key
   * alone, null clears it, a string replaces it. Sending an empty string here
   * instead of omitting the field is what would quietly delete somebody's key
   * every time they changed their budget.
   */
  const persistDistillation = async (update: Parameters<typeof memoarApi.updateDistillationSettings>[0]) => {
    setDistillationSaving(true);
    setDistillationError(null);
    try {
      setDistillation(await memoarApi.updateDistillationSettings(update));
      // Cleared on success only: a rejected key stays in the box so it can be
      // corrected rather than retyped.
      if (update.apiKey !== undefined) setApiKeyDraft('');
    } catch (error) {
      setDistillationError(error instanceof Error ? error.message : 'Distillation settings could not be saved');
    } finally {
      setDistillationSaving(false);
    }
  };

  const persist = async (next: TenantSettings) => {
    const previous = settings;
    setSettings(next);
    setSaving(true);
    setSettingsError(null);
    try {
      setSettings(await memoarApi.updateSettings({ redaction: next.redaction, retention: next.retention }));
    } catch (error) {
      // Put the old value back rather than leaving the screen showing a
      // setting the archive never accepted.
      setSettings(previous);
      setSettingsError(error instanceof Error ? error.message : 'Settings could not be saved');
    } finally {
      setSaving(false);
    }
  };

  const setRedaction = (patch: Partial<TenantSettings['redaction']>) => {
    if (!settings) return;
    void persist({ ...settings, redaction: { ...settings.redaction, ...patch } });
  };

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
                      {/* An overflow menu that never opened; revoking is the action a key row has. */}
                      <IconButton
                        label={`Revoke ${key.name}`}
                        disabled={revoking === key.id}
                        onClick={() => void revokeKey(key.id)}
                      ><Trash2 size={16} /></IconButton>
                    </article>
                  ))}
                </div>
                <div className="key-warning"><LockKeyhole size={15} /><p>Secrets are shown once. Memoar stores only a salted hash and the visible prefix.</p></div>
              </section>

              <section className="settings-section mcp-section">
                <header><div><h2>Remote MCP</h2><p>Let Claude Code, Codex, and other MCP clients retrieve cited archive evidence.</p></div><Badge className="status-active"><span /> Available</Badge></header>
                <div className="endpoint-row"><span><ServerCog size={16} /></span><div><small>Streamable HTTP endpoint</small><code>{mcpEndpoint}</code></div><CopyButton value={mcpEndpoint} /></div>
                {/*
                  Setup commands, not connection status. This listed three
                  clients and marked whichever came first as "Connected 8m ago"
                  with a green badge — a status decided by list position, for a
                  connection nobody had checked. Memoar has no way to know which
                  clients have added it, so it says what it does know: how to
                  add it. Both commands are the ones those CLIs accept.
                */}
                <div className="mcp-clients">
                  {mcpCommands(mcpEndpoint).map((client) => (
                    <div className="mcp-client" key={client.name}>
                      <span><Bot size={16} /></span>
                      <div><strong>{client.name}</strong><code>{client.command}</code></div>
                      <CopyButton value={client.command} label={`Copy ${client.name} command`} />
                    </div>
                  ))}
                </div>
                <div className="mcp-discipline"><Sparkles size={16} /><p><strong>Retrieval discipline is built in.</strong> Tools guide agents from search to excerpt to pack before full-session access.</p></div>
              </section>
            </>
          ) : null}

          {tab === 'privacy' ? (
            <section className="settings-section">
              {/*
                The badge here read "14 masks active" and the custom pattern
                list showed a hardcoded ACME_[A-Z0-9]{24} rule with a delete
                button that did nothing. Both are real values now.
              */}
              <header>
                <div><h2>Redaction rules</h2><p>Scan captured blocks before upload and before any visibility change.</p></div>
                <Badge><ScanSearch size={12} /> {settings ? `${settings.redaction.customPatterns.length} custom ${settings.redaction.customPatterns.length === 1 ? 'pattern' : 'patterns'}` : 'Loading…'}</Badge>
              </header>
              {settingsError ? <p role="alert">{settingsError}</p> : null}
              <div className="toggle-list">
                <Toggle checked={settings?.redaction.secretScan ?? false} onChange={(value) => setRedaction({ secretScan: value })} label="Credentials and private keys" hint="API keys, JWTs, .env blocks, and PEM material" />
                <Toggle checked={settings?.redaction.pathScan ?? false} onChange={(value) => setRedaction({ pathScan: value })} label="Local filesystem paths" hint="Replace home directory segments with [redacted]" />
                <Toggle checked={settings?.redaction.emailScan ?? false} onChange={(value) => setRedaction({ emailScan: value })} label="Email addresses" hint="Mask likely personal and commit author addresses" />
              </div>
              <div className="custom-rules">
                <h3>Custom patterns</h3>
                {(settings?.redaction.customPatterns ?? []).length === 0 ? <p className="empty-note">No custom patterns.</p> : null}
                {(settings?.redaction.customPatterns ?? []).map((pattern) => (
                  <div key={pattern}>
                    <code>{pattern}</code>
                    <IconButton
                      label={`Delete custom rule ${pattern}`}
                      onClick={() => setRedaction({ customPatterns: (settings?.redaction.customPatterns ?? []).filter((entry) => entry !== pattern) })}
                    ><Trash2 size={14} /></IconButton>
                  </div>
                ))}
                <div className="custom-rule-add">
                  <input
                    aria-label="New redaction pattern"
                    placeholder="ACME_[A-Z0-9]{24}"
                    value={newPattern}
                    onChange={(event) => setNewPattern(event.target.value)}
                  />
                  <Button
                    size="sm"
                    disabled={saving || newPattern.trim().length === 0 || !settings}
                    onClick={() => {
                      const pattern = newPattern.trim();
                      setRedaction({ customPatterns: [...(settings?.redaction.customPatterns ?? []), pattern] });
                      setNewPattern('');
                    }}
                  ><Plus size={14} /> Add pattern</Button>
                </div>
              </div>
            </section>
          ) : null}

          {tab === 'retention' ? (
            <section className="settings-section">
              <header><div><h2>Retention</h2><p>Lifecycle policies apply to normalized sessions and their raw artifacts.</p></div></header>
              {/*
                These radios were uncontrolled with a defaultChecked, so the
                policy shown had no relationship to the policy in force. The
                "Custom policy" option led nowhere and is now the days field
                that actually exists.
              */}
              {settingsError ? <p role="alert">{settingsError}</p> : null}
              <div className="retention-options">
                <label>
                  <span><strong>Keep archive indefinitely</strong><small>Recommended while Memoar is your recovery source.</small></span>
                  <input
                    type="radio"
                    name="retention"
                    checked={settings?.retention.policy === 'indefinite'}
                    disabled={!settings || saving}
                    onChange={() => settings && void persist({ ...settings, retention: { ...settings.retention, policy: 'indefinite' } })}
                  />
                </label>
                <label>
                  <span>
                    <strong>Delete after a fixed age</strong>
                    <small>Sessions in a collection are exempt when that is enabled below.</small>
                  </span>
                  <input
                    type="radio"
                    name="retention"
                    checked={settings?.retention.policy === 'days'}
                    disabled={!settings || saving}
                    onChange={() => settings && void persist({ ...settings, retention: { ...settings.retention, policy: 'days', days: settings.retention.days ?? 365 } })}
                  />
                </label>
              </div>
              {settings?.retention.policy === 'days' ? (
                <div className="form-grid">
                  <label className="field-label">Delete after
                    <input
                      type="number"
                      min={1}
                      value={settings.retention.days ?? 365}
                      onChange={(event) => void persist({ ...settings, retention: { ...settings.retention, days: Math.max(1, Number(event.target.value)) } })}
                    />
                  </label>
                  <Toggle
                    checked={settings.retention.exemptCollected}
                    onChange={(value) => void persist({ ...settings, retention: { ...settings.retention, exemptCollected: value } })}
                    label="Exempt collected sessions"
                    hint="Sessions that belong to a collection are never swept"
                  />
                </div>
              ) : null}
            </section>
          ) : null}

          {tab === 'distillation' ? (
            <section className="settings-section">
              <header>
                <div>
                  <h2>Distillation</h2>
                  <p>Read sessions with a language model and keep the decisions as notes. Your key, your provider, your bill.</p>
                </div>
                <Badge className={distillation?.enabled && distillation.keySet ? 'status-active' : undefined}>
                  <span /> {distillation?.enabled && distillation.keySet ? 'Active' : 'Off'}
                </Badge>
              </header>

              {/*
                The one feature that sends archived content anywhere else, so it
                says so plainly rather than burying it in a tooltip.
              */}
              <p className="settings-note">
                This is the only part of Memoar that sends your sessions to a third party. Nothing is sent until you
                choose a provider and add a key, and the key is stored encrypted and never shown again.
              </p>

              {distillationError ? <p role="alert">{distillationError}</p> : null}

              <div className="form-grid">
                <label className="field-label">Provider
                  <select
                    value={distillation?.provider ?? 'none'}
                    disabled={!distillation || distillationSaving}
                    onChange={(event) => {
                      const provider = event.target.value as DistillationSettings['provider'];
                      // Choosing "none" clears the key: keeping somebody's
                      // credential after they turned the feature off would be
                      // holding a secret with no reason to.
                      void persistDistillation(provider === 'none' ? { provider, apiKey: null } : { provider });
                    }}
                  >
                    <option value="none">None — distillation off</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </label>

                <label className="field-label">Model
                  <input
                    type="text"
                    placeholder="claude-opus-5"
                    value={distillation?.model ?? ''}
                    disabled={!distillation || distillationSaving}
                    onChange={(event) => setDistillation(distillation ? { ...distillation, model: event.target.value } : null)}
                    onBlur={(event) => void persistDistillation({ model: event.target.value || null })}
                  />
                </label>
              </div>

              <div className="form-grid">
                <label className="field-label">
                  {distillation?.keySet ? `API key — a key ending ${distillation.keyHint ?? '••••'} is stored` : 'API key'}
                  <input
                    type="password"
                    autoComplete="off"
                    placeholder={distillation?.keySet ? 'Enter a new key to replace it' : 'sk-ant-…'}
                    value={apiKeyDraft}
                    disabled={!distillation || distillationSaving}
                    onChange={(event) => setApiKeyDraft(event.target.value)}
                  />
                </label>
                <div className="actions">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={apiKeyDraft.length < 8 || distillationSaving}
                    onClick={() => void persistDistillation({ provider: 'anthropic', apiKey: apiKeyDraft })}
                  >
                    {distillation?.keySet ? 'Replace key' : 'Save key'}
                  </Button>
                  {distillation?.keySet ? (
                    <Button size="sm" disabled={distillationSaving} onClick={() => void persistDistillation({ provider: 'none', apiKey: null })}>
                      Remove key
                    </Button>
                  ) : null}
                </div>
              </div>

              <div className="form-grid">
                <Toggle
                  checked={distillation?.enabled ?? false}
                  onChange={(value) => void persistDistillation({ enabled: value })}
                  label="Distil sessions"
                  hint={distillation?.keySet ? 'Runs only when you ask for a session to be distilled' : 'Add a key first'}
                />
                <label className="field-label">Monthly limit
                  <input
                    type="number"
                    min={0}
                    step={1}
                    value={distillation ? distillation.monthlyBudgetCents / 100 : 0}
                    disabled={!distillation || distillationSaving}
                    onChange={(event) => setDistillation(distillation ? { ...distillation, monthlyBudgetCents: Math.max(0, Math.round(Number(event.target.value) * 100)) } : null)}
                    onBlur={(event) => void persistDistillation({ monthlyBudgetCents: Math.max(0, Math.round(Number(event.target.value) * 100)) })}
                  />
                </label>
              </div>

              {distillation ? (
                <p className="settings-note">
                  {money(distillation.monthlySpentCents)} of {money(distillation.monthlyBudgetCents)} used this month.
                  A session is refused before it runs if its estimate would take you past the limit.
                </p>
              ) : null}
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
