---
fail_on: high
---
# Injection audit

Periksa:
- Query SQL/NoSQL yang dibangun dengan string concatenation atau template literal dari input request
- `child_process.exec`/`execSync` dengan input request
- Path file dari input request tanpa normalisasi (path traversal)
- Endpoint tanpa validasi input atau tanpa pemeriksaan otorisasi pada data milik user lain

Severity:
- critical/high: input request mengalir ke sink tanpa validasi
- medium: validasi ada tetapi lemah
- low: hardening
