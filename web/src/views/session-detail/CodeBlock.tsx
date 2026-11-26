import { diffLines } from 'diff';
import { useMemo } from 'react';
import { CopyButton } from '../../components/ui';
import { highlight, languageForPath } from '../../lib/highlight';

/** Code with highlighting when the language is known, plain otherwise. */
export function CodeBlock({ code, language, copy = true, className }: {
  code: string;
  language?: string | undefined;
  copy?: boolean;
  className?: string;
}) {
  const html = useMemo(() => highlight(code, language), [code, language]);
  return (
    <div className={className ?? 'code-block'}>
      {copy ? <div className="code-copy"><CopyButton value={code} label="Copy code" /></div> : null}
      <pre data-language={language ?? 'text'}>
        {html === null
          ? <code>{code}</code>
          // highlight.js escapes the source it is given; this is its output only.
          : <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />}
      </pre>
    </div>
  );
}

interface DiffRow { kind: 'same' | 'add' | 'remove' | 'gap'; text: string; oldNo?: number; newNo?: number }

/** Unchanged lines kept on each side of a change. The rest fold into a gap. */
const CONTEXT = 3;

function diffRows(oldText: string, newText: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const part of diffLines(oldText, newText)) {
    const lines = part.value.replace(/\n$/u, '').split('\n');
    for (const line of lines) {
      if (part.added) rows.push({ kind: 'add', text: line, newNo: newNo++ });
      else if (part.removed) rows.push({ kind: 'remove', text: line, oldNo: oldNo++ });
      else rows.push({ kind: 'same', text: line, oldNo: oldNo++, newNo: newNo++ });
    }
  }
  const near = rows.map((row, index) => row.kind !== 'same'
    || rows.slice(Math.max(0, index - CONTEXT), index + CONTEXT + 1).some((other) => other.kind !== 'same'));
  const folded: DiffRow[] = [];
  rows.forEach((row, index) => {
    if (near[index]) folded.push(row);
    else if (folded.at(-1)?.kind !== 'gap') folded.push({ kind: 'gap', text: '' });
  });
  return folded;
}

/** A file edit as a real diff: line numbers, a +/- gutter, folded context. */
export function DiffView({ path, oldText, newText }: { path: string; oldText: string; newText: string }) {
  const rows = useMemo(() => diffRows(oldText, newText), [oldText, newText]);
  const added = rows.filter((row) => row.kind === 'add').length;
  const removed = rows.filter((row) => row.kind === 'remove').length;
  const language = languageForPath(path);
  const patch = rows.filter((row) => row.kind !== 'gap')
    .map((row) => `${row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ' '}${row.text}`).join('\n');

  return (
    <div className="diff-block">
      <header>
        <span className="diff-path">{path}</span>
        <span className="diff-stat"><span className="diff-stat-add">+{added}</span> <span className="diff-stat-remove">-{removed}</span></span>
        <CopyButton value={patch} label="Copy diff" />
      </header>
      <div className="diff-lines" role="table" aria-label={`Diff for ${path}`}>
        {rows.map((row, index) => row.kind === 'gap' ? (
          <div className="diff-row diff-gap" role="row" key={`gap-${index}`}><span role="cell">⋯</span></div>
        ) : (
          <div className={`diff-row diff-${row.kind}`} role="row" key={index}>
            <span className="diff-no" role="cell">{row.oldNo ?? ''}</span>
            <span className="diff-no" role="cell">{row.newNo ?? ''}</span>
            <span className="diff-sign" role="cell" aria-label={row.kind === 'add' ? 'added' : row.kind === 'remove' ? 'removed' : undefined}>
              {row.kind === 'add' ? '+' : row.kind === 'remove' ? '-' : ''}
            </span>
            <DiffLine text={row.text} language={language} />
          </div>
        ))}
      </div>
    </div>
  );
}

function DiffLine({ text, language }: { text: string; language: string | undefined }) {
  const html = useMemo(() => highlight(text, language), [text, language]);
  return html === null
    ? <code role="cell">{text}</code>
    : <code role="cell" className="hljs" dangerouslySetInnerHTML={{ __html: html }} />;
}
