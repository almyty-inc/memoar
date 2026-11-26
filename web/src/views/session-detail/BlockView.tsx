import ReactMarkdown, { type Components } from 'react-markdown';
import { cn } from '../../components/ui';
import type { ContentBlock } from '../../lib/types';
import { CodeBlock, DiffView } from './CodeBlock';
import { OrphanResult, ToolBlock } from './ToolBlock';

type ToolResult = Extract<ContentBlock, { kind: 'tool_result' }>;

/** Fenced code becomes a highlighted block. Inline code stays inline. */
const markdown: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const language = /language-([\w+-]+)/u.exec(className ?? '')?.[1];
    const source = String(children).replace(/\n$/u, '');
    if (!language && !source.includes('\n')) return <code>{children}</code>;
    return <CodeBlock code={source} language={language} />;
  },
  a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
};

export function BlockView({ block, results, showThinking, onShowThinking }: {
  block: ContentBlock;
  /** Results by call id, so a call renders with its own output. */
  results: Map<string, ToolResult>;
  showThinking: boolean;
  /** Reveals thinking for the whole conversation, the way the toggle does. */
  onShowThinking: () => void;
}) {
  if (block.kind === 'thinking') {
    if (!showThinking) {
      return <button type="button" className="thinking-hidden" onClick={onShowThinking}>Thinking hidden. Show</button>;
    }
    return <div className="thinking-block"><span className="thinking-label">Thinking</span><p>{block.text}</p></div>;
  }
  if (block.kind === 'text') {
    return <div className="markdown-body"><ReactMarkdown components={markdown}>{block.text}</ReactMarkdown></div>;
  }
  if (block.kind === 'tool_call') return <ToolBlock call={block} result={results.get(block.callId)} />;
  if (block.kind === 'tool_result') return <OrphanResult result={block} />;
  if (block.kind === 'diff') return <DiffView path={block.path} oldText={block.oldText} newText={block.newText} />;
  if (block.kind === 'artifact') {
    return <div className="artifact-block"><span className="mono">{block.name}</span><span className="meta">{block.mediaType}</span></div>;
  }
  return <div className={cn('system-block', block.kind === 'error' && 'system-error')}>{block.text}</div>;
}
