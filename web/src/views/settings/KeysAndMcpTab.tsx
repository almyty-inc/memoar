import type { McpStatus } from '../../lib/api';
import type { ApiKey } from '../../lib/types';
import { Badge, Button, CopyButton, formatDate, formatRelative, plural } from '../../components/ui';

/**
 * How to point a client at this archive, verified against the installed CLIs
 * and the endpoint: it authenticates an API key through x-memoar-key, and a
 * bearer token only when the token came from the handshake. Codex takes no
 * custom header, only a bearer token from an environment variable, which is
 * what the handshake mints.
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

export function KeysAndMcpTab({ apiKeys, mcpEndpoint, mcpStatus, revoking, revokeError, revokeKey, setCreateOpen }: {
  apiKeys: ApiKey[];
  mcpEndpoint: string;
  mcpStatus: McpStatus | null;
  revoking: string | null;
  revokeError: string | null;
  revokeKey: (keyId: string) => Promise<void>;
  setCreateOpen: (open: boolean) => void;
}) {
  return (
    <>
      <section className="settings-section">
        <header>
          <div><h2>API keys</h2><p>For the CLI, automation and MCP clients. A secret is shown once, and only a salted hash is stored.</p></div>
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>Create key</Button>
        </header>
        <div className="row-list">
          {apiKeys.length === 0 ? <p className="empty-note">No keys yet.</p> : null}
          {apiKeys.map((key) => (
            <div className="row" key={key.id}>
              <strong className="row-name">{key.name}</strong>
              <code className="meta">{key.prefix}…</code>
              <span className="row-main meta">{key.scopes.join(', ')}</span>
              <span className="row-meta">{key.lastUsedAt ? `Used ${formatRelative(key.lastUsedAt)}` : 'Never used'}</span>
              <span className="row-meta">Created {formatDate(key.createdAt)}</span>
              <Button size="sm" variant="ghost" aria-label={`Revoke ${key.name}`} disabled={revoking === key.id} onClick={() => void revokeKey(key.id)}>Revoke</Button>
            </div>
          ))}
        </div>
        {revokeError ? <p role="alert" className="error-note">{revokeError}</p> : null}
      </section>

      <section className="settings-section mcp-section">
        {/*
          The status is measured: GET /v1/mcp/status answers whether MCP is
          served and with which tools. While it is in flight there is no
          status, because "checking" is not one.
        */}
        <header>
          <div><h2>Remote MCP</h2><p>Lets Claude Code, Codex and other MCP clients search this archive and cite it.</p></div>
          {mcpStatus && (
            <Badge className={mcpStatus.available ? 'status-active' : 'status-idle'}>
              <span className={mcpStatus.available ? 'dot dot-ok' : 'dot'} aria-hidden="true" />
              {mcpStatus.available ? plural(mcpStatus.tools.length, 'tool') : 'Not served'}
            </Badge>
          )}
        </header>
        <div className="command-stack">
          <p className="field-label">Streamable HTTP endpoint</p>
          <div className="command"><code>{mcpEndpoint}</code><CopyButton value={mcpEndpoint} label="Copy endpoint" /></div>
          {/* Setup commands, not connection status: Memoar cannot know which
              clients have added it, so it says how to add it. */}
          {mcpCommands(mcpEndpoint).map((client) => (
            <div key={client.name}>
              <p className="field-label">{client.name}</p>
              <div className="command"><code>{client.command}</code><CopyButton value={client.command} label={`Copy ${client.name} command`} /></div>
            </div>
          ))}
        </div>
        <p className="field-hint">Agents are steered from search to excerpt to pack before they read a whole session.</p>
      </section>
    </>
  );
}
