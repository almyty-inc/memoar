---
name: memoar-memory
description: Search and curate a Memoar archive of AI coding sessions. Use before solving a project problem that may have been handled in a prior Claude Code, Codex, Antigravity, Cursor, or other agent session, when a user asks what was decided previously, when evidence from past work should be packed into the current context, or when a durable note should be saved after significant work.
---

# Memoar Memory

Use the archive as cited evidence, not as an unbounded context dump.

## Retrieve in cost order

1. Call `search_sessions` with a focused query and relevant project, agent, machine, or date filters. Keep the default summary fields.
2. Call `get_excerpt` for the most promising result spans. Check source, age, and redaction status before relying on a claim.
3. Call `pack` when several excerpts must be combined. Set the smallest useful `max_tokens`, `max_evidence`, and `max_sessions` limits. Use `freshness_policy: strict` for facts that may have changed.
4. Call chunked `get_session` only when the earlier steps cannot answer the request. Explain why a full session is needed.

For CLI-only environments, use the matching `memoar search`, `memoar view`, and `memoar pack` commands with `--json`. Read [references/robot-api.md](references/robot-api.md) for stable outputs and exit codes.

## Use evidence correctly

- Cite the session id and turn span for claims drawn from the archive.
- Treat stale evidence as context, not current truth. Verify facts that can change.
- Do not reveal content marked by a redaction mask.
- If semantic retrieval fails and the response reports lexical mode, continue when the lexical evidence is sufficient. State the realized mode when it affects confidence.
- If Memoar is unavailable, continue with the current context and say that archive evidence was unavailable. Do not invent prior decisions.

## Curate after work

Call `save_note` after a significant result that will matter in later sessions. Save decisions, working solutions, environment constraints, and project conventions. Link the note to the source session and exact turn span. Keep temporary debugging observations out of durable memory.

## Avoid common retrieval mistakes

- Do not call `get_session` first.
- Do not request a larger pack after a good smaller pack already answers the task.
- Do not mix contradictory excerpts without showing their timestamps and provenance.
- Do not widen session visibility or create a share link without a completed redaction review.
