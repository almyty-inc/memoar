import { Check, ChevronDown, Copy, EyeOff, FileCode2, Sparkles, TerminalSquare } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { ContentBlock } from '../../lib/types';
import { Badge, IconButton, cn } from '../../components/ui';

export function BlockView({ block, showThinking, onShowThinking }: {
  block: ContentBlock;
  showThinking: boolean;
  /** Reveals thinking for the whole conversation, the way the toolbar does. */
  onShowThinking: () => void;
}) {
  if (block.kind === 'thinking') {
    /*
      This was a <button> with no handler that told you to go and press a
      different control — focusable, announced as a button, and doing nothing
      at all when anybody pressed it. It does what it says instead.
    */
    if (!showThinking) return <button type="button" className="thinking-hidden" onClick={onShowThinking}><EyeOff size={14} /> Thinking hidden — show it</button>;
    return <div className="thinking-block"><span><Sparkles size={14} /> Thinking</span><p>{block.text}</p></div>;
  }
  if (block.kind === 'text') {
    return <div className="markdown-body"><ReactMarkdown>{block.text}</ReactMarkdown></div>;
  }
  if (block.kind === 'tool_call') {
    return (
      <details className="tool-block">
        <summary><span><TerminalSquare size={15} /> {block.name}</span><code>{block.callId}</code><ChevronDown size={14} /></summary>
        <SyntaxCode value={JSON.stringify(block.data, null, 2)} language="json" />
      </details>
    );
  }
  if (block.kind === 'tool_result') {
    return (
      <details className={cn('tool-block', block.status === 'error' && 'tool-error')}>
        <summary><span><Check size={15} /> Tool result</span><Badge>{block.status}</Badge><ChevronDown size={14} /></summary>
        <SyntaxCode value={block.text} language="text" />
      </details>
    );
  }
  if (block.kind === 'diff') {
    const removed = block.oldText.split('\n');
    const added = block.newText.split('\n');
    return (
      <div className="diff-block">
        <header><FileCode2 size={15} /><span>{block.path}</span><Badge>{Math.max(removed.length, added.length)} lines</Badge><IconButton label="Copy diff" onClick={() => void navigator.clipboard.writeText([...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join('\n'))}><Copy size={13} /></IconButton></header>
        <div className="diff-lines" role="table" aria-label={`Diff for ${block.path}`}>
          {removed.map((line, index) => <span className="diff-old" role="row" key={`old-${index}`}><b>−</b><code>{line}</code></span>)}
          {added.map((line, index) => <span className="diff-new" role="row" key={`new-${index}`}><b>+</b><code>{line}</code></span>)}
        </div>
      </div>
    );
  }
  if (block.kind === 'artifact') return <div className="artifact-block"><FileCode2 size={16} /> {block.name}<Badge>{block.mediaType}</Badge></div>;
  return <div className={cn('system-block', block.kind === 'error' && 'error')}>{block.text}</div>;
}


function SyntaxCode({ value, language }: { value: string; language: 'json' | 'text' }) {
  if (language !== 'json') return <pre className="syntax-block" data-language={language}><code>{value}</code></pre>;
  const tokens = value.split(/("(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?\b|\b(?:true|false|null)\b)/gu);
  return (
    <pre className="syntax-block" data-language={language}><code>{tokens.map((token, index) => {
      let className = '';
      if (/^".*"\s*:$/u.test(token)) className = 'syntax-key';
      else if (token.startsWith('"')) className = 'syntax-string';
      else if (/^-?\d/u.test(token)) className = 'syntax-number';
      else if (/^(?:true|false|null)$/u.test(token)) className = 'syntax-literal';
      return <span className={className} key={`${index}-${token.slice(0, 8)}`}>{token}</span>;
    })}</code></pre>
  );
}
