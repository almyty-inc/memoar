import { Eye, Fingerprint, KeyRound } from 'lucide-react';
import { Button, CopyButton, Modal } from '../../components/ui';

/**
 * The scopes a person may put on a key, named as the server names them.
 *
 * This offered `sessions:read`, `collections:read`, `pack:read` and
 * `notes:write`. None of those exist. `createApiKey` stored whatever arrived
 * without checking it, so every key made here carried four scopes no route
 * recognises and would have been refused by all of them — and the acceptance
 * test asserted a 201 and got one, because the server accepted nonsense.
 *
 * Only scopes a signed-in person actually holds are offered: no `keys:write`,
 * which would let a key mint another, and nothing belonging to a machine
 * credential. A test holds this list to the server's.
 */
export const KEY_SCOPES: { scope: string; purpose: string }[] = [
  { scope: 'archive:read', purpose: 'Read sessions, search, and build packs' },
  { scope: 'mcp:use', purpose: 'Connect an MCP client to this archive' },
  { scope: 'archive:write', purpose: 'Save notes and curate collections' },
  { scope: 'sharing:write', purpose: 'Create and revoke share links' },
];

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
            <fieldset className="scope-options"><legend>Scopes</legend>{KEY_SCOPES.map(({ scope, purpose }) => <label key={scope}><input type="checkbox" checked={keyScopes.includes(scope)} onChange={(event) => setKeyScopes((current) => event.target.checked ? [...current, scope] : current.filter((value) => value !== scope))} /><span><code>{scope}</code><small>{purpose}</small></span></label>)}</fieldset>
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
