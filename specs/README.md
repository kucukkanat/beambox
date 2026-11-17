# specs

The backlog. One file per **large** feature; tiny and medium changes don't need one.

- `/feature <idea>` writes `specs/<slug>.md` from [`_template.md`](_template.md) (`status: draft`).
- You approve it → `status: approved` → run `/build specs/<slug>.md` in a worktree session.
- `/build` sets `status: built`; `/ship` merges it, fills `shipped`, `diff`, `new_deps` and moves it to `done/`.

`npm run stats` prints lead time and diff size for shipped specs, so we can see whether the process is
actually getting faster.
