---
status: draft        # draft | approved | built | shipped
size: large
created: 2026-01-01T00:00Z
shipped:
diff:                # filled by /ship, e.g. "6 files changed, 120 insertions(+), 8 deletions(-)"
new_deps: 0          # filled by /ship
bounces: 0           # filled by /ship: times the Stop hook sent Claude back
review_findings: 0   # filled by /build: findings from the reviewer agent that were applied
---

# <Feature name>

## Goal
One or two sentences: who gets what, and why now.

## Behaviour
What changes for the user or caller: endpoints (method, path, request, response), CLI commands, screens, jobs.

## Acceptance criteria
Each one becomes a test.
- [ ] …
- [ ] …

## Reuse
Built-ins, existing deps, or libraries this uses instead of new code (see "Default libraries" in AGENTS.md).

## Decisions and defaults
Choices made without asking, so they can be challenged in review.

## Out of scope
- …
