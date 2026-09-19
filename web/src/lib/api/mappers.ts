import { sourceLabel } from '../source-labels';
import type {
  Collection,
  ContentBlock,
  Machine,
  SearchAggregation,
  SessionDetailData,
  SessionSummary,
  SessionTurn,
} from '../types';
import type {
  WireBlock,
  WireCollection,
  WireMachine,
  WireSessionChunk,
  WireSessionSummary,
} from './wire';

/**
 * A summary as the app uses it. What the archive does not know stays absent
 * rather than being given a stand-in that reads like a fact.
 */
export function mapSession(session: WireSessionSummary): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    summary: session.summary ?? '',
    source: session.source,
    sourceLabel: session.sourceLabel,
    workspace: session.workspace,
    ...(session.branch ? { branch: session.branch } : {}),
    ...(session.machineId ? { machineId: session.machineId } : {}),
    ...(session.model ? { model: session.model } : {}),
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    turnCount: session.turnCount,
    tokenCount: session.tokenCount,
    ...(session.durationMinutes === undefined ? {} : { durationMinutes: session.durationMinutes }),
    redactionStatus: session.redactionStatus,
    ...(session.score === undefined ? {} : { score: session.score }),
    ...(session.highlight === undefined ? {} : { highlight: session.highlight }),
  };
}


export function mapAggregation(value: unknown, label: (key: string) => string = (key) => key): SearchAggregation[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([key, count]) => ({ label: label(key), value: label(key), count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}


function stringField(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function mapBlock(block: WireBlock): ContentBlock {
  if (block.kind === 'text' || block.kind === 'thinking' || block.kind === 'system' || block.kind === 'error') {
    return { id: block.id, kind: block.kind, text: block.text ?? '' };
  }
  if (block.kind === 'tool_call') {
    return {
      id: block.id,
      kind: 'tool_call',
      name: block.name ?? 'tool',
      callId: block.callId ?? block.id,
      data: block.data ?? {},
    };
  }
  if (block.kind === 'tool_result') {
    return {
      id: block.id,
      kind: 'tool_result',
      callId: block.callId ?? block.id,
      text: block.text ?? JSON.stringify(block.data ?? {}, null, 2),
      status: block.data?.status === 'error' ? 'error' : 'success',
    };
  }
  if (block.kind === 'diff') {
    return {
      id: block.id,
      kind: 'diff',
      path: stringField(block.data?.path, block.name ?? 'diff'),
      oldText: stringField(block.data?.oldText, stringField(block.data?.before)),
      newText: stringField(block.data?.newText, stringField(block.data?.after, block.text ?? '')),
    };
  }
  return {
    id: block.id,
    kind: 'artifact',
    name: block.name ?? block.artifactRef ?? block.kind,
    mediaType: block.mimeType ?? 'application/octet-stream',
  };
}

export function mapSessionDetail(summary: SessionSummary, chunks: WireSessionChunk[]): SessionDetailData {
  // Flattened once. The cache-read total below used to re-flatten every chunk
  // and scan the result for a turn it already had, once per turn, so opening a
  // long session paid for the whole conversation squared before it drew
  // anything.
  const wireTurns = chunks.flatMap((chunk) => chunk.turns);
  const turns = wireTurns.map((turn): SessionTurn => ({
    id: turn.id,
    ordinal: turn.ordinal,
    parentId: turn.parentId,
    role: turn.role,
    createdAt: turn.createdAt,
    ...(turn.model ? { model: turn.model } : {}),
    ...(turn.tokens ? { tokens: { input: turn.tokens.input, output: turn.tokens.output } } : {}),
    blocks: turn.blocks.map(mapBlock),
  }));
  const tokenTotals = wireTurns.reduce((totals, turn) => ({
    input: totals.input + (turn.tokens?.input ?? 0),
    output: totals.output + (turn.tokens?.output ?? 0),
    cacheRead: totals.cacheRead + (turn.tokens?.cacheRead ?? 0),
  }), { input: 0, output: 0, cacheRead: 0 });
  const createdAt = turns[0]?.createdAt ?? summary.createdAt;
  const durationMinutes = turns.length > 1
    ? Math.max(0, Math.round((new Date(turns.at(-1)!.createdAt).valueOf() - new Date(createdAt).valueOf()) / 60_000))
    : 0;
  return {
    session: {
      ...summary,
      createdAt,
      durationMinutes,
      tokenCount: tokenTotals.input + tokenTotals.output,
      turnCount: turns.length,
    },
    turns,
    provenance: chunks[0]?.provenance ?? [],
    tokenTotals,
  };
}

export function mapCollection(collection: WireCollection): Collection {
  return {
    ...collection,
    description: collection.description ?? '',
    color: '#3d7a1f',
  };
}

export function mapMachine(machine: WireMachine): Machine {
  return {
    id: machine.id,
    name: machine.name,
    platform: machine.platform,
    status: machine.status ?? (machine.lastSeenAt ? 'online' : 'never_connected'),
    lastSeenAt: machine.lastSeenAt ?? null,
    agentVersion: machine.agentVersion ?? 'unknown',
    sources: (machine.sources ?? []).flatMap((source) => {
      const sourceId = source.id ?? source.source;
      if (!sourceId) return [];
      const enabled = source.enabled ?? source.settings?.enabled ?? true;
      return [{
        id: sourceId,
        label: source.label ?? sourceLabel(sourceId),
        enabled,
        // Only when the archive says so. `enabled ? 'synced' : 'disabled'`
        // turned a line in the agent's config into a report on how capture was
        // going, and the answer was "Synced" on every row of every machine.
        ...(source.state ? { state: source.state } : {}),
        sessionCount: source.sessionCount ?? 0,
        lastSyncAt: source.lastSyncAt ?? null,
      }];
    }),
  };
}
