# TypeScript monorepo

A starting point for any TypeScript project: npm workspaces, Turborepo, Biome, `node:test`, and a
Claude Code setup tuned for going from idea to working code fast. There are no apps or packages yet;
add them when a feature needs one.

## Quick start

```bash
nvm use            # Node 26 (see .nvmrc); Node 24+ works
npm install
npm run check      # lint + typecheck + test
```

Rename the root `name` in `package.json`, and optionally the `@repo` scope (search for `@repo/`).

## Layout

```
apps/        deployables (services, web apps, CLIs). Never imported by other workspaces.
packages/    libraries, imported as @repo/<name>.
specs/       feature specs for large features: the backlog.
.claude/     Claude Code config: settings, hooks, skills, agents, rules.
```

## Workspaces

| Workspace | Path | Description |
| --- | --- | --- |
| _none yet_ | | Add one with `/new-workspace` in Claude Code |

## Common commands

```bash
npm run build                                  # production build (dist/) for everything
npm test                                       # test everything
npx turbo run test --filter=@repo/<name>       # one workspace
npm install <dep> -w @repo/<name>              # add a dependency to a workspace
npm run format                                 # autofix lint + formatting
npm run stats                                  # lead time and rework per shipped spec
```

Conventions, principles and tooling choices are in [AGENTS.md](AGENTS.md).

## Working with Claude Code

Large features: `/feature <idea>` → approve the spec → `/kickoff` starts a background worktree session per
approved spec → `/ship <slug>`. Tiny and medium changes: just ask.

| Path | Purpose |
| --- | --- |
| [CLAUDE.md](CLAUDE.md) | Imports AGENTS.md, adds Claude-only notes |
| [.claude/settings.json](.claude/settings.json) | Permissions and hooks: format on edit, checks on stop, session start (install, shared Turbo cache, status) |
| [.claude/skills/](.claude/skills) | `/feature`, `/kickoff`, `/build`, `/ship`, `/new-workspace` |
| [.claude/agents/](.claude/agents) | `Explore` (Haiku), `lib-scout` (Sonnet), `reviewer` (Opus) |
| [.claude/rules/](.claude/rules) | Conventions that load only for matching paths |
| [specs/](specs) | Feature specs |

Personal notes go in `CLAUDE.local.md` and personal settings in `.claude/settings.local.json` (both gitignored).
For the TypeScript language-server plugin, run `/plugin install typescript-lsp@claude-plugins-official` once.
