# Where these fixtures came from

A fixture written by whoever wrote the parser proves that the parser agrees with
its author. It does not prove the parser can read what the tool writes, and the
difference is not academic — it has cost this project real transcripts three
times.

The clearest case: opencode numbers its messages `msg_00f6cbeba001oL9mtU4uPS9zzM`
and its parts `prt_…`. The fixture here used uuids, because the person who wrote
the fixture also wrote the parser and assumed uuids. Turn and block ids are a
uuid column, so **every real opencode session would have been accepted, parsed
correctly, and then refused by the database** — and no test in this repository
could have caught it, because every fixture agreed with the assumption.

So each fixture records what it actually is. "Verified" and "not checked" must
never look the same.

## Verified against real data

These parsers have been run against the store the tool itself wrote, on a
machine where the tool is used. Re-run it yourself:

```sh
npm run build --workspace @memoar/server
node scripts/verify-parsers-locally.mjs
```

It reads the live stores, never copies them, prints only counts, and fails if
any identifier it produced could not be stored.

That script still grades itself, though — the same hand wrote the parsers, the
fixtures and the checks, so it verifies what its author thought to check.
`scripts/parser-coverage.mjs` asks a question its author does not get to define:
it pulls the long text strings out of the tool's own store without going through
any memoar code, and reports what fraction survives into the archived session.

It found a real one. opencode keeps a command and its output in the same part,
and only the command was being kept — every `ls`, every test run, every diff an
agent read was dropped. Coverage went from 66% to 97% once results were
archived, and `native-store-parsers.test.ts` now holds that in CI.

Read the number as a floor with known noise rather than a score. It counts
strings the archive is not meant to hold — a tool's own instruction files, the
system prompt, whole rows of the storage format — so a low figure is a prompt to
look, not a verdict.

| Source | Store it was read from | Last checked |
| --- | --- | --- |
| `claude-code` | `~/.claude/projects/**/*.jsonl` | 2026-09-08 |
| `codex` | `~/.codex/sessions/**/rollout-*.jsonl` and `rollout-*.jsonl.zst` | 2026-11-26 |
| `antigravity-cli` | `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl` | 2026-11-26 |
| `crush` | `<project>/.crush/crush.db` | 2026-09-08 |
| `opencode` | `~/.local/share/opencode/opencode.db`, v1 and v2 tables | 2026-11-26 |
| `zed` | `~/Library/Application Support/Zed/threads/threads.db` | 2026-09-17 |

Verifying the parser was not enough for `antigravity-cli`. The check above names
the version itself, and the capture agent never does: it sends the bare tool
name, and the server's detector recognised Antigravity by a `"parts"` field the
CLI has never written. All 655 transcripts on dev were refused as
`antigravity-cli@unknown` for as long as both checks passed. On 2026-11-25 the
same 655 transcripts on this machine went through detection with the bare name
and then the parser, and all 655 parsed: 514 are a single `USER_INPUT` step,
which is kept as a one-turn session, and the 343 `GENERIC` steps holding tool
output are now read as tool results. `server/test/format-detection.test.ts` puts
every fixture through that same path.

Ten `codex` rollouts on dev were refused too, and they are two cases. Eight,
captured 2026-09-17 and up to 48 MB, hold `session_meta` and thousands of
`response_item` lines, but 1 to 22 lines each were broken by the capture agent's
redaction before commit 57fc824 and the parser read all-or-nothing. It reads
line by line now and all eight parse. The other two are guardian subagent
threads holding `session_meta`, one `compaction` item that is only
`encrypted_content`, and a settings event. They contain nothing readable and
stay refused, correctly.

### Storage drift, checked 2026-11-26

Four tools changed where or how they write since their patterns were written.
Each was checked on one macOS machine with `scripts/verify-store-sweep.mjs`,
which puts every file of a store through format detection with the bare tool
name and then the parser, and prints counts only.

- **Codex** compresses cold rollouts to `rollout-*.jsonl.zst`
  (`codex-rs/rollout/src/compression.rs`) and capture named only `.jsonl`.
  3,882 rollouts: 477 plain, 3,405 compressed, none of which had been
  captured. All 3,882 decompress. 3,868 parse into 31,371 turns, 13 are
  `empty` (guardian threads with nothing readable), 1 is a 269 MB plaintext
  past the archive's 256 MB ceiling that the agent skips as too large, and 0
  are `unknown`. The agent's decoder (`ruzstd`) and Node's zstd produced the
  same 1,165,171,977 bytes and the same digest over all 3,405. Every one of
  the 4,052 assistant turns carries its model from `turn_context`.
- **Antigravity** writes `conversations/<id>.db` beside the transcript. All
  655 conversations have both, the newest included, so transcripts were not
  dropped. Every transcript step is a `steps` row at the same index. The 559
  rows only the database holds are 519 model errors (HTTP 429 details) and 40
  cancelled tool calls. The database is protobuf with no published schema and
  is not captured. All 655 transcripts parse, 952 turns.
- **OpenCode** is mid-migration to `session_v2`/`session_message`/
  `session_part`. Here the one session is in both generations, 47 messages are
  in both, and one system message is only in `session_message`. The parser
  now reads v1 and takes from v2 every message v1 lacks: 48 turns, every
  assistant turn with its model. `parser-coverage.mjs` reports 24% for this
  store now. That is the whole-row JSON of the new tables, which the archive
  never holds as one string. Field by field, every string of 60 characters or
  more in `message`, `part` and `session_message` is in the parsed session.
- **Copilot**: VS Code's chat log replays as VS Code reads it
  (`objectMutationLog.ts`): `kind` 0 replaces the state, 1 sets, 2 appends to
  or truncates an array, 3 deletes. The parser used to drop `kind` 2, which is
  how every new request is written, so the question this file asked below is
  answered from VS Code's source. Panels opened with no folder are under
  `globalStorage/emptyWindowChatSessions/` and are captured now. The 24 files
  here (18 `.jsonl`, 5 `.json`, 1 empty-window) are all unused panels and
  read as `empty`. The CLI's `session-state/<id>/events.jsonl` is captured and
  parsed from the Copilot SDK's published event schema
  (`nodejs/src/generated/session-events.ts`). **Not verified**: this machine
  has no `events.jsonl`.
- **Kilo Code** moved to `~/.local/share/kilo/kilo.db`, opencode's schema
  (`packages/core/src/database/database.ts`), read by the opencode parser.
  **Not verified**: Kilo is not installed here.
- **Cursor 3.x**: each bubble's own `createdAt` and `modelInfo.modelName`, and
  titles from `composer.composerHeaders`, follow `getagentseal/codeburn`, which
  is run against real stores. **Not verified**: Cursor is not installed here.

Windows paths were corrected from the tools' code: opencode and Kilo use XDG
data under the home directory on every platform, so `AppData/Roaming/opencode`
was never written, and Zed's data directory on Windows is `AppData/Local/Zed`.

Not captured, and why: Codex's `state_5.sqlite` `threads` table and
`session_index.jsonl` hold thread titles (78 entries here). The rollout does
not carry a title, so Codex sessions are still titled generically. Joining
them would need a second artifact per session and is left for later.

`copilot` is deliberately not in that table, and it is the one source where the
two halves of "verified" have to be said separately, because it has two stores.

Its CLI half opens the real `~/.copilot/session-store.db` on this machine and
reads the one session row there, but the `turns` table is empty — `select
count(*) from turns` returns 0 — so nothing about *that* turn mapping has been
checked. The script prints it as `empty` rather than `ok` for the same reason
this file exists.

Its VS Code half — the `chatSessions` envelope, `{version, requests[],
sessionId, creationDate}` — has been run against real populated sessions, and
not against a fixture. The awkward part, said plainly because the distinction is
the whole point of this file: **the populated envelopes did not come out of a
`chatSessions` file.** Every one of the 23 files under `chatSessions` on this
machine is a panel opened and never used, `requests: []`, so those files can
show the envelope and cannot show what a turn maps to.

What could show it is the same envelope in its older home. VS Code kept these
session objects in the `interactive.sessions` memento inside
`workspaceStorage/*/state.vscdb` before it moved them into one file per panel,
and five of those on this machine still hold conversations. Their key set is the
same one the empty files carry — `version, requesterUsername,
requesterAvatarIconUri, responderUsername, responderAvatarIconUri,
initialLocation, requests, sessionId, creationDate, isImported, lastMessageDate`
and `customTitle` where the panel was renamed — and four of the six sessions are
`version: 3`, which is the version every file on disk declares. So the parser
reads a bare array of envelopes as well as the two file layouts, and running it
over those mementos parsed:

| Envelope version | Sessions | Turns | Blocks | Characters kept |
| --- | --- | --- | --- | --- |
| `3` | 4 | 30 | text 52, tool_call 3, diff 14 | 326,730 |
| pre-`version` | 2 | 6 | text 6 | 3,307 |

with the user/assistant alternation, the parent chain and the ordinals correct
in all six, no duplicate ids, and `customTitle` taken as the title where there
was one. That exercised every block kind the branch mints: `textEditGroup` into
`diff`, `toolInvocationSerialized` into `tool_call`, `MarkdownString` into
`text`. Asked the `parser-coverage.mjs` question — what fraction of strings 60
characters or longer in the raw `requests[]` is findable in the parsed session —
it keeps **1,888 of 2,049, 92%**. What it drops is the panel's furniture rather
than the conversation: the extension's own `agent.metadata.helpText*` boilerplate,
`workingSet` and `contentReferences` file URIs, `variableData`, and the
`followups` the UI offers as next prompts.

So: the envelope, the request-to-turn mapping and the part kinds are verified
against real Copilot Chat content. **What is not verified is the file**: no
populated `chatSessions/*.json` or `*.jsonl` has been read, because this machine
has none. Anyone who has one should run the parser over it and say whether the
per-file layouts carry anything the memento did not — in particular whether a
`.jsonl` ever writes `requests` through a `kind:1` record rather than in its
`kind:0` snapshot, which is the one thing about that layout still guessed at.

## What capture points at

A parser verified against the right store proves nothing if discovery hands it
a different file, and four times it did. Each was confirmed against the real
directory on a machine that runs the tool, and each now has a test naming both
the file to take and the file to leave — fixing one end without the other just
moves the mistake.

| Source | What it collected | What it should have |
| --- | --- | --- |
| `zed` | `db/<channel>/db.sqlite`, the editor's panes, terminals and breakpoints — no `threads` table, so not one conversation in however long the pattern stood | `threads/threads.db` |
| `opencode` | `storage/**` JSON, which is configuration: a config file uploaded on every sync, refused every time | `opencode.db` |
| `claude-code` | `claude-code-sessions/*/*/local_*.json` and its local-agent-mode twin. 22 files matched on one machine and not one held a message, a `parentUuid` or a transcript. They are the desktop app's settings — model, permission mode, allowed egress, the rendered system prompt, `accountName` and `emailAddress` — so each sync uploaded an email address for an artifact that could only come back `unknown_format` | nothing: the conversation is the CLI transcript those files name in `cliSessionId`, which `.claude/projects/*/*.jsonl` already takes |
| `antigravity-cli` | `brain/*/conversations/*.db` and `brain/*/*.md`. The first names a directory that does not exist — the conversation databases are one level above `brain/` — and the parser has no SQLite branch at all, only a diagnostic claiming one. The second is markdown, which is not JSONL | the transcript log, which is all the parser reads |
| `claude-code` | `.claude/history.jsonl`, which is the prompt history the CLI's up-arrow reads, not a conversation: 10,619 lines on this machine, every one valid JSON, every one `{display, pastedContents, timestamp, project, sessionId}`, not one carrying `uuid` or `message`. Named `.jsonl`, so the agreement check — which compares extensions — never saw it, and 2.8 MB of every prompt ever typed went up on every sync and came back `unknown_format` | nothing: the conversation it indexes is the transcript named by its own `sessionId`, which `.claude/projects/*/*.jsonl` already takes |
| `copilot` | VS Code `chatSessions/*.json` and nothing else, on all three platforms. VS Code has written that envelope under two extensions: `<id>.json` is one whole envelope, and `<id>.jsonl` is a `{kind:0, v:<envelope>}` snapshot followed by `{kind:1, k:[path], v:value}` writes against it, which is what it writes now. Of the 23 files under `chatSessions` on this machine, **18 are `.jsonl` and 5 are `.json`, and every `.jsonl` is newer than every `.json`** — the `.json` panels were created between 2025-05-02 and 2025-12-12, the `.jsonl` ones between 2026-02-20 and 2026-06-29, with no overlap. So the pattern named the layout the editor has stopped writing, and would have collected less of Copilot Chat every month | both, which is what it names now |
| `copilot` | the four `.copilot/{session-state,history-session-state}/**.json` patterns. Checked against GitHub Copilot CLI 1.0.59 with a recorded session: `session-state/<id>/` holds `workspace.yaml`, `checkpoints/index.md` and two empty directories, with no `.json` at any depth, and `history-session-state/` does not exist. The only JSON under `~/.copilot` is `config.json` and `command-history-state.json`, which are settings and which those patterns never named | `session-store.db`, which is what the parser opens |
| `claude-code` | Before commit 31897b4 a pattern's fixed prefix was walked and the pattern never applied, and the Claude Desktop entries were bare directories. The first real sync, 2026-09-17 15:29 to 16:32 UTC, left 1,354 `unknown_format` artifacts on dev: 516 markdown files, 13 `.audit-key`, 13 `.claude/.claude.json` and 3 of its backups, `.git/index`, `.git/logs/HEAD` and `.git/packed-refs` from a plugin marketplace checkout, 14 `.DS_Store`, task lists, debug logs, and the PDFs, images and `node_modules` a session wrote into `outputs/` | only transcripts, and a deny list after every pattern that refuses key files, credential stores, `.git` and its peers, and `.DS_Store` whatever a pattern says |
| `kilo`, `roo` | `tasks/*/*.json`, which also took `ui_messages.json` and `task_metadata.json` from each task directory. The parser reads one file, `api_conversation_history.json` | `tasks/*/api_conversation_history.json` |

Claude Desktop's local agent mode does keep transcripts on this side of its VM,
which the `claude-code` row above once said it did not. Each session has its
own Claude Code home at `local_<session>/.claude`, and its
`projects/<project>/*.jsonl` and `subagents/*.jsonl` are the JSONL the CLI
writes, `parentUuid` and all. On the machine checked on 2026-11-25 that was 22
sessions and 27 subagent transcripts, one of them under `agent/local_ditto_*`,
and all 49 parsed through format detection and the Claude Code parser. Capture
names those depths and nothing else in the tree. `audit.jsonl` beside them is
an HMAC-signed stream of the same conversation and is left out, because taking
it would archive every session twice.

`claude-code/v1/subagent-1` is synthetic and holds no captured text. Its shape
was checked against the real store on 2026-11-25, reading only key names and
counts: all 614 files under `~/.claude/projects/*/*/subagents/` carry the
parent's `sessionId`, `isSidechain: true` and an `agentId` on every line, the
`agentId` matches the file name, and no two subagents of one parent share it.
Before parser `claude-code:v1:0.4.0` that `sessionId` filed every subagent under
its parent's session, and on dev the file parsed last replaced the turns of the
others. The fixture pins the identity they get instead.

`claude-code` had also stopped taking the subagent transcripts. They are
written a directory below the session that spawned them — and some two further
down, under `subagents/workflows/<id>/` — so `projects/*/*.jsonl` reached none
of them: 233 files on this machine carrying 58,467 lines with both `uuid` and
`message`, against 15 top-level transcripts. Each depth is named now, and only
`.jsonl` at that depth: `subagents/*.meta.json` and `tool-results/**` sit beside
them and are not transcripts.

The mismatch that made all four possible — a pattern naming a file shape the
parser refuses — is now a build failure. `scripts/check-capture-parser-agreement.mjs`
reads the Rust connector table and the parsers' own guards and compares the
extension a pattern names against the bytes the parser will accept. It runs in
`npm test`.

It also fills every wildcard of every pattern with sample key, credential and
version-control names (`.audit-key`, `.claude.json`, `.git/…`, `*.pem` and
more, listed in `scripts/capture-deny-check.mjs`) and fails if the deny list in
`agent/crates/memoar-connectors/src/deny.rs` would let the result through, or if
a pattern uses `**`.

It cannot tell a transcript from a settings file: `local_*.json` and a real
JSONL transcript are both "JSON-ish" to a machine, and only a person looking at
the store can say which holds a conversation. What it does catch is the cheaper
half — bytes collected today that can only ever be refused.

A mismatch is not deleted to make it pass. Keeping unparseable bytes is
deliberate, so a parser written later can still read them; so each open one is
declared in that script with what would settle it, and the check fails both when
an undeclared mismatch appears and when a declaration outlives its defect.

One is open, waiting on somebody who runs the tool.

Two came off the list. The four `.copilot/**.json` patterns went when the CLI
was installed and asked; they are in the table above, with what was found in the
directory they named. The VS Code `chatSessions/*.json` patterns went the other
way a declaration can be settled — the parser grew the branch rather than the
pattern being dropped, which was the right half to move, because there is no
SQLite equivalent for VS Code Copilot Chat and dropping the pattern would have
destroyed the only bytes those conversations exist in. `copilot-chat.ts` reads
the envelope now, `*.jsonl` was added beside `*.json` because VS Code had
changed layout under the old pattern, and what is and is not verified about that
branch is set out under "Verified against real data" above.

| Source | Pattern | Parser accepts | Why it is still there |
| --- | --- | --- | --- |
| `goose` | `sessions/*.jsonl`, common and Windows | native SQLite only | The source calls itself "SQLite or legacy JSONL" and the parser implements only the SQLite half. Whether anything still writes `.jsonl` — and if so what shape it is — is a question for a machine with goose on it; nothing here can answer it. Asked again on 2026-09-23: `goose` is not on `PATH`, and `~/.local/share/goose`, `~/.config/goose` and `~/Library/Application Support/Block` all do not exist, so there is no store to look in and nothing to read the shape off. Guessing the record shape from block/goose's source would produce a parser whose only evidence is a fixture written to agree with it, which is the defect this file opens with. |

`kilo` and `roo` were never on that list, because `tasks/*/*.json` and a parser
that reads JSON agree about shape. They disagreed about which JSON, and the
pattern now names `api_conversation_history.json`, the file name Roo Code's own
source gives that history. Nobody here runs either tool, so that name is
checked against the source and not against a store.

## Written from the format, not from a capture

Nobody here has run these tools and fed memoar what came out. The fixtures were
written from the tool's storage format as understood at the time, which is
exactly the position that produced the opencode defect. Treat a green test on
these as evidence that nothing has regressed, not as evidence that the parser
works.

`verify-parsers-locally.mjs` now carries an entry for each of these too, so
they print as `skipped` with the task beside them instead of not appearing at
all. A source absent from that script looked verified by being absent, which is
the failure this whole file exists to prevent.

| Source | What it would take to verify |
| --- | --- |
| `cursor` | Install Cursor, hold one conversation with the agent, quit Cursor so it flushes `state.vscdb`, run the script. The parser reads `composerData:` rows for the order and `bubbleId:` rows for the content, both in `cursorDiskKV`; a green line with turns means both halves were found. |
| `copilot` | Two stores, two answers. **CLI:** `~/.copilot/session-store.db` on this machine has the exact `sessions` and `turns` schema the parser selects, and the parser opens it — but `turns` is empty, so the script prints `empty` and only the session row is verified. Install GitHub Copilot CLI, hold a conversation that records exchanges, re-run. **VS Code:** the `chatSessions` envelope is read and its mapping is verified against six real populated sessions, but none of those came out of a `chatSessions` file — every file here is an unused panel. Open Copilot Chat in VS Code, hold one conversation, close the window so the panel flushes, and run the parser over the file it wrote: it confirms the file layouts carry what the memento did, and it is the only thing that can show whether a `.jsonl` ever writes `requests` through a `kind:1` record instead of its `kind:0` snapshot. |
| `goose` | `brew install block-goose-cli`, one session, run the script. While there, list `~/.local/share/goose/sessions`: if anything still writes `.jsonl`, the parser needs a branch; if nothing does, the pattern goes. Still nothing here to ask, re-checked 2026-09-23: `goose` is not on the path, and `~/.local/share/goose`, `~/.config/goose` and `~/Library/Application Support/Block` do not exist. Do not re-check by hand — this is the answer until somebody installs it. |
| `kilo` | Kilo Code now writes `~/.local/share/kilo/kilo.db`: run one task with the CLI or the current extension and run `verify-store-sweep.mjs`, which reads every `kilo*.db`. For the older extension: VS Code with Kilo Code, one task, run the script. Also list one `tasks/<id>` directory and say which files are in it: the parser reads `api_conversation_history.json`, the pattern takes every `*.json` beside it, and `ui_messages.json` is a different shape that may parse into nonsense rather than be refused. |
| `roo` | VS Code with Roo Code, one task. Same directory listing as Kilo; they share the format and the question. |
| `chatgpt-export` | A genuine ChatGPT data export — no software to install, just the export ChatGPT emails you. Not in the script: it arrives as an upload, not as a store on disk. |
| `cass-export` | Unknown: nobody here has seen a real one. |

## Defined by us

| Source | Why an author-written fixture is legitimate |
| --- | --- |
| `canonical-bundle` | Memoar's own export format. The fixture and the writer are supposed to agree, and a round-trip test is the real check. It is also the one parser that must *refuse* an unstorable id rather than deriving one, because re-importing a bundle is supposed to preserve identity — deriving would silently renumber an archive being moved between deployments. |

## Rich fixtures (`rich-1`)

Each source that reads a tool's own store has a `rich-1` fixture holding every
content shape the dev archive lost: tool results as a string and as an array
with an image, error flags, thinking with its signature, redacted and encrypted
reasoning, images and documents, and the system, compaction and summary records
around them. The inputs are synthetic, written by
`contracts/scripts/rich-transcripts.mjs` and `rich-stores.mjs`. Their shapes
were taken from real stores on this machine by key name and count only, never
by content, for Claude Code (300 transcripts), Codex (472 rollouts) and
Antigravity (655 transcripts). The others follow each tool's source and are as
verified as the table above says that source is.

Their expected output is what the parser produces, so it records behaviour and
is not an oracle. The oracle is `server/test/parser-fidelity.test.ts`: every
string of 16 characters or more in every fixture's input must reach the parsed
session, unless that source declares the drop and why.

## When a tool changes its format

The fixtures do not notice. Nothing here polls upstream, and a tool that changes
its storage between releases will simply stop being captured — the artifact is
kept with an `unknown_format` diagnostic and the raw bytes are preserved, so
nothing is lost, but nobody is told either. Re-running the verification script
on a machine that uses these tools is currently the only thing that would catch
it.
