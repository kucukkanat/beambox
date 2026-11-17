---
name: build
description: Implement an approved spec test-first with the smallest diff, then get an independent review. Use with a path like specs/<slug>.md.
argument-hint: "specs/<slug>.md"
model: sonnet
effort: medium
---

Spec: $ARGUMENTS

This often runs in a background session nobody is watching. Don't stop to ask unless the spec contradicts
itself or is unsafe to guess; otherwise pick the simplest reading and add it to the spec's "Decisions and defaults".

1. Read the spec, `AGENTS.md`, and the README of every workspace it touches. If the spec isn't
   `status: approved`, stop and say so.
2. If you're on `main`, create and switch to `feat/<slug>`. (A worktree session is already on `worktree-<slug>`.)
3. **Tests first.** One test per acceptance criterion; run them and see them fail for the right reason.
4. **Implement the minimum** that makes them pass, following the Principles and Default libraries in AGENTS.md.
   Use `/new-workspace` only if the spec calls for a new workspace.
5. Iterate with the narrowest check (`node --conditions=@repo/source --test <file>`,
   `npx turbo run test --filter=...`). The Stop hook runs typecheck + tests for changed workspaces at the end.
6. If a UI changed: start its dev server, open the affected page in the browser, take a screenshot and
   compare it with the spec's Behaviour section. Fix visible problems.
7. Update READMEs and `.env.example` files whose behaviour, API or env vars changed.
8. **Review.** Ask the `reviewer` agent to review `git diff main...HEAD` plus uncommitted changes against the
   spec. Apply findings about correctness, missing criteria and avoidable code; skip style. Record the number
   applied as `review_findings` in the spec.
9. Set `status: built`, commit on the branch (`feat(<workspace>): <summary>`), and finish with a list of
   acceptance criteria, each with the test that proves it.
