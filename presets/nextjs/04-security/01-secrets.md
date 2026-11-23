---
fail_on: high
---
# Secrets & API keys

Look for credentials hardcoded in committed source code:
- API keys, tokens, passwords, private keys, connection strings containing passwords
- URLs with embedded credentials (`https://user:pass@...`)
- JWTs or bearer tokens written inline

How to work:
1. Use Grep with patterns such as `api[_-]?key`, `secret`, `token`, `password`, `Bearer `, `-----BEGIN`, `sk_live`, `AKIA`.
2. Read the context of every match to confirm the value is actually secret.

Severity:
- critical: a real secret that looks active
- high: very likely a real secret
- low: placeholder or example (e.g. `xxx`, `changeme`, `your-api-key`)
Ignore test, mock, and fixture files unless the value looks like a real secret.
