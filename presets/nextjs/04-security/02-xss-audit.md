---
paths: ["src/**/*.{ts,tsx,js,jsx}", "app/**/*.{ts,tsx,js,jsx}", "pages/**/*.{ts,tsx,js,jsx}", "components/**/*.{ts,tsx,js,jsx}"]
fail_on: high
---
# XSS audit (React/Next.js)

Check for:
- `dangerouslySetInnerHTML` with data from users, query strings, a CMS, or an API without sanitization (e.g. DOMPurify)
- `href`/`src` built from user input (risk of `javascript:` URLs)
- `searchParams`/`params` data rendered or used in redirects without validation
- `eval`, `new Function`, direct `innerHTML` manipulation

Severity:
- high: untrusted data flows into a sink without sanitization
- medium: the data source is unclear
- low: static or fully controlled data
