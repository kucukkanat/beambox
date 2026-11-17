---
paths:
  - "packages/**"
---

- Public API is whatever `src/index.ts` exports; update the package README's API table when it changes.
- Packages never read `process.env` or create loggers themselves. Take them as arguments.
- Keep runtime dependencies to the minimum; a package adds weight to every app that uses it.
