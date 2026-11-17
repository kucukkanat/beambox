---
name: feature
description: Turn one or more feature ideas into the lightest workable plan. Sizes the work first; writes specs/<slug>.md only for large features. Use when the user describes a new feature or capability.
argument-hint: "<idea>[; <another idea> ...]"
model: opus
effort: high
---

Ideas (separated by `;`): $ARGUMENTS

1. **Size each idea.** Read just enough code to judge it (use the `Explore` agent for searching).
   - **Tiny** (one file, obvious): say so and offer to just do it. No spec.
   - **Medium** (one workspace, clear shape): propose a short plan in chat and build on approval. No spec.
   - **Large** (crosses workspaces, new data model, new workspace, or unclear behaviour): continue below.
2. **Reuse check.** Start from "Default libraries" in AGENTS.md and the current dependencies
   (`npm ls --depth=0`). Ask the `lib-scout` agent only for needs those don't cover.
3. **Ask only what you can't decide.** For all large ideas together, at most 4 questions in one
   AskUserQuestion call, each with a recommended option first. Choose defaults for everything else and list them
   in the spec's "Decisions and defaults".
4. **Write `specs/<slug>.md`** from `specs/_template.md` with `status: draft`, `size: large`, `created` from
   `date -u +%Y-%m-%dT%H:%MZ`. Acceptance criteria must be checkable by a test. Under one page.
   "Out of scope" is mandatory. The spec must be buildable without further questions.
5. Ask the user to approve. On approval set `status: approved` and commit the spec on `main`
   (`docs(specs): approve <slug>`). Suggest `/kickoff` to build all approved specs in parallel.
