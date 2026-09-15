import { Check, Copy, Search, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import type { RedactionStatus, SourceId } from '../lib/types';

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
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

const sourceClass: Record<SourceId, string> = {
  'claude-code': 'source-claude',
  codex: 'source-codex',
  'antigravity-cli': 'source-antigravity',
  cursor: 'source-cursor',
  goose: 'source-goose',
};

export function SourceBadge({ source, label }: { source: SourceId; label: string }) {
  return (
    <span className={cn('source-badge', sourceClass[source])}>
      <span className="source-mark" aria-hidden="true" />
      {label}
    </span>
  );
}

export function RedactionBadge({ status }: { status: RedactionStatus }) {
  const labels: Record<RedactionStatus, string> = {
    clear: 'Scan clear',
    findings: 'Needs review',
    reviewed: 'Reviewed',
  };
  return <Badge className={`redaction-${status}`}>{labels[status]}</Badge>;
}

export function StatusDot({ status }: { status: 'online' | 'offline' | 'never_connected' }) {
  return <span className={cn('status-dot', `status-${status}`)} aria-label={status.replace('_', ' ')} />;
}

export function SearchField({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className={cn('search-field', className)}>
      <Search size={16} aria-hidden="true" />
      <input type="search" {...props} />
      <kbd aria-hidden="true">⌘ K</kbd>
    </label>
  );
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
      {copied ? <Check size={14} /> : <Copy size={14} />}
      {copied ? 'Copied' : label}
    </Button>
  );
}

export function Modal({ open, title, description, children, onClose }: {
  open: boolean;
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <header>
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <IconButton label="Close dialog" onClick={onClose}><X size={18} /></IconButton>
        </header>
        {children}
      </section>
    </div>
  );
}

/**
 * Highlights each search term separately. Matching the whole query as one
 * phrase meant a multi-word search only highlighted when that exact phrase
 * appeared, which for real queries was almost never.
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

export function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <Search size={24} aria-hidden="true" />
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat('en', { notation: value > 9999 ? 'compact' : 'standard' }).format(value);
}

/**
 * How long ago, against the actual clock.
 *
 * This measured from `new Date('2026-08-17T16:20:00.000Z')` — a literal, frozen
 * in the source. Everything captured after that instant produced a negative
 * difference, which the `Math.max(1, …)` clamped to one, so every session,
 * machine and key in the archive reported "1m ago" for as long as the build
 * lived. A session from six days back sat under a date heading that said so and
 * a timestamp that said it had just happened.
 *
 * `now` is a parameter so tests can fix it without freezing it for everybody.
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
