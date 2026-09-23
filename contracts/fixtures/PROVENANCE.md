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
| `codex` | `~/.codex/sessions/**/*.jsonl` | 2026-09-08 |
| `antigravity-cli` | `~/.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl` | 2026-09-08 |
| `crush` | `<project>/.crush/crush.db` | 2026-09-08 |
| `opencode` | `~/.local/share/opencode/opencode.db` | 2026-09-08 |
| `zed` | `~/Library/Application Support/Zed/threads/threads.db` | 2026-09-17 |

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

`kilo` and `roo` are not on that list, because `tasks/*/*.json` and a parser
that reads JSON agree about shape. They disagree about *which* JSON: the parser
wants `api_conversation_history.json`, and the pattern also takes
`ui_messages.json` and `task_metadata.json` from the same directory. No
mechanical check can see that, and nobody here runs either tool.

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
| `kilo` | VS Code with Kilo Code, one task, run the script. Also list one `tasks/<id>` directory and say which files are in it: the parser reads `api_conversation_history.json`, the pattern takes every `*.json` beside it, and `ui_messages.json` is a different shape that may parse into nonsense rather than be refused. |
| `roo` | VS Code with Roo Code, one task. Same directory listing as Kilo; they share the format and the question. |
| `chatgpt-export` | A genuine ChatGPT data export — no software to install, just the export ChatGPT emails you. Not in the script: it arrives as an upload, not as a store on disk. |
| `cass-export` | Unknown: nobody here has seen a real one. |

## Defined by us

| Source | Why an author-written fixture is legitimate |
| --- | --- |
| `canonical-bundle` | Memoar's own export format. The fixture and the writer are supposed to agree, and a round-trip test is the real check. It is also the one parser that must *refuse* an unstorable id rather than deriving one, because re-importing a bundle is supposed to preserve identity — deriving would silently renumber an archive being moved between deployments. |

## When a tool changes its format

The fixtures do not notice. Nothing here polls upstream, and a tool that changes
its storage between releases will simply stop being captured — the artifact is
kept with an `unknown_format` diagnostic and the raw bytes are preserved, so
nothing is lost, but nobody is told either. Re-running the verification script
on a machine that uses these tools is currently the only thing that would catch
it.
