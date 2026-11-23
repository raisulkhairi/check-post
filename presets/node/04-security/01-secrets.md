---
fail_on: high
---
# Secrets & API key

Cari kredensial yang di-hardcode di source code yang ikut di-commit:
- API key, token, password, private key, connection string berisi password
- URL yang menyertakan kredensial (`https://user:pass@...`)
- Token JWT atau bearer token yang ditulis langsung

Cara kerja:
1. Pakai Grep dengan pola seperti `api[_-]?key`, `secret`, `token`, `password`, `Bearer `, `-----BEGIN`, `sk_live`, `AKIA`.
2. Baca konteks setiap hasil untuk memastikan nilainya benar-benar rahasia.

Severity:
- critical: secret asli yang terlihat aktif
- high: kemungkinan besar secret asli
- low: placeholder atau contoh (mis. `xxx`, `changeme`, `your-api-key`)
Abaikan file test, mock, dan fixture kecuali isinya terlihat seperti secret asli.
