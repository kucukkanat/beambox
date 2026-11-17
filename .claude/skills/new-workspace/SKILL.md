---
name: new-workspace
description: Add a new app or package to the monorepo from the bundled template. Use only when a spec or the user asks for a new app/package.
argument-hint: "apps/<name> | packages/<name> — purpose"
model: sonnet
effort: medium
---

Target: $ARGUMENTS

1. Confirm a new workspace is really needed (could it live in an existing one?). If not clearly needed, ask.
2. **Framework app** (web UI, mobile, etc.): use the framework's own scaffolder inside `apps/`
   (e.g. `npm create vite@latest <name> -- --template react-ts`), then align it with the repo: name
   `@repo/<name>`, scripts `build`/`dev`/`typecheck`/`test`/`clean`, delete its own lint/format config and lockfile.
3. **Everything else**: `cp -R .claude/skills/new-workspace/template <apps|packages>/<name>` and replace
   `__NAME__` and `__DESCRIPTION__` in `package.json` and `README.md`.
   - Package: keep `exports` with `"@repo/source"` first; that's what lets other workspaces use its source
     without a build.
   - Node app: remove `exports` and `files`; add `"dev": "node --conditions=@repo/source --watch src/main.ts"`
     and `"start": "node dist/main.js"`; rename `src/index.ts` to `src/main.ts`.
   - Keep the `tsconfig.json` (typecheck, `customConditions`) / `tsconfig.build.json` (emit) split.
4. Replace the example code and test with the real first piece of behaviour. Fill in the README: purpose,
   how to run it, env vars, how to extend, scripts.
5. Add `.claude/rules/<name>.md` with `paths: ["<apps|packages>/<name>/**"]` only if it has non-obvious
   conventions. Add a row to the workspace table in the root `README.md`.
6. `npm install`, then `npx turbo run typecheck test build --filter=@repo/<name>`.
