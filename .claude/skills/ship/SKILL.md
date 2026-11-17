---
name: ship
description: Rebase a feature branch on main, run the full check, record metrics in the spec, and fast-forward main.
argument-hint: "[slug]  (default: the current branch)"
disable-model-invocation: true
model: sonnet
effort: low
---

Target: `$ARGUMENTS` if given, otherwise the current branch.

1. **Find the branch and where it's checked out.** Branch is `worktree-<slug>` or `feat/<slug>`.
   `git worktree list --porcelain` gives the main checkout (first entry) and the worktree holding the branch,
   if any. Run every git/npm command below in that worktree (`git -C <path>`, `cwd`), or in the current
   checkout when the branch lives here. The branch must not be `main`.
2. If that checkout is dirty, show `git status` and ask whether to commit. Stop on anything unexpected.
3. `git rebase main`. Resolve conflicts only when the intent of both sides is obvious; otherwise stop and show them.
4. `npm run check`. Fix failures caused by the rebase; stop and report anything else.
5. **Record metrics** in `specs/<slug>.md` frontmatter (if the spec exists): `status: shipped`, `shipped`
   (`date -u +%Y-%m-%dT%H:%MZ`), `diff` from `git diff --shortstat main...HEAD`, `new_deps` = runtime
   dependencies added in any `package.json`, `bounces` = `grep -c '"branch":"<branch>"'` in
   `$(git rev-parse --path-format=absolute --git-common-dir)/agent-metrics.jsonl` (0 if missing).
   `git mv` it to `specs/done/` and commit: `docs(specs): ship <slug>`.
6. **Fast-forward main** in the main checkout: it must be on `main` with a clean tree (otherwise stop and say
   so), then `git -C <main-checkout> merge --ff-only <branch>`.
7. Clean up: if the branch lives in a worktree under `.claude/worktrees/`, `git worktree remove <path>`; then
   `git branch -d <branch>`. Report commits merged, diff stats, new deps, bounces and lead time.
