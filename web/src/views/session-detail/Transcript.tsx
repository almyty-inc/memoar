import { useMemo } from 'react';
import { AgentMark } from '../../components/AgentMark';
import { cn, formatNumber, formatTime } from '../../components/ui';
import type { ContentBlock, SessionDetailData } from '../../lib/types';
import { BlockView } from './BlockView';

type ToolResult = Extract<ContentBlock, { kind: 'tool_result' }>;

function roleLabel(role: string, sourceLabel: string): string {
  if (role === 'user') return 'You';
  if (role === 'assistant') return sourceLabel;
  if (role === 'tool') return 'Tool';
  return 'System';
}

/**
 * The conversation, turn by turn. A tool result is drawn inside the call that
 * produced it, so the turn after a call does not repeat its output as a loose
 * block. A turn left with nothing to show is skipped.
 */
export function Transcript({ detail, showThinking, setShowThinking }: {
  detail: SessionDetailData;
  showThinking: boolean;
  setShowThinking: (value: boolean) => void;
}) {
  const { results, called } = useMemo(() => {
    const blocks = detail.turns.flatMap((turn) => turn.blocks);
    const callIds = new Set(blocks.flatMap((block) => (block.kind === 'tool_call' ? [block.callId] : [])));
    const byCall = new Map<string, ToolResult>();
    for (const block of blocks) if (block.kind === 'tool_result' && callIds.has(block.callId)) byCall.set(block.callId, block);
    return { results: byCall, called: callIds };
  }, [detail.turns]);

  return (
    <ol className="transcript">
      {detail.turns.map((turn) => {
        const blocks = turn.blocks.filter((block) => !(block.kind === 'tool_result' && called.has(block.callId)));
        if (blocks.length === 0) return null;
        return (
          <li key={turn.id} className={cn('turn', `turn-${turn.role}`)}>
            <div className="turn-head">
              {turn.role === 'assistant' ? <AgentMark source={detail.session.source} label={detail.session.sourceLabel} size={22} /> : null}
              <span className={turn.role === 'user' ? 'turn-role sr-only' : 'turn-role'}>{roleLabel(turn.role, detail.session.sourceLabel)}</span>
              <span className="turn-time">{formatTime(turn.createdAt)}</span>
              {turn.model ? <span className="turn-model">{turn.model}</span> : null}
              {turn.tokens ? <span className="turn-tokens">{formatNumber(turn.tokens.input)} in, {formatNumber(turn.tokens.output)} out</span> : null}
            </div>
            <div className="turn-body">
              {blocks.map((block) => (
                <BlockView key={block.id} block={block} results={results} showThinking={showThinking} onShowThinking={() => setShowThinking(true)} />
              ))}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
