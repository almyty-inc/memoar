---
name: memoar-memory
description: Use a Memoar archive of past AI coding sessions as long-term memory. Use before solving a project problem that a prior Claude Code, Codex, Gemini, Cursor, or other agent session may have handled, when a user asks what was decided previously, when evidence from past work should be packed into the current context, when the user-wide or project instruction files of another machine are needed, or when a durable note should be saved after significant work.
---

# Memoar Memory

Memoar archives the sessions of the coding agents on this account and serves them back as cited evidence. Use it as memory: look up what was decided before acting, and record what was decided after. Treat it as evidence, not as an unbounded context dump.

## Two ways in

- **MCP.** When a `memoar` MCP server is connected, call its tools directly. Tool names below are MCP tool names.
- **CLI.** Without the MCP server, run `memoar mcp call <tool> '<json arguments>'`. It calls the same tool with the same arguments and prints the result as JSON. Pass `-` instead of the JSON to read the arguments from standard input, which avoids shell quoting for long notes. `memoar mcp tools` lists every tool with its input schema. `memoar search`, `memoar view` and `memoar pack` cover the most common reads with plain flags. Read [references/robot-api.md](references/robot-api.md) for outputs and exit codes.

If neither works, say that archive evidence was unavailable and continue with the current context. Do not invent prior decisions. A refusal that names `mcp:use` means the stored key predates `memoar mcp`. Tell the user to run `memoar login` again.

## Before work: retrieve in cost order

1. `search_sessions` with a focused `query`. Narrow it with `agent`, `workspace`, `from` and `to`. To narrow by capture machine, use `list_sessions` with `machineId` from `list_machines`. Ranked search does not filter on machine.
2. `get_excerpt` with `sessionId`, `turnStart` and `turnEnd` for the most promising spans. Check source, age and redaction status before relying on a claim.
3. `pack` when several excerpts must be combined. Set the smallest useful `maxTokens`, `maxEvidence`, `maxSessions` and `maxExcerptChars`. Use `freshnessPolicy: "strict"` for facts that may have changed. `get_memory` with a `topic` is `pack` with conservative defaults.
4. `get_session` with a small `chunkSize`, continued with `nextCursor`, only when the earlier steps cannot answer. Explain why a whole session is needed.

To recall the conventions of a project, also read what was already distilled and written down:

- `export_project_memory` with the exact `workspace` path renders the notes saved for that workspace as AGENTS.md or CLAUDE.md style markdown, each cited to its session.
- `list_annotations` with a `sessionId` reads the notes, tags and summaries on one session.
- `list_memory_documents` lists the captured instruction files (CLAUDE.md, AGENTS.md, GEMINI.md, .goosehints) from every machine on the account. Filter with `workspacePath`, `scope` (`global` or `project`) or a `pathPattern` glob. `get_memory_document` with its `documentId` reads one file and its revision history.

## After work: save what will matter later

Call `save_note` after a significant result: a decision and its reason, a working solution, an environment constraint, a project convention. Keep temporary debugging observations out.

- It takes `sessionId`, `markdown` and an optional `topic`, and there is no turn-span argument, so cite turns inside the markdown.
- Link the note to the session it belongs with: the archived session the decision came from, or the current session once it is archived (`list_sessions` with this `workspace` lists the newest first). If no session fits, report the note text to the user instead of attaching it to an unrelated session.
- To mark one turn or block instead, use `add_annotation` with `kind` (`note`, `tag`, `pin` or `summary`) and its `turnId` or `blockId`.
- Writing needs the `archive:write` scope. A refusal that says missing_scope will not succeed on retry.

## Use evidence correctly

- Cite the session id and turn span for claims drawn from the archive.
- Treat stale evidence as context, not current truth. Verify facts that can change.
- Do not reveal content marked by a redaction mask.
- If semantic retrieval fails and the response reports lexical mode, continue when the lexical evidence is sufficient. State the realized mode when it affects confidence.
- Do not mix contradictory excerpts without showing their timestamps and provenance.

## Avoid common mistakes

- Do not call `get_session` first.
- Do not request a larger pack after a smaller pack already answers the task.
- Do not confuse `get_memory`, which packs sessions, with `list_memory_documents`, which lists instruction files.
- Sharing, visibility changes and deletion are not available to agents. Do not try to work around that.
