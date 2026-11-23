---
fail_on: high
---
# Environment configuration audit

Never read the contents of env files or other secret files; work with variable NAMES only.
Check that:
1. Environment config files that hold secrets are listed in `.gitignore`.
2. No secret value (key, token, password) is hardcoded as a fallback, e.g. `process.env.X || "real-value"`.
3. Variables exposed to the browser (client bundle) contain no secrets.
4. If an example file exists (`.env.example` etc.), its variable names match the ones used in code.
