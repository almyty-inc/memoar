import { Bot, FileKey, LockKeyhole, Plus, ServerCog, Sparkles, Trash2 } from 'lucide-react';
import type { McpStatus } from '../../lib/api';
import type { ApiKey } from '../../lib/types';
import { Badge, Button, CopyButton, IconButton, formatDate, formatRelative } from '../../components/ui';

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

export function KeysAndMcpTab({ apiKeys, mcpEndpoint, mcpStatus, revoking, revokeKey, setCreateOpen }: {
  apiKeys: ApiKey[];
  mcpEndpoint: string;
  mcpStatus: McpStatus | null;
  revoking: string | null;
  revokeKey: (keyId: string) => Promise<void>;
  setCreateOpen: (open: boolean) => void;
}) {
  return (
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
        {/*
          The badge is measured now. It read "Available" with a live
          green dot, unconditionally, for an endpoint the browser never
          contacted — the same defect as the "Connected 8m ago" row
          below and the literal "Connected" in the topbar. Nothing could
          answer it: the handshake takes an API key the browser does not
          hold. GET /v1/mcp/status is that missing signal, and it names
          the tools as well, so the badge cannot be right about
          availability and wrong about what is available. While the
          request is in flight there is no badge, because "checking" is
          not a status either.
        */}
        <header>
          <div><h2>Remote MCP</h2><p>Let Claude Code, Codex, and other MCP clients retrieve cited archive evidence.</p></div>
          {mcpStatus && (
            <Badge className={mcpStatus.available ? 'status-active' : 'status-idle'}>
              <span />
              {mcpStatus.available ? `${mcpStatus.tools.length} tools` : 'Not served'}
            </Badge>
          )}
        </header>

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
  );
}
