---
fail_on: medium
---
# Code standard

Baca dokumen konvensi project bila ada (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `README.md`),
lalu periksa kode di `src/` terhadap konvensi tersebut.

Tambahan aturan umum:
- Tidak ada tipe `any` yang tidak perlu
- Tidak ada `console.log` tertinggal di kode produksi
- Tidak ada kode yang dikomentari dalam blok besar

Laporkan maksimal 15 temuan paling penting. Gunakan medium untuk pelanggaran konvensi yang tertulis eksplisit,
low untuk saran gaya.
