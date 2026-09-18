import { Plus, ScanSearch, Trash2 } from 'lucide-react';
import type { TenantSettings } from '../../lib/api';
import { Badge, Button, IconButton, Toggle } from '../../components/ui';

export function RedactionTab({ settings, settingsError, saving, newPattern, setNewPattern, setRedaction }: {
  settings: TenantSettings | null;
  settingsError: string | null;
  saving: boolean;
  newPattern: string;
  setNewPattern: (value: string) => void;
  setRedaction: (patch: Partial<TenantSettings['redaction']>) => void;
}) {
  return (
    <section className="settings-section">
      <header>
        <div><h2>Redaction rules</h2><p>Scan captured blocks before upload and before any visibility change.</p></div>
        <Badge><ScanSearch size={12} /> {settings ? `${settings.redaction.customPatterns.length} custom ${settings.redaction.customPatterns.length === 1 ? 'pattern' : 'patterns'}` : 'Loading…'}</Badge>
      </header>
      {settingsError ? <p role="alert" className="error-note">{settingsError}</p> : null}
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
  );
}
