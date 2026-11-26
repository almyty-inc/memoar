import { Check, Copy } from 'lucide-react';
import {
  useId,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import type { RedactionStatus } from '../lib/types';

export { Modal } from './Modal';

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

/** "1 turn", "2 turns". The plural is the singular plus s unless given. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('en')} ${count === 1 ? singular : pluralForm}`;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}

export function Button({ className, variant = 'secondary', size = 'md', ...props }: ButtonProps) {
  return (
    <button
      className={cn('button', `button-${variant}`, size === 'sm' && 'button-sm', className)}
      type={props.type ?? 'button'}
      {...props}
    />
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
}

export function IconButton({ label, className, ...props }: IconButtonProps) {
  return (
    <button className={cn('icon-button', className)} type="button" aria-label={label} title={label} {...props} />
  );
}

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('badge', className)} {...props} />;
}

/**
 * What the secret scan found, in words a reader can act on. "Needs review"
 * said something was wrong and not what, so the label names the finding and
 * the title says what follows from it.
 */
const REDACTION: Record<RedactionStatus, { label: string; title: string; tone?: string }> = {
  clear: { label: 'Scan clear', title: 'The secret scan matched nothing.' },
  findings: {
    label: 'Possible secrets',
    title: 'The secret scan matched something. It is masked in anything you share, and you confirm the mask before sharing.',
    tone: 'text-warning',
  },
  reviewed: { label: 'Mask reviewed', title: 'Someone confirmed the redaction mask.' },
};

export function RedactionBadge({ status }: { status: RedactionStatus }) {
  const entry = REDACTION[status];
  return <Badge className={entry.tone} title={entry.title}>{entry.label}</Badge>;
}

export function redactionSentence(status: RedactionStatus): string {
  return REDACTION[status].title;
}

const MACHINE_DOT: Record<'online' | 'offline' | 'never_connected', string> = {
  online: 'dot-ok',
  offline: 'dot-warning',
  never_connected: '',
};

export function StatusDot({ status }: { status: 'online' | 'offline' | 'never_connected' }) {
  return <span className={cn('dot', MACHINE_DOT[status])} aria-hidden="true" />;
}

export function Toggle({ checked, onChange, label, hint }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}) {
  const id = useId();
  return (
    <div className="toggle-row">
      <label htmlFor={id}>
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        className={cn('switch', checked && 'switch-on')}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const node = document.createElement('textarea');
      node.value = value;
      document.body.appendChild(node);
      node.select();
      document.execCommand('copy');
      node.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <Button size="sm" variant="ghost" onClick={() => void copy()} aria-label={`${label}: ${value}`}>
      {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

/**
 * Highlights each search term separately. Matching the whole query as one
 * phrase only highlighted when that exact phrase appeared.
 */
export function HighlightText({ text, query }: { text: string; query: string }) {
  const terms = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])]
    .filter((term) => term.length > 1)
    .sort((left, right) => right.length - left.length);
  if (terms.length === 0) return <>{text}</>;
  const pattern = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const segments = text.split(new RegExp(`(${pattern})`, 'giu'));
  const matches = new Set(terms);
  return (
    <>
      {segments.map((segment, index) =>
        matches.has(segment.toLocaleLowerCase())
          ? <mark key={`${segment}-${index}`}>{segment}</mark>
          : segment,
      )}
    </>
  );
}

/** One sentence saying what to do, and maybe the control that does it. */
export function EmptyState({ title, body, action }: { title: string; body?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <p><strong>{title}</strong>{body ? <> {body}</> : null}</p>
      {action}
    </div>
  );
}

/** A page's one heading line: title, an inline count, and its actions. */
export function PageHeader({ title, count, children }: { title: string; count?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-header">
      <h1>{title}</h1>
      {count === undefined || count === null ? null : <span className="page-count">{count}</span>}
      {children ? <div className="page-actions">{children}</div> : null}
    </header>
  );
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en', { notation: value > 9999 ? 'compact' : 'standard' }).format(value);
}

/**
 * How long ago, against the actual clock. `now` is a parameter so tests can
 * fix it without freezing it for everybody.
 */
export function formatRelative(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'Never';
  const at = new Date(iso).getTime();
  if (!Number.isFinite(at)) return 'Unknown';
  const difference = now - at;
  // A clock a little ahead of ours is not six decades of history.
  if (difference < 60_000) return 'just now';
  const minutes = Math.round(difference / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso);
}

export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
}

/** The clock time, for rows already grouped under their day. */
export function formatTime(iso: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.valueOf())) return '';
  return new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}
