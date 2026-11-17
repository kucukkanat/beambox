---
name: kickoff
description: Start one background worktree session per approved spec, so several features get built in parallel without supervision.
argument-hint: "[slug ...]  (default: every approved spec without a branch)"
disable-model-invocation: true
model: sonnet
effort: low
---

1. Find specs in `specs/` with `status: approved` (or only the slugs in `$ARGUMENTS`). Skip any that already
   have a `worktree-<slug>` or `feat/<slug>` branch.
2. You must be in the main checkout on `main`. Background worktrees branch from `main`, so the specs must be
   committed there: if any of them are uncommitted, commit them now (`docs(specs): approve <slugs>`).
3. For each spec, start a background session in its own worktree:
   `claude --bg -w <slug> "/build specs/<slug>.md"`
   Start at most 5 at once; list the rest as queued.
4. Report a table of slug → session id, then:
   - `claude agents` shows progress; `claude attach <id>` opens one to answer a question or look closer.
   - Each session ends only when the Stop hook is green. Then run `/ship <slug>` from the main checkout.
