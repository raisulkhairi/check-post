---
fail_on: high
---
# Audit konfigurasi environment

Jangan pernah membaca isi file env atau file rahasia; cukup gunakan nama variabel.
Periksa:
1. File konfigurasi environment yang berisi rahasia tercantum di `.gitignore`.
2. Tidak ada nilai rahasia (key, token, password) yang di-hardcode sebagai fallback, mis. `process.env.X || "nilai-asli"`.
3. Variabel yang terekspos ke browser (bundle client) tidak berisi rahasia.
4. Bila ada file contoh (`.env.example` dsb.), bandingkan nama variabelnya dengan yang dipakai di kode.
