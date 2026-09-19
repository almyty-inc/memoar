import type { TenantSettings } from '../../lib/api';
import { Toggle } from '../../components/ui';

export function RetentionTab({ settings, settingsError, saving, persist }: {
  settings: TenantSettings | null;
  settingsError: string | null;
  saving: boolean;
  persist: (next: TenantSettings) => Promise<void>;
}) {
  return (
    <section className="settings-section">
      <header><div><h2>Retention</h2><p>Lifecycle policies apply to normalized sessions and their raw artifacts.</p></div></header>
      {/*
        These radios were uncontrolled with a defaultChecked, so the
        policy shown had no relationship to the policy in force. The
        "Custom policy" option led nowhere and is now the days field
        that actually exists.
      */}
      {settingsError ? <p role="alert" className="error-note">{settingsError}</p> : null}
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
  );
}
