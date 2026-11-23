---
fail_on: medium
---
# Code standard

Read the project's convention documents if present (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `README.md`),
then check the code in `src/` against those conventions.

General rules on top of that:
- No unnecessary `any` types
- No leftover `console.log` in production code
- No large blocks of commented-out code

Report at most the 15 most important findings. Use medium for violations of explicitly written conventions,
low for style suggestions.
