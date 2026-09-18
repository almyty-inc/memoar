import { Eye, Fingerprint, KeyRound } from 'lucide-react';
import { Button, CopyButton, Modal } from '../../components/ui';

export function CreateKeyModal({ createOpen, setCreateOpen, createdSecret, setCreatedSecret, keyName, setKeyName, keyScopes, setKeyScopes, keyError, setKeyError, keySaving, createKey }: {
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  createdSecret: string | null;
  setCreatedSecret: (secret: string | null) => void;
  keyName: string;
  setKeyName: (name: string) => void;
  keyScopes: string[];
  setKeyScopes: (update: (current: string[]) => string[]) => void;
  keyError: string | null;
  setKeyError: (error: string | null) => void;
  keySaving: boolean;
  createKey: () => Promise<void>;
}) {
  return (
    <Modal open={createOpen} title={createdSecret ? 'Copy your new key' : 'Create API key'} description={createdSecret ? 'This secret will not be shown again.' : 'Give this key only the permissions its client needs.'} onClose={() => { setCreateOpen(false); setCreatedSecret(null); setKeyError(null); }}>
      {!createdSecret ? (
        <>
          <div className="modal-body form-stack">
            <label className="field-label">Key name<input value={keyName} onChange={(event) => setKeyName(event.target.value)} autoFocus /></label>
            <fieldset className="scope-options"><legend>Scopes</legend>{['sessions:read', 'collections:read', 'pack:read', 'notes:write'].map((scope) => <label key={scope}><input type="checkbox" checked={keyScopes.includes(scope)} onChange={(event) => setKeyScopes((current) => event.target.checked ? [...current, scope] : current.filter((value) => value !== scope))} /><span><code>{scope}</code><small>{scope.includes('write') ? 'Create durable notes' : 'Read archive data'}</small></span></label>)}</fieldset>
            {keyError ? <p role="alert" className="error-note">{keyError}</p> : null}
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
  );
}
