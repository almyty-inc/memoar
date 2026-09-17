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

The capture patterns are part of this. A parser verified against the right
store proves nothing if discovery hands it a different file, and twice it did:
`zed` was pointed at `db/<channel>/db.sqlite`, the editor's own state — panes,
terminals, breakpoints — which has no `threads` table, so capture took the
terminal history and never took a conversation. `opencode` collected
`storage/**/*.json`, which is configuration; its sessions are in the database,
and its parser refuses anything that is not native SQLite. Both were confirmed
against the real directories on a machine that runs both tools, and both now
have a test naming the file to take and the file to leave.

Four sources still point at guessed layouts, and the parsers for two of them
(`copilot`, `goose`) accept only native SQLite while their patterns also name
JSON — so whatever those patterns match today is collected, uploaded and
rejected. Nobody here has run those tools. Verifying them is the same exercise:
look at what the tool actually wrote, and check the pattern names it.

## Written from the format, not from a capture

Nobody here has run these tools and fed memoar what came out. The fixtures were
written from the tool's storage format as understood at the time, which is
exactly the position that produced the opencode defect. Treat a green test on
these as evidence that nothing has regressed, not as evidence that the parser
works.

| Source | What it would take to verify |
| --- | --- |
| `cursor` | Install Cursor, hold one conversation, run the script above. |
| `copilot` | Install VS Code with GitHub Copilot, one conversation. |
| `goose` | `brew install block-goose-cli`, one session. |
| `kilo` | VS Code with Kilo Code, one task. |
| `roo` | VS Code with Roo Code, one task. |
| `chatgpt-export` | A genuine ChatGPT data export — no software to install, just the export ChatGPT emails you. |
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
