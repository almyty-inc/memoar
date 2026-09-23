import { KeyRound } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui';
import { memoarApi } from '../../lib/api';
import { MINIMUM_PASSWORD } from '../../lib/limits';

/**
 * Changes the signed-in account's password.
 *
 * Rendered only for an account the server says has a password: one that signs
 * in with a provider has nothing here to change. The archive decides whether
 * the current password is right and whether the new one is long enough, and
 * whatever it says is shown as it said it.
 */
export function ChangePasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setChanged(false);
    if (next !== confirm) {
      setError('The new password and its confirmation do not match.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await memoarApi.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setChanged(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The password could not be changed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section" aria-labelledby="change-password-heading">
      <header><div><h2 id="change-password-heading">Change password</h2><p>Every other browser signed in to this account is signed out. This one stays signed in.</p></div></header>
      <form className="form-stack" onSubmit={(event) => void submit(event)}>
        <label className="field-label">Current password
          <input type="password" autoComplete="current-password" value={current} disabled={saving} onChange={(event) => setCurrent(event.target.value)} />
        </label>
        <label className="field-label">{`New password (${MINIMUM_PASSWORD} characters or more)`}
          <input type="password" autoComplete="new-password" minLength={MINIMUM_PASSWORD} value={next} disabled={saving} onChange={(event) => setNext(event.target.value)} />
        </label>
        <label className="field-label">Confirm new password
          <input type="password" autoComplete="new-password" value={confirm} disabled={saving} onChange={(event) => setConfirm(event.target.value)} />
        </label>
        {error ? <p role="alert" className="error-note">{error}</p> : null}
        {changed ? <p role="status" className="settings-note">Password changed. Other sessions are signed out.</p> : null}
        <div className="actions">
          <Button type="submit" variant="primary" size="sm" disabled={saving || !current || !next || !confirm}>
            <KeyRound size={15} /> {saving ? 'Changing…' : 'Change password'}
          </Button>
        </div>
      </form>
    </section>
  );
}
