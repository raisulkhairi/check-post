---
paths: ["src/**/*.ts", "src/**/*.html"]
fail_on: high
---
# XSS audit (Angular)

Angular sanitizes automatically, so focus on the gaps that bypass it:
- `DomSanitizer.bypassSecurityTrustHtml/Url/ResourceUrl/Script/Style` with data that users or an API can control
- `[innerHTML]`, `[outerHTML]`, `[srcdoc]` bindings with data from users, query params, or an API without clear sanitization
- Direct DOM manipulation: `ElementRef.nativeElement.innerHTML`, `Renderer2.setProperty(..., 'innerHTML', ...)`, `document.write`, `insertAdjacentHTML`
- `[href]`/`[src]` built from user input (risk of `javascript:` URLs)
- `eval`, `new Function`, `setTimeout` with a string

Severity:
- high: data from users/query params/an API flows into one of the sinks above without sanitization
- medium: the data source is unclear
- low: static or fully controlled data
