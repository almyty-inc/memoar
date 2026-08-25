import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bot,
  Box,
  Braces,
  Check,
  ChevronDown,
  Clock3,
  Code2,
  LibraryBig as Collection,
  Copy,
  Download,
  Eye,
  EyeOff,
  FileCode2,
  GitBranch,
  Laptop,
  Link2,
  MessageSquare,
  Network,
  Pin,
  RefreshCw,
  ScanSearch,
  Share2,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
  User,
  WandSparkles,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { memoarApi } from '../lib/api';
import type { Collection as CollectionRecord, ContentBlock, ConversionJob, Machine, PackResponse, SessionDetailData, ShareGrant } from '../lib/types';
import {
  Badge,
  Button,
  CopyButton,
  IconButton,
  Modal,
  RedactionBadge,
  SourceBadge,
  cn,
  formatDate,
  formatNumber,
  formatRelative,
} from '../components/ui';

export function SessionDetailView({ detail, collections, machines, onBack, onBuildPack, onConvert, onDeleted, onCollectionsChanged }: {
  detail: SessionDetailData;
  collections: CollectionRecord[];
  machines: Machine[];
  onBack: () => void;
  onBuildPack: (query: string, budget: number, freshness: 'strict' | 'mixed') => Promise<PackResponse>;
  onConvert: (target: ConversionJob['target']) => Promise<ConversionJob>;
  onDeleted: () => void;
  onCollectionsChanged: () => void;
}) {
  const [showThinking, setShowThinking] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [packOpen, setPackOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The review id, not just the fact of approval: the contract requires it to
  // create a link, so a link can only exist for an approved mask.
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [target, setTarget] = useState<ConversionJob['target']>('codex');
  const [pack, setPack] = useState<PackResponse | null>(null);
  const [packLoading, setPackLoading] = useState(false);
  const [conversion, setConversion] = useState<ConversionJob | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The pack controls drive the request. They were a readOnly number and a
  // disabled select, so the budget and freshness shown were never the ones used.
  const [packBudget, setPackBudget] = useState(4000);
  const [packFreshness, setPackFreshness] = useState<'strict' | 'mixed'>('mixed');
  const [machineId, setMachineId] = useState('');
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [pinId, setPinId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const session = detail.session;

  // Pins live as annotations, so the current state has to be read rather than
  // assumed: the button previously guessed from a field the server never set.
  useEffect(() => {
    let active = true;
    void memoarApi.listAnnotations(session.id)
      .then((page) => {
        if (active) setPinId(page.items.find((annotation) => annotation.kind === 'pin')?.id ?? null);
      })
      .catch(() => {
        // Absence of a pin is the safe default: showing "Pin session" for an
        // already-pinned session is recoverable, the reverse is confusing.
        if (active) setPinId(null);
      });
    return () => { active = false; };
  }, [session.id]);

  const togglePin = async () => {
    setBusyAction('pin');
    setActionError(null);
    try {
      if (pinId) {
        await memoarApi.deleteAnnotation(pinId);
        setPinId(null);
      } else {
        const created = await memoarApi.createAnnotation({ sessionId: session.id, kind: 'pin', value: {} });
        setPinId(created.id);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Pin could not be updated');
    } finally {
      setBusyAction(null);
    }
  };

  const exportSession = async () => {
    setBusyAction('export');
    setActionError(null);
    try {
      const exported = await memoarApi.exportSession(session.id);
      const url = URL.createObjectURL(new Blob([exported.body], { type: exported.contentType }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = exported.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Export failed');
    } finally {
      setBusyAction(null);
    }
  };

  const addToCollection = async (collectionId: string) => {
    setBusyAction('collection');
    setActionError(null);
    try {
      await memoarApi.addSessionToCollection(collectionId, session.id);
      setCollectionOpen(false);
      onCollectionsChanged();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Session could not be added');
    } finally {
      setBusyAction(null);
    }
  };

  const openPack = async () => {
    setPackOpen(true);
    setPackLoading(true);
    setActionError(null);
    try {
      setPack(await onBuildPack(session.title, packBudget, packFreshness));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Pack request failed');
    } finally {
      setPackLoading(false);
    }
  };

  const queueConversion = async () => {
    setActionError(null);
    try {
      setConversion(await onConvert(target));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Conversion request failed');
    }
  };

  const toolCalls = useMemo(() => detail.turns.flatMap((turn) => turn.blocks)
    .filter((block): block is Extract<ContentBlock, { kind: 'tool_call' }> => block.kind === 'tool_call').length, [detail.turns]);

  return (
    <div className="session-detail-page">
      <header className="session-header">
        <div className="session-title-row">
          <IconButton label="Back to timeline" onClick={onBack}><ArrowLeft size={18} /></IconButton>
          <div className="session-heading-copy">
            <div className="session-labels">
              <SourceBadge source={session.source} label={session.sourceLabel} />
              <RedactionBadge status={session.redactionStatus} />
              {session.pinned ? <Badge><Pin size={12} /> Pinned</Badge> : null}
            </div>
            <h1>{session.title}</h1>
            <div className="session-provenance-line">
              <span><GitBranch size={13} /> {session.workspace}</span>
              <span>{session.branch}</span>
              <span><Laptop size={13} /> {session.machine}</span>
              <span>Updated {formatRelative(session.updatedAt)}</span>
            </div>
          </div>
        </div>
        <div className="session-action-bar" aria-label="Session actions">
          <Button size="sm" onClick={() => setShareOpen(true)}><Share2 size={14} /> Share</Button>
          <Button size="sm" disabled={busyAction === 'export'} onClick={() => void exportSession()}>
            <Download size={14} /> {busyAction === 'export' ? 'Exporting…' : 'Export'}
          </Button>
          <Button size="sm" onClick={() => setConvertOpen(true)}><RefreshCw size={14} /> Convert</Button>
          <Button size="sm" variant="primary" onClick={() => void openPack()}><Braces size={14} /> Pack preview</Button>
        </div>
      </header>

      <div className="session-layout">
        <main className="conversation-column">
          <div className="conversation-toolbar">
            <div>
              <strong>{detail.turns.length} turns</strong>
              <span>{formatDate(session.createdAt)} · {session.durationMinutes} minutes</span>
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
                      <BlockView key={block.id} block={block} showThinking={showThinking} />
                    ))}
                  </div>
                  {turn.tokens ? <footer>{formatNumber(turn.tokens.input)} in · {formatNumber(turn.tokens.output)} out</footer> : null}
                </article>
              </li>
            ))}
          </ol>
        </main>

        <aside className="session-inspector" aria-label="Session details">
          <section className="inspector-card overview-card">
            <h2>Session overview</h2>
            <div className="metric-grid">
              <div><MessageSquare size={15} /><strong>{session.turnCount}</strong><span>turns</span></div>
              <TerminalSquare size={15} /><div><strong>{toolCalls}</strong><span>tool calls</span></div>
              <Clock3 size={15} /><div><strong>{session.durationMinutes}m</strong><span>duration</span></div>
              <WandSparkles size={15} /><div><strong>{formatNumber(session.tokenCount)}</strong><span>tokens</span></div>
            </div>
            <div className="token-bars">
              <div><span>Input</span><strong>{formatNumber(detail.tokenTotals.input)}</strong></div>
              <span className="token-bar"><span style={{ width: '62%' }} /></span>
              <div><span>Output</span><strong>{formatNumber(detail.tokenTotals.output)}</strong></div>
              <span className="token-bar output"><span style={{ width: '39%' }} /></span>
              <div><span>Cache read</span><strong>{formatNumber(detail.tokenTotals.cacheRead)}</strong></div>
            </div>
          </section>

          <section className="inspector-card">
            <h2>Provenance</h2>
            {detail.provenance.length === 0 ? (
              <p className="raw-note">No provenance recorded for this session.</p>
            ) : detail.provenance.map((item, index) => (
              // sourceId and parserVersion are optional in the canonical model,
              // so neither can be used as a key or rendered unguarded.
              <div className="provenance-item" key={`${item.kind}-${item.sourceId ?? index}`}>
                <span><Network size={15} /></span>
                <div>
                  <strong>{item.kind} capture</strong>
                  {item.sourceId ? <small>{item.sourceId}</small> : null}
                  {item.parserVersion ? <small>Parser {item.parserVersion}</small> : null}
                </div>
                <ShieldCheck size={15} className="success-icon" />
              </div>
            ))}
            <p className="raw-note"><Box size={14} /> Raw artifact preserved and content-addressed.</p>
          </section>

          <section className="inspector-card">
            <h2>Organization</h2>
            <div className="inspector-tags">{session.tags.map((tag) => <Badge key={tag}>#{tag}</Badge>)}</div>
            <Button size="sm" variant="ghost" disabled={collections.length === 0} onClick={() => setCollectionOpen(true)}>
              <Collection size={14} /> {collections.length === 0 ? 'No collections yet' : 'Add to collection'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busyAction === 'pin'} onClick={() => void togglePin()}>
              <Pin size={14} /> {pinId ? 'Unpin session' : 'Pin session'}
            </Button>
          </section>

          <Button className="delete-session-button" size="sm" variant="ghost" onClick={() => setDeleteOpen(true)}>
            <Trash2 size={14} /> Delete session
          </Button>
        </aside>
      </div>

      <ShareReviewModal
        open={shareOpen}
        approved={reviewId !== null}
        link={shareLink}
        busy={sharing}
        onApprove={() => {
          void memoarApi.completeRedactionReview(session.id)
            .then((review) => setReviewId(review.id))
            .catch(() => setActionError('Redaction review failed'));
        }}
        onCreate={(permission, expiresAt) => {
          if (!reviewId) return;
          setSharing(true);
          setActionError(null);
          void memoarApi.createShareLink({ sessionId: session.id, permission, redactionReviewId: reviewId, expiresAt })
            .then((grant) => {
              // Surface the link rather than closing: a token shown once and
              // discarded is a link the user cannot actually use.
              setShareLink(grant.token ? `${window.location.origin}/s/${grant.token}` : null);
            })
            .catch((error: unknown) => setActionError(error instanceof Error ? error.message : 'Share link could not be created'))
            .finally(() => setSharing(false));
        }}
        onClose={() => { setShareOpen(false); setReviewId(null); setShareLink(null); }}
      />

      <Modal
        open={convertOpen}
        title="Resume in another agent"
        description="Memoar maps the canonical session into the target agent and reports any degraded blocks."
        onClose={() => setConvertOpen(false)}
      >
        <div className="modal-body">
          <div className="target-grid" role="radiogroup" aria-label="Target agent">
            {([
              ['claude-code', 'Claude Code', 'claude -r'],
              ['codex', 'Codex', 'codex resume'],
              ['antigravity-cli', 'Antigravity', 'agy --conversation'],
            ] as const).map(([value, label, command]) => (
              <button key={value} type="button" role="radio" aria-checked={target === value} className={cn('target-option', target === value && 'active')} onClick={() => setTarget(value)}>
                <span><Code2 size={17} /></span><strong>{label}</strong><small>{command}</small>{target === value ? <Check size={15} /> : null}
              </button>
            ))}
          </div>
          {/*
            This listed "Atlas · MacBook Pro" and "Kepler · Linux workstation",
            neither of which exists. It shows the machines actually registered,
            and says so when there are none rather than offering invented ones.
          */}
          <label className="field-label">Materialize on
            {machines.length === 0 ? (
              <span className="field-empty">No machines connected yet</span>
            ) : (
              <select value={machineId || machines[0]?.id} onChange={(event) => setMachineId(event.target.value)}>
                {machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name} · {machine.platform}</option>)}
              </select>
            )}
          </label>
          <div className="conversion-note"><Sparkles size={16} /><p><strong>{conversion ? `Conversion ${conversion.status}` : 'Conversion report'}</strong><br />{conversion?.resumeCommand ?? 'Queue the canonical session to receive an exact resume command and mapping report.'}</p></div>
          {actionError ? <p role="alert">{actionError}</p> : null}
        </div>
        <footer className="modal-actions"><Button variant="ghost" onClick={() => setConvertOpen(false)}>Cancel</Button><Button variant="primary" onClick={() => void queueConversion()}>Queue conversion <ArrowRight size={14} /></Button></footer>
      </Modal>

      <Modal
        open={packOpen}
        title="Pack preview"
        description="A cited, extractive bundle that fits the chosen context budget."
        onClose={() => setPackOpen(false)}
      >
        <div className="modal-body pack-modal-body">
          <div className="budget-row">
            <label>Token budget<input type="number" value={packBudget} min={64} max={32000} onChange={(event) => setPackBudget(Number(event.target.value))} /></label>
            <label>Freshness
              <select value={packFreshness} onChange={(event) => setPackFreshness(event.target.value === 'strict' ? 'strict' : 'mixed')}>
                <option value="mixed">Mixed, flag stale</option>
                <option value="strict">Strict, fresh only</option>
              </select>
            </label>
            <Button size="sm" variant="ghost" disabled={packLoading} onClick={() => void openPack()}>Rebuild</Button>
          </div>
          {packLoading ? <p role="status">Building cited preview…</p> : null}
          {pack ? (
            <div className="pack-preview-card">
              <div><Badge>{pack.evidence.length} excerpts</Badge><span>Estimated {pack.tokenEstimate.toLocaleString()} tokens</span></div>
              <h3>{pack.query}</h3>
              <p>{pack.evidence[0]?.excerpt ?? 'No evidence matched this session title.'}</p>
              {pack.evidence[0] ? <small>[{pack.evidence[0].sessionId.slice(-8)} · turns {pack.evidence[0].turnStart}–{pack.evidence[0].turnEnd} · {pack.evidence[0].ageDays}d]</small> : null}
            </div>
          ) : null}
          {actionError ? <p role="alert">{actionError}</p> : null}
          {pack ? <div className="redaction-safe"><ShieldCheck size={15} /><span>Redaction status: {pack.redactionStatus}. {pack.staleCount} stale excerpts.</span></div> : null}
        </div>
        <footer className="modal-actions">{pack ? <CopyButton value={pack.markdown} label="Copy pack" /> : null}<Button variant="primary" disabled={!pack} onClick={() => { setPackOpen(false); setConvertOpen(true); }}>Send to agent <ArrowRight size={14} /></Button></footer>
      </Modal>

      <Modal open={collectionOpen} title="Add to collection" description="Collections group sessions for review and for packing evidence." onClose={() => setCollectionOpen(false)}>
        <div className="modal-body">
          <div className="collection-picker">
            {collections.map((collection) => (
              <button key={collection.id} type="button" className="collection-choice" disabled={busyAction === 'collection'} onClick={() => void addToCollection(collection.id)}>
                <strong>{collection.name}</strong>
                <small>{collection.sessionCount} sessions</small>
              </button>
            ))}
          </div>
          {actionError ? <p role="alert">{actionError}</p> : null}
        </div>
        <footer className="modal-actions"><Button variant="ghost" onClick={() => setCollectionOpen(false)}>Cancel</Button></footer>
      </Modal>

      <Modal open={deleteOpen} title="Delete this session?" description="Captured data and raw artifacts enter the configured 30-day recovery window." onClose={() => setDeleteOpen(false)}>
        <div className="modal-body warning-body"><AlertTriangle size={22} /><p>This removes the session from search, collections, share links, and agent memory. Existing exports are not recalled.</p></div>
        <footer className="modal-actions">
          <Button variant="ghost" onClick={() => setDeleteOpen(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={deleting}
            onClick={() => {
              setDeleting(true);
              setActionError(null);
              void memoarApi.deleteSession(session.id)
                .then(() => { setDeleteOpen(false); onDeleted(); })
                .catch((error: unknown) => setActionError(error instanceof Error ? error.message : 'Session could not be deleted'))
                .finally(() => setDeleting(false));
            }}
          >{deleting ? 'Deleting…' : 'Delete session'}</Button>
        </footer>
      </Modal>
    </div>
  );
}

function BlockView({ block, showThinking }: { block: ContentBlock; showThinking: boolean }) {
  if (block.kind === 'thinking') {
    if (!showThinking) return <button type="button" className="thinking-hidden"><EyeOff size={14} /> Thinking hidden · click “Show thinking” above</button>;
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
/** Turns the chosen expiry option into the timestamp the contract expects. */
function expiresAt(option: string): string | null {
  if (option === 'never') return null;
  const days = Number(option);
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function ShareReviewModal({ open, approved, link, busy, onApprove, onCreate, onClose }: {
  open: boolean;
  approved: boolean;
  link: string | null;
  busy: boolean;
  onApprove: () => void;
  onCreate: (permission: ShareGrant['permission'], expiresAt: string | null) => void;
  onClose: () => void;
}) {
  const [maskPath, setMaskPath] = useState(true);
  const [maskEmail, setMaskEmail] = useState(true);
  // These drive the request. They were uncontrolled inputs whose values were
  // read by nothing, so every choice offered here was discarded.
  const [permission, setPermission] = useState<ShareGrant['permission']>('viewer');
  const [expiry, setExpiry] = useState('7');
  return (
    <Modal
      open={open}
      title={approved ? 'Create share link' : 'Review what leaves your archive'}
      description={approved ? 'The reviewed redaction mask will be applied to every view and import.' : 'Visibility cannot widen until each finding has a decision.'}
      onClose={onClose}
    >
      {!approved ? (
        <>
          <div className="modal-body">
            <div className="review-summary"><ScanSearch size={20} /><div><strong>2 findings in 1 session</strong><p>Memoar found a local path and an email address.</p></div><Badge className="redaction-findings">Review required</Badge></div>
            <div className="finding-list">
              <label><input type="checkbox" checked={maskPath} onChange={(event) => setMaskPath(event.target.checked)} /><span><strong>Local workspace path</strong><code>{maskPath ? '/Users/[redacted]/workspace/memoar' : '/Users/demo/workspace/memoar'}</code></span><Badge>{maskPath ? 'Mask' : 'Keep'}</Badge></label>
              <label><input type="checkbox" checked={maskEmail} onChange={(event) => setMaskEmail(event.target.checked)} /><span><strong>Commit author email</strong><code>{maskEmail ? '[email redacted]' : 'developer@example.test'}</code></span><Badge>{maskEmail ? 'Mask' : 'Keep'}</Badge></label>
            </div>
            <div className="redaction-preview"><div><Eye size={14} /> Recipient preview</div><p>Workspace <mark>/Users/[redacted]/workspace/memoar</mark> · author <mark>[email redacted]</mark></p></div>
          </div>
          <footer className="modal-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" onClick={onApprove}><ShieldCheck size={15} /> Approve redactions</Button></footer>
        </>
      ) : (
        <>
          <div className="modal-body">
            <div className="permission-row">
              <label><input type="radio" name="permission" checked={permission === 'viewer'} onChange={() => setPermission('viewer')} /><span><strong>Viewer</strong><small>Read the redacted session</small></span></label>
              <label><input type="radio" name="permission" checked={permission === 'importer'} onChange={() => setPermission('importer')} /><span><strong>Importer</strong><small>Copy it into another archive</small></span></label>
            </div>
            <label className="field-label">Link expires
              <select value={expiry} onChange={(event) => setExpiry(event.target.value)}>
                <option value="7">In 7 days</option><option value="30">In 30 days</option><option value="never">Never</option>
              </select>
            </label>
            {/*
              Redactions are applied by the server for the life of the link, so
              this states a guarantee rather than offering a choice. It was a
              toggle wired to nothing, which read as an option to turn it off.
            */}
            <p className="redaction-safe"><ShieldCheck size={15} /><span>The reviewed redaction mask is applied for as long as this link is active.</span></p>
            {link ? <div className="share-link-result"><CopyButton value={link} label="Copy share link" /><code>{link}</code></div> : null}
          </div>
          <footer className="modal-actions">
            <Button variant="ghost" onClick={onClose}>{link ? 'Done' : 'Cancel'}</Button>
            {link ? null : (
              <Button variant="primary" disabled={busy} onClick={() => onCreate(permission, expiresAt(expiry))}>
                <Link2 size={15} /> {busy ? 'Creating…' : 'Create secure link'}
              </Button>
            )}
          </footer>
        </>
      )}
    </Modal>
  );
}
