import { Bot, Eye, EyeOff, User } from 'lucide-react';
import type { SessionDetailData, SessionSummary } from '../../lib/types';
import { Badge, cn, formatDate, formatNumber } from '../../components/ui';
import { BlockView } from './BlockView';

export function ConversationColumn({ detail, session, showThinking, setShowThinking }: {
  detail: SessionDetailData;
  session: SessionSummary;
  showThinking: boolean;
  setShowThinking: (value: boolean) => void;
}) {
  return (
    <main className="conversation-column">
      <div className="conversation-toolbar">
        <div>
          <strong>{detail.turns.length} turns</strong>
          <span>{formatDate(session.createdAt)}{session.durationMinutes ? ` · ${session.durationMinutes} minutes` : ''}</span>
        </div>
        <label className="thinking-control">
          <input type="checkbox" checked={showThinking} onChange={(event) => setShowThinking(event.target.checked)} />
          {showThinking ? <Eye size={14} /> : <EyeOff size={14} />}
          Show thinking
        </label>
      </div>

      <ol className="conversation-list">
        {detail.turns.map((turn) => (
          <li key={turn.id} className={cn('turn', `turn-${turn.role}`)}>
            <div className="turn-rail">
              <span className="turn-avatar">{turn.role === 'user' ? <User size={15} /> : <Bot size={15} />}</span>
              <span className="turn-line" />
            </div>
            <article className="turn-content">
              <header>
                <div><strong>{turn.role === 'user' ? 'You' : turn.role === 'assistant' ? session.sourceLabel : turn.role}</strong>
                {turn.model ? <Badge>{turn.model}</Badge> : null}</div>
                <span>{new Intl.DateTimeFormat('en', { hour: 'numeric', minute: '2-digit' }).format(new Date(turn.createdAt))}</span>
              </header>
              <div className="turn-blocks">
                {turn.blocks.map((block) => (
                  <BlockView key={block.id} block={block} showThinking={showThinking} onShowThinking={() => setShowThinking(true)} />
                ))}
              </div>
              {turn.tokens ? <footer>{formatNumber(turn.tokens.input)} in · {formatNumber(turn.tokens.output)} out</footer> : null}
            </article>
          </li>
        ))}
      </ol>
    </main>
  );
}
