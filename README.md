# checkpost

Pipeline mirip CI/CD yang berjalan di komputer sendiri. Stage didefinisikan sebagai file Markdown, dan stage yang butuh penilaian dijalankan oleh AI CLI (saat ini Claude Code). Kalau semua stage green, gate menyatakan project boleh deploy.

```
 Checkpost · claude-code · main@a1b2c3d
 ──────────────────────────────────────────
 ✔ lint                    4.1s
 ✔ unit-test              12.4s
 ✔ build                  31.0s
 ⠹ security          (paralel)
 ├ ✔ secrets      [AI]     9.8s
 ├ ✖ xss-audit    [AI]    22.3s  2 temuan (1 blokir)
 ├ ⠹ env-audit    [AI]    18.0s
 ○ code-standard  [AI]
```

## Syarat
- Node.js 22+
- [Claude Code](https://docs.claude.com/claude-code) terinstall dan sudah login (`claude`)

## Install
Langsung pakai tanpa install:
```bash
npx check-post init
npx check-post run
```
Atau install permanen:
```bash
npm install -g check-post
```
Perintahnya bisa ditulis `check-post` atau `checkpost`.

Versi terbaru dari GitHub:
```bash
npm install -g github:raisulkhairi/check-post
```

## Mulai
Jalankan di root project yang ingin diperiksa:
```bash
checkpost init      # wizard: deteksi project, pilih preset & stage
checkpost list      # cek urutan stage
checkpost run       # jalankan dengan tampilan terminal
checkpost status    # GREEN/RED, exit code 0/1
```
Tidak perlu membuka `claude` lebih dulu. Checkpost memanggil Claude Code sendiri untuk stage AI.

## Stage = file Markdown
```
checkpost/
  pipeline.md              # config global + konteks project untuk semua stage AI
  01-lint.md
  02-unit-test.md
  03-build.md
  04-security/             # subfolder = grup
    _group.md              # parallel: true
    01-secrets.md
    02-xss-audit.md
  05-code-standard.md
  _draft.md                # awalan _ atau . = diabaikan
```

**Urutan** mengikuti prefix angka (`2-` sebelum `10-`). Item tanpa prefix ditaruh terakhir, urut abjad. Prefix tidak ikut ditampilkan.

**Jenis stage ditentukan dari isi file:**

| Isi | Perilaku | Lulus jika |
|---|---|---|
| `run:` saja | jalankan perintah | exit code 0 |
| body saja | body menjadi instruksi AI | tidak ada temuan ≥ `fail_on` |
| `run:` + body | jalankan perintah, lalu AI meninjau output-nya | tidak ada temuan ≥ `fail_on` |

```md
---
paths: ["src/**/*.ts", "src/**/*.html"]
fail_on: high
---
# XSS audit
Cari pemakaian bypassSecurityTrustHtml dan [innerHTML] berisi data dari user...
```

### Frontmatter

| Field | Di mana | Default | Keterangan |
|---|---|---|---|
| `run` | stage | – | perintah shell |
| `timeout` | stage | 15m (command), 10m (AI) | `30s`, `5m`, `1h`, atau angka detik |
| `fail_on` | stage | `high` | `critical`, `high`, `medium`, `low`, `info` |
| `paths` | stage | – | batasi file yang diperiksa AI |
| `allow_failure` | stage | `false` | gagal tidak menghalangi gate |
| `enabled` | stage, grup | `true` | |
| `name` | stage, grup | nama file | nama tampilan |
| `model`, `max_budget_usd` | stage, pipeline | `sonnet`, `1` | |
| `parallel` | grup | `false` | jalankan isi grup bersamaan |
| `fail_fast` | grup, pipeline | `true` | berhenti di kegagalan pertama |
| `require_clean_tree` | pipeline | `true` | gate RED bila ada perubahan belum di-commit |
| `sensitive_paths` | pipeline | `.env*`, `.npmrc`, `*.pem`, `*.key` | path yang tidak boleh dibaca AI |
| `confirm_ai` | pipeline | `true` | konfirmasi sekali sebelum memakai kuota AI |

Body `pipeline.md` dan `_group.md` ikut menjadi konteks untuk setiap stage AI di bawahnya.

## Keamanan stage AI
- AI hanya diberi tool baca (Read, Grep, Glob) dan tidak bisa mengubah file atau menjalankan perintah.
- `sensitive_paths` diblokir lewat aturan permission deny Claude Code. Percobaan membaca path itu tercatat di log sebagai `akses diblokir`.
- Claude Code dijalankan tanpa MCP server, plugin, dan setting user, supaya konteks kecil dan biayanya sekitar sen per stage, bukan dolar.
- Jawaban AI wajib berbentuk JSON terstruktur yang divalidasi. Kalau tidak valid, diminta ulang sekali. Kalau tetap tidak valid, stage berstatus `error`, bukan lulus.

## Gate
`checkpost status` hanya GREEN kalau:
- semua stage lulus (atau `allow_failure`),
- hasil run untuk commit yang sama dengan `HEAD`,
- definisi stage tidak berubah sejak run,
- working tree bersih (bisa dimatikan dengan `require_clean_tree: false`).

```bash
checkpost status && vercel --prod
```

## Mode CI / skrip
```bash
checkpost run --ci            # output polos + exit code
checkpost run --ci --json     # hasil akhir JSON di stdout, log di stderr
checkpost run security        # satu grup/stage saja (id atau nama)
```
`init` juga bisa memasang slash command `/checkpost` untuk Claude Code.

## Repo yang bukan milik sendiri
`checkpost init --share local` menulis `checkpost/`, `.checkpost/`, dan slash command ke `.git/info/exclude`. Repo tidak berubah sama sekali.

## Pengembangan
```bash
npm install
npm test          # vitest
npm run build     # tsc → dist/
npm link          # perintah checkpost tersedia global dari folder ini
```
