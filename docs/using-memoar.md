# Using Memoar

What each screen is for, once there is something in the archive.

## The ideas

**Session** — one conversation with one coding agent, parsed into a shape that
is the same whichever tool wrote it: turns, and within them blocks (text,
thinking, tool call, tool result, diff, artifact). Branches are kept, so a
conversation that forked still reads as one.

**Raw artifact** — the bytes the tool wrote, stored unchanged and addressed by
their hash. Everything else is derived from it. This is why a parser fix can be
replayed over sessions captured months ago.

**Machine** — one computer with an agent signed in. Sessions carry the machine
they came from; a machine's token is scoped to capture, so losing a laptop means
revoking one credential rather than your account.

**Source** — one tool's native store on one machine (`~/.claude/projects`,
`~/.codex/sessions`, a Cursor `state.vscdb`). Enabled per machine.

## Screens

### Timeline — `/timeline`

Everything, newest first, grouped by day. Filter by source, workspace or time
range; the counts are the server's, not this page's. Older days load as you
reach them. Sessions have their own addresses, so any row can be linked.

### Search — `/search`

Hybrid retrieval across every agent and machine at once: lexical and semantic
results fused by reciprocal rank, so an exact string and a description of the
same thing both find it. Facets on the left narrow by source, workspace and
date. `⌘K` from anywhere.

**Pack preview** turns a result set into a budgeted, cited evidence pack — the
thing you hand to an agent instead of a whole transcript.

### A session — `/sessions/:id`

The transcript, with thinking hidden until asked for, tool calls and their
results collapsed, and diffs rendered as diffs. Beside it: turn and token
counts, the provenance hash, the parser version, and the machine it came from.

From here:

- **Share** — after a redaction review (below), mint a viewer or importer link.
- **Export** — the canonical session, or Markdown.
- **Convert** — write a native bundle for another agent.
- **Pack preview** — a cited pack scoped to this session.

### Collections — `/collections`

Group sessions around a project or a question, with notes that persist beside
them. A session can be in several.

### Agent memory — `/memory`

The standing instructions your agents read before they do anything —
`CLAUDE.md`, `AGENTS.md`, `.goosehints` and the rest — captured with their
revisions, so you can see what changed and when. Collected by the same sync.

### Machines & sources — `/machines`

Which machines are reporting, what each has discovered, when it last synced, and
how many sessions came from it. Sources can be switched off per machine.

### Sharing — `/sharing`

Every link you have minted, its permission and expiry, and any transfers.
Revoking blocks future access; copies already imported keep their provenance.

### Import — `/import`

One archive file at a time, for machines you no longer have and for exports.
Same raw-first path as the agent.

### Settings — `/settings`

- **API keys & MCP** — keys for the CLI and automation, and the remote MCP
  endpoint with ready-made commands for Claude Code and Codex. Secrets are shown
  once; the archive stores a salted hash and the visible prefix.
- **Redaction** — the rules applied when preparing a session to leave the
  archive.
- **Retention** — how long raw artifacts are kept.
- **Distillation** — summarisation settings.

## Things worth knowing

### Sharing is gated on a review

A session cannot leave the archive until a redaction review is complete. The
review shows every finding and the exact text that will be visible, side by
side, and you approve or reject each one. Sharing changes visibility;
conversion changes representation; neither changes the captured session.

### Converting to another agent

Memoar writes native bundles for Claude Code, Codex and Antigravity CLI. The
conversion report lists every exact mapping, every degraded block and anything
unavailable — it does not claim a fidelity it did not achieve.

The bundle is materialized on your machine by the agent:

```sh
memoar listen            # subscribe to this machine's command channel
```

Each command is acknowledged only after its bundle is written, so an interrupted
materialization is replayed rather than lost. When a target is too brittle to
resume natively, Memoar produces an injection prelude from a cited pack instead,
and says so.

### Reading the archive from an agent

The MCP endpoint gives an agent search, excerpt and pack tools over your
archive, in that order — retrieval discipline is built into the tool surface, so
an agent works from citations rather than pulling whole sessions. Setup commands
are in **Settings → API keys & MCP**; the details are in [mcp.md](mcp.md).

## What is missing

Stated plainly, because finding out later is worse:

- **No password reset.** Forget your password and there is no way back into that
  account.
- **No hosted service.** You run the archive yourself.
