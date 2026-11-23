---
fail_on: high
---
# Injection audit

Check for:
- SQL/NoSQL queries built by string concatenation or template literals from request input
- `child_process.exec`/`execSync` with request input
- File paths from request input without normalization (path traversal)
- Endpoints without input validation or without authorization checks on other users' data

Severity:
- critical/high: request input flows into a sink without validation
- medium: validation exists but is weak
- low: hardening
