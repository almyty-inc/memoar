import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn, plural } from '../../components/ui';
import { languageForPath } from '../../lib/highlight';
import type { ContentBlock } from '../../lib/types';
import { CodeBlock, DiffView } from './CodeBlock';

type ToolCall = Extract<ContentBlock, { kind: 'tool_call' }>;
type ToolResult = Extract<ContentBlock, { kind: 'tool_result' }>;
type Kind = 'shell' | 'read' | 'edit' | 'write' | 'patch' | 'search' | 'other';

const KINDS: Array<[Kind, RegExp]> = [
  ['shell', /^(bash|shell|sh|exec_command|run_terminal_cmd|local_shell|terminal|run_shell_command)$/u],
  ['read', /^(read|read_file|view|cat|open_file|view_file)$/u],
  ['patch', /^(apply_patch)$/u],
  ['write', /^(write|write_file|create_file)$/u],
  ['edit', /^(edit|multiedit|str_replace|str_replace_editor|edit_file|replace)$/u],
  ['search', /^(grep|glob|search|find|ls|list_dir|codebase_search|web_search|websearch|webfetch|fetch)$/u],
];

export function toolKind(name: string): Kind {
  const key = name.toLocaleLowerCase();
  return KINDS.find(([, pattern]) => pattern.test(key))?.[0] ?? 'other';
}

function text(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value) return value;
    if (Array.isArray(value) && value.every((part) => typeof part === 'string')) return value.join(' ');
  }
  return '';
}

/** The argument worth showing on the one line: a path, a command, a pattern. */
function preview(call: ToolCall): string {
  const fromKeys = text(call.data, 'command', 'cmd', 'file_path', 'path', 'target_file', 'pattern', 'query', 'url', 'description');
  if (fromKeys) return fromKeys;
  const first = Object.values(call.data).find((value) => typeof value === 'string');
  return typeof first === 'string' ? first : '';
}

function lineCount(value: string): number {
  return value ? value.replace(/\n$/u, '').split('\n').length : 0;
}

/** The last thing a command printed, which is usually its verdict. */
function lastLine(value: string): string {
  const line = value.trim().split('\n').at(-1)?.trim() ?? '';
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

/**
 * One step: a dot for how it went, what was done, and the outcome on the
 * right. It opens onto what it produced, when it produced anything.
 */
function Step({ result, label, outcome, children, open }: {
  result: ToolResult | undefined;
  label: ReactNode;
  outcome?: string | undefined;
  children?: ReactNode;
  open?: boolean;
}) {
  const failed = result?.status === 'error';
  const dot = <span className={cn('dot', result ? (failed ? 'dot-danger' : 'dot-ok') : '')} aria-hidden="true" />;
  const end = outcome ? <em className={cn('step-outcome', failed ? 'is-failed' : result ? 'is-ok' : '')}>{outcome}</em> : null;
  const status = failed ? <span className="sr-only">failed</span> : null;
  if (!children) return <div className="step">{dot}<span className="step-label">{label}</span>{status}{end}</div>;
  return (
    <details className="tool-block step-block" open={open}>
      <summary className="step">{dot}<span className="step-label">{label}</span>{status}{end}<ChevronRight size={13} className="tool-chevron" aria-hidden="true" /></summary>
      <div className="tool-body">{children}</div>
    </details>
  );
}

/**
 * A tool call drawn by what it did, with its result folded in: a command as
 * "Ran …" with its last line, an edit as a diff, a read as the path and how
 * long the file was.
 */
export function ToolBlock({ call, result }: { call: ToolCall; result?: ToolResult | undefined }) {
  const kind = toolKind(call.name);
  const failed = result?.status === 'error';
  const output = result?.text ?? '';

  if (kind === 'shell') {
    const command = text(call.data, 'command', 'cmd') || preview(call);
    return (
      <Step result={result} label={<>Ran <code>{command}</code></>} outcome={failed ? lastLine(output) || 'failed' : lastLine(output)}>
        {output ? <CodeBlock code={output} copy={false} className="code-block code-flush terminal-block" /> : null}
      </Step>
    );
  }

  if (kind === 'edit' || kind === 'write') {
    const path = text(call.data, 'file_path', 'path', 'target_file') || call.name;
    const oldText = kind === 'write' ? '' : text(call.data, 'old_string', 'old_str', 'oldText');
    const newText = text(call.data, kind === 'write' ? 'content' : 'new_string', 'new_str', 'newText', 'contents');
    if (oldText || newText) {
      return (
        <div className="tool-edit">
          <DiffView path={path} oldText={oldText} newText={newText} />
          {failed ? <p className="tool-note text-danger">{output || 'The edit failed.'}</p> : null}
        </div>
      );
    }
  }

  if (kind === 'patch') {
    const patch = text(call.data, 'input', 'patch');
    return (
      <Step result={result} label={<>Patched {plural(lineCount(patch), 'line')}</>} outcome={failed ? 'failed' : undefined} open>
        <CodeBlock code={patch} language="diff" copy={false} className="code-block code-flush" />
      </Step>
    );
  }

  if (kind === 'read') {
    const path = preview(call);
    return (
      <Step result={result} label={<>Read <code>{path}</code></>} outcome={failed ? 'failed' : output ? plural(lineCount(output), 'line') : undefined}>
        {output ? <CodeBlock code={output} language={languageForPath(path)} copy={false} className="code-block code-flush" /> : null}
      </Step>
    );
  }

  const arg = preview(call);
  return (
    <Step result={result} label={<>{call.name}{arg ? <> <code>{arg}</code></> : null}</>} outcome={failed ? 'failed' : output ? plural(lineCount(output), 'line') : undefined}>
      <CodeBlock code={JSON.stringify(call.data, null, 2)} language="json" copy={false} className="code-block code-flush" />
      {output ? <pre className={cn('tool-output', failed && 'text-danger')}>{output}</pre> : null}
    </Step>
  );
}

/** A result whose call is not in the session, shown on its own. */
export function OrphanResult({ result }: { result: ToolResult }) {
  return (
    <Step result={result} label={result.status === 'error' ? 'Tool error' : 'Tool result'} outcome={plural(lineCount(result.text), 'line')}>
      <pre className={cn('tool-output', result.status === 'error' && 'text-danger')}>{result.text}</pre>
    </Step>
  );
}
