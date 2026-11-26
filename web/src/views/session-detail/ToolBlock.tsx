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

/** One line that opens to show more. The line says what happened. */
function Disclosure({ className, summary, children, open }: { className?: string; summary: ReactNode; children: ReactNode; open?: boolean }) {
  return (
    <details className={cn('tool-block', className)} open={open}>
      <summary><ChevronRight size={12} className="tool-chevron" aria-hidden="true" />{summary}</summary>
      <div className="tool-body">{children}</div>
    </details>
  );
}

/**
 * A tool call rendered by what it did, with its result folded in. A shell
 * command shows as a terminal, an edit as a diff, a file read as one line
 * with the path and how long the file was.
 */
export function ToolBlock({ call, result }: { call: ToolCall; result?: ToolResult | undefined }) {
  const kind = toolKind(call.name);
  const failed = result?.status === 'error';
  const output = result?.text ?? '';
  const status = failed ? <span className="tool-failed">failed</span> : null;

  if (kind === 'shell') {
    const command = text(call.data, 'command', 'cmd') || preview(call);
    return (
      <div className={cn('terminal-block', failed && 'terminal-failed')}>
        <div className="terminal-command"><span className="terminal-prompt" aria-hidden="true">$</span><code>{command}</code>{status}</div>
        {output ? (
          lineCount(output) > 14 ? (
            <details className="terminal-more">
              <summary>{plural(lineCount(output), 'line')} of output</summary>
              <pre>{output}</pre>
            </details>
          ) : <pre>{output}</pre>
        ) : null}
      </div>
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
      <Disclosure open summary={<><span className="tool-name">Patch</span><span className="tool-arg">{plural(lineCount(patch), 'line')}</span>{status}</>}>
        <CodeBlock code={patch} language="diff" copy={false} className="code-block code-flush" />
      </Disclosure>
    );
  }

  if (kind === 'read') {
    const path = preview(call);
    return (
      <Disclosure className="tool-quiet" summary={<><span className="tool-name">Read</span><span className="tool-arg">{path}</span>{output ? <span className="tool-meta">{plural(lineCount(output), 'line')}</span> : null}{status}</>}>
        {output ? <CodeBlock code={output} language={languageForPath(path)} copy={false} className="code-block code-flush" /> : <p className="tool-note">No output recorded.</p>}
      </Disclosure>
    );
  }

  return (
    <Disclosure className={cn(kind === 'search' && 'tool-quiet')} summary={<><span className="tool-name">{call.name}</span><span className="tool-arg">{preview(call)}</span>{output ? <span className="tool-meta">{plural(lineCount(output), 'line')}</span> : null}{status}</>}>
      <CodeBlock code={JSON.stringify(call.data, null, 2)} language="json" copy={false} className="code-block code-flush" />
      {output ? <pre className={cn('tool-output', failed && 'text-danger')}>{output}</pre> : null}
    </Disclosure>
  );
}

/** A result whose call is not in the session, shown on its own. */
export function OrphanResult({ result }: { result: ToolResult }) {
  return (
    <Disclosure className="tool-quiet" summary={<><span className="tool-name">{result.status === 'error' ? 'Tool error' : 'Tool result'}</span><span className="tool-meta">{plural(lineCount(result.text), 'line')}</span></>}>
      <pre className={cn('tool-output', result.status === 'error' && 'text-danger')}>{result.text}</pre>
    </Disclosure>
  );
}
