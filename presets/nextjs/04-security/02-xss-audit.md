---
paths: ["src/**/*.{ts,tsx,js,jsx}", "app/**/*.{ts,tsx,js,jsx}", "pages/**/*.{ts,tsx,js,jsx}", "components/**/*.{ts,tsx,js,jsx}"]
fail_on: high
---
# XSS audit (React/Next.js)

Periksa:
- `dangerouslySetInnerHTML` berisi data dari user, query string, CMS, atau API tanpa sanitasi (mis. DOMPurify)
- `href`/`src` yang dibangun dari input user (risiko `javascript:` URL)
- Data `searchParams`/`params` yang dirender atau dipakai di redirect tanpa validasi
- `eval`, `new Function`, manipulasi `innerHTML` langsung

Severity:
- high: data tidak tepercaya mengalir ke sink tanpa sanitasi
- medium: sumber data tidak jelas
- low: data statis/terkontrol penuh
