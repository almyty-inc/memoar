import { memoarApi, type DistillationSettings } from '../../lib/api';
import { Badge, Button, Toggle } from '../../components/ui';

/** Cents, as an amount a person recognises. */
function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function DistillationTab({ distillation, setDistillation, distillationError, distillationSaving, persistDistillation, apiKeyDraft, setApiKeyDraft }: {
  distillation: DistillationSettings | null;
  setDistillation: (value: DistillationSettings | null) => void;
  distillationError: string | null;
  distillationSaving: boolean;
  persistDistillation: (update: Parameters<typeof memoarApi.updateDistillationSettings>[0]) => Promise<void>;
  apiKeyDraft: string;
  setApiKeyDraft: (value: string) => void;
}) {
  return (
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

      {distillationError ? <p role="alert" className="error-note">{distillationError}</p> : null}

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
  );
}
