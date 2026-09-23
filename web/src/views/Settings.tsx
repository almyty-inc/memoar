import { ChevronRight, Clock3, KeyRound, Settings, Shield, Sparkles, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { accountInitials } from '../lib/account';
import { memoarApi, type DistillationSettings, type TenantSettings, McpStatus } from '../lib/api';
import type { CurrentUser, ApiKey } from '../lib/types';
import { cn } from '../components/ui';
import { ChangePasswordForm } from './settings/ChangePasswordForm';
import { CreateKeyModal } from './settings/CreateKeyModal';
import { DistillationTab } from './settings/DistillationTab';
import { KeysAndMcpTab } from './settings/KeysAndMcpTab';
import { RedactionTab } from './settings/RedactionTab';
import { RetentionTab } from './settings/RetentionTab';

type SettingsTab = 'general' | 'keys' | 'privacy' | 'retention' | 'distillation';

const tabs: Array<{ id: SettingsTab; label: string; icon: typeof Settings }> = [
  { id: 'general', label: 'General', icon: UserRound },
  { id: 'keys', label: 'API keys & MCP', icon: KeyRound },
  { id: 'privacy', label: 'Redaction', icon: Shield },
  { id: 'retention', label: 'Retention', icon: Clock3 },
  { id: 'distillation', label: 'Distillation', icon: Sparkles },
];

export function SettingsView({ apiKeys, mcpEndpoint, user, onCreateKey, onKeyRevoked }: { apiKeys: ApiKey[]; mcpEndpoint: string; user: CurrentUser | null; onCreateKey: (name: string, scopes: string[]) => Promise<string>; onKeyRevoked: () => void }) {
  const [tab, setTab] = useState<SettingsTab>('keys');
  // Null until the archive answers, and null again if it refuses: a failed
  // check is not evidence of availability in either direction.
  const [mcpStatus, setMcpStatus] = useState<McpStatus | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [keyName, setKeyName] = useState('Codex MCP');
  const [keyScopes, setKeyScopes] = useState<string[]>(['archive:read', 'mcp:use']);
  const [keySaving, setKeySaving] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  // Settings are loaded from and written back to the archive. These were local
  // useState only: every toggle appeared to work and nothing was ever saved.
  const [settings, setSettings] = useState<TenantSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [newPattern, setNewPattern] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);
  // An account chooses its own provider and brings its own key.
  const [distillation, setDistillation] = useState<DistillationSettings | null>(null);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [distillationError, setDistillationError] = useState<string | null>(null);
  const [distillationSaving, setDistillationSaving] = useState(false);

  /*
    Revoking reports into the key list, not into the create-key dialog.

    This wrote its failure to `keyError`, which is rendered in exactly one
    place: inside the create-key modal. That modal is closed while you are
    revoking from the list, so "API key could not be revoked" was set and never
    shown to anybody — the row simply stopped being busy and the key stayed.
    A credential you believe you have revoked and have not is the worst way for
    this particular failure to be silent.
  */
  const revokeKey = async (keyId: string) => {
    setRevoking(keyId);
    setRevokeError(null);
    try {
      await memoarApi.revokeApiKey(keyId);
      onKeyRevoked();
    } catch (error) {
      setRevokeError(error instanceof Error ? error.message : 'API key could not be revoked');
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
    // A failed check leaves the badge absent rather than claiming either
    // answer. The page is still useful without it — the endpoint and the setup
    // commands do not depend on knowing.
    void memoarApi.getMcpStatus()
      .then((loaded) => { if (active) setMcpStatus(loaded); })
      .catch(() => { if (active) setMcpStatus(null); });
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
            <KeysAndMcpTab
              apiKeys={apiKeys}
              mcpEndpoint={mcpEndpoint}
              mcpStatus={mcpStatus}
              revoking={revoking}
              revokeKey={revokeKey}
              revokeError={revokeError}
              setCreateOpen={setCreateOpen}
            />
          ) : null}

          {tab === 'privacy' ? (
            <RedactionTab
              settings={settings}
              settingsError={settingsError}
              saving={saving}
              newPattern={newPattern}
              setNewPattern={setNewPattern}
              setRedaction={setRedaction}
            />
          ) : null}

          {tab === 'retention' ? (
            <RetentionTab
              settings={settings}
              settingsError={settingsError}
              saving={saving}
              persist={persist}
            />
          ) : null}

          {tab === 'distillation' ? (
            <DistillationTab
              distillation={distillation}
              setDistillation={setDistillation}
              distillationError={distillationError}
              distillationSaving={distillationSaving}
              persistDistillation={persistDistillation}
              apiKeyDraft={apiKeyDraft}
              setApiKeyDraft={setApiKeyDraft}
            />
          ) : null}

          {tab === 'general' ? (
            <section className="settings-section">
              <header><div><h2>Account</h2><p>The identity this archive belongs to.</p></div></header>
              {/* Only controls that can act: a setting wired to nothing reads
                  as a capability the product has. */}
              <div className="profile-card">
                <span className="avatar large">{user ? accountInitials(user.displayName) : '·'}</span>
                <div><strong>{user?.displayName ?? 'Not signed in'}</strong><p>{user?.email ?? '—'}</p></div>
              </div>
            </section>
          ) : null}
          {/* The server says whether there is a password. A provider-only
              account has none, and a form for it could only fail. */}
          {tab === 'general' && user?.hasPassword === true ? <ChangePasswordForm /> : null}
        </div>
      </div>

      <CreateKeyModal
        createOpen={createOpen}
        setCreateOpen={setCreateOpen}
        createdSecret={createdSecret}
        setCreatedSecret={setCreatedSecret}
        keyName={keyName}
        setKeyName={setKeyName}
        keyScopes={keyScopes}
        setKeyScopes={setKeyScopes}
        keyError={keyError}
        setKeyError={setKeyError}
        keySaving={keySaving}
        createKey={createKey}
      />
    </div>
  );
}
