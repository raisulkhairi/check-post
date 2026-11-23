---
paths: ["src/**/*.ts", "src/**/*.html"]
fail_on: high
---
# XSS audit (Angular)

Angular sudah melakukan sanitasi otomatis, jadi fokus pada celah yang melewatinya:
- Pemakaian `DomSanitizer.bypassSecurityTrustHtml/Url/ResourceUrl/Script/Style` dengan data yang bisa dikontrol user atau API
- Binding `[innerHTML]`, `[outerHTML]`, `[srcdoc]` berisi data dari user, query param, atau API tanpa sanitasi yang jelas
- Manipulasi DOM langsung: `ElementRef.nativeElement.innerHTML`, `Renderer2.setProperty(..., 'innerHTML', ...)`, `document.write`, `insertAdjacentHTML`
- `[href]`/`[src]` yang dibangun dari input user (risiko `javascript:` URL)
- `eval`, `new Function`, `setTimeout` dengan string

Severity:
- high: data dari user/query param/API mengalir ke salah satu sink di atas tanpa sanitasi
- medium: sumber data tidak jelas
- low: data statis/terkontrol penuh
