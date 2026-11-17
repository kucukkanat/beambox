# AGENTS.md

Shared rules for anyone (human or AI agent) working in this repository. Keep it under two A4 pages.
Only write down what the code can't tell you. Workspace detail lives in each workspace's README.

## Principles: fastest path from idea to working code

1. **Reuse before you write.** Order: platform built-in → a dependency we already have → a popular, maintained
   library → our own code. Check the first three before writing anything non-trivial.
2. **Smallest diff that passes the acceptance tests.** Every added line is a cost. Deleting beats adding.
3. **No abstraction before the third use.** No speculative options, flags, plugin points or "for later" files.
4. **Use the framework, don't wrap it.** Use the validation, routing and testing features a framework ships with.
5. **Create a workspace only when a spec needs it.** No empty apps or packages.
6. **Tests prove behaviour.** Cover the spec's acceptance criteria and real edge cases, not private helpers.
7. **Match process to size.** Tiny change: just do it. Medium: plan, then build. Large: spec first (`specs/`).

Choosing a library: prefer ESM + bundled types, a release in the last 6 months, high weekly downloads,
small install, MIT/Apache/ISC. Say why in the commit message when you add a runtime dependency.

## Stack

Node 26 LTS (min 24), ES modules · TypeScript (strict, erasable syntax only) · npm workspaces + Turborepo ·
Biome (lint + format) · `node:test`. Branches are merged locally with `--ff-only`.
Record project-specific choices (frameworks, database, deploy target) here once they're made.

## Default libraries (use without researching; ask `lib-scout` only for needs not listed)

| Need | Use |
| --- | --- |
| Tests | `node:test` + `node:assert/strict` (framework apps may use the framework's runner, e.g. Vitest for Vite) |
| CLI args, colours, prompts | `node:util` `parseArgs` / `styleText`, `node:readline/promises` |
| HTTP client, timeouts, IDs | `fetch`, `AbortSignal.timeout()`, `crypto.randomUUID()` |
| Env files | `node --env-file-if-exists=.env` |
| Add rows here as the project picks libraries | |

## Commands (repo root)

| Command | What it does |
| --- | --- |
| `npm install` | Install and link all workspaces |
| `npm run dev` | Run every app in watch mode from source |
| `npm run check` | Lint + typecheck + test everything. Must pass before merging |
| `npx turbo run typecheck test --affected` | Check only workspaces changed vs `main` |
| `npx turbo run test --filter=@repo/<name>` | One workspace |
| `node --conditions=@repo/source --test <file>` | One test file |
| `npm run format` | Biome autofix |
| `npm install <dep> -w @repo/<name>` | Add a dependency to one workspace |

## Conventions that aren't obvious from the code

- `apps/*` are deployables and are never imported. `packages/*` are libraries, imported as `@repo/<name>`
  through `src/index.ts` only (no deep imports). Create new ones with `/new-workspace` (template in
  `.claude/skills/new-workspace/template/`).
- In dev, test and typecheck, workspace packages resolve to their TypeScript source via the `@repo/source`
  export condition (`node --conditions=@repo/source`, `customConditions` in each `tsconfig.json`). Only
  `npm run build` emits `dist/`, via `tsconfig.build.json`.
- Erasable TypeScript only: no `enum`, `namespace`, or constructor parameter properties (Node runs `.ts`
  directly). Relative imports end in `.ts`. Use `import type` for types.
- Read environment variables once, in an app's entrypoint, and pass config down. Packages never read
  `process.env`.
- Pass dependencies (config, clients, loggers) as arguments, so tests need no mocking library.
- Tests never touch the real network, clock or fixed ports.
- Each workspace has a README. Update it in the same change when behaviour, API or env vars change.
  Document new env vars in that workspace's `.env.example`.

## Git

- One branch per feature: `feat/<slug>`, `fix/<slug>`, `chore/<slug>` (`worktree-<slug>` when Claude Code made
  the worktree). Conventional Commits, scoped by workspace: `feat(api): add /items`.
- Rebase on `main`, run `npm run check`, then merge with `--ff-only`. Never commit `.env` or secrets.
