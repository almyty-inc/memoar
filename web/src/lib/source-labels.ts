import type { Machine } from './types';

/**
 * What each source is called, mirroring the server's table.
 *
 * Sessions carry their label from the server; this covers the places that only
 * have an id to work with, and a test holds it to the
 * server's table so the two cannot drift.
 */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  'antigravity-cli': 'Antigravity CLI',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  copilot: 'GitHub Copilot',
  goose: 'Goose',
  crush: 'Crush',
  roo: 'Roo Code',
  kilo: 'Kilo Code',
  zed: 'Zed',
  'canonical-bundle': 'Canonical bundle',
  'cass-export': 'CASS export',
  'chatgpt-export': 'ChatGPT export',
};

/** The source's own name, or the id when it has none — never a guess. */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/**
 * What a machine's connection state is called.
 *
 * The status is an enum on the wire, and the enum was being printed: a machine
 * that had never checked in was labelled `never_connected`, underscore and all,
 * on the machines page and on the overview tile.
 */
const MACHINE_STATUS_LABELS: Readonly<Record<Machine['status'], string>> = {
  online: 'Online',
  offline: 'Offline',
  never_connected: 'Never connected',
};

export function machineStatusLabel(status: Machine['status']): string {
  return MACHINE_STATUS_LABELS[status] ?? String(status).replace(/_/gu, ' ');
}
