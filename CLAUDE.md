@AGENTS.md

# Claude Code notes

- Flow for large features: `/feature <idea>[; <idea> ...]` → approve specs → `/kickoff` (one background
  worktree session per approved spec, each running `/build`) → `/ship <slug>` from the main checkout.
  Tiny and medium changes skip the spec. `claude agents` lists background sessions; `claude attach <id>` joins one.
- Model routing is set in skill/agent frontmatter: specs and review use Opus, implementation uses Sonnet,
  code search uses Haiku. Don't override it unless a task clearly needs more or less.
- Check "Default libraries" in AGENTS.md first; ask the `lib-scout` agent only for needs it doesn't cover.
- Hooks: Biome formats every file you edit. A Stop hook runs typecheck + tests for changed workspaces and
  sends you back if they fail (each bounce is logged for `/ship`'s metrics). Fix the cause; never weaken a test
  or skip the hook to get past it.
- Session start installs dependencies in new worktrees, points `TURBO_CACHE_DIR` at the main checkout's
  cache (checks passed in one worktree are cache hits in all of them), and prints the specs waiting on you.
