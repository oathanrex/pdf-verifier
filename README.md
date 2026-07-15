# PDF Signature Verifier

Zero-server, 100% client-side PDF digital signature checker. Built against
`PDF-Signature-Verifier-PRD.md` v1.8.

## File map

```
index.html              entry point (semantic shell, meta tags, panels)
tailwind.config.js       build-time Tailwind config
input.css                Tailwind entry point
package.json             build scripts + devDependency
assets/styles.css        compiled CSS (already built — commit this)
js/
  main.js                entry point, worker lifecycle, wiring
  stateMachine.js         FR-03 state machine (8 states)
  dropzone.js             FR-01 dropzone (drag/drop, click, keyboard)
  theme.js                FR-04 theme switcher
  pdfParser.worker.js      FR-02 binary parser (runs in a Web Worker)
```

## Local development

**Do not open `index.html` by double-clicking it.** Web Workers cannot be
instantiated from a `file://` origin — Chrome throws a `SecurityError`
regardless of path correctness (PRD Section 4.2b / FR-02b). Serve the folder
over `http://localhost` instead:

```bash
npx serve .
# or
python3 -m http.server
```

Then open the printed `localhost` URL.

## Building CSS

The Tailwind Play CDN is intentionally **not** used in production (PRD
Section 6.6 — it's a third-party runtime script load that contradicts the
zero-server trust claim, and it costs LCP/TBT). `assets/styles.css` is
already compiled and committed, but to rebuild it after editing
`index.html` or the `js/` files:

```bash
npm install
npm run build:css
```

## Deploying to GitHub Pages

1. Push this folder to the `pdf-verifier` path of the `oathanrex.github.io`
   repository (or a repo whose Pages URL resolves to
   `https://oathanrex.github.io/pdf-verifier/`).
2. No server-side build step is required at deploy time — `assets/styles.css`
   is a static, pre-compiled artifact already checked in. If you want CI to
   rebuild it automatically on every push instead of committing it by hand,
   add the GitHub Actions workflow specified in PRD Section 6.6.
3. Add `assets/og-cover.png` (1200×630px) before sharing links publicly —
   the Open Graph/Twitter Card meta tags reference this path and a missing
   image silently degrades link previews to a bare-link fallback.

## Known gap (see PRD v1.8 revision history)

Every module has been syntax-checked, and `pdfParser.worker.js`,
`stateMachine.js`, `dropzone.js`, `theme.js`, and `index.html`'s structure
have been functionally tested (Node + jsdom — test files not included in
this deliverable set, available on request). `main.js`'s full worker
lifecycle (spawning a real `Worker`, `import.meta.url` resolution, the
timeout/onerror race handling) has **not** been exercised end-to-end in a
real browser, since jsdom does not implement the Worker API. Test this path
manually before considering the build production-ready:

- Drop a valid signed PDF → confirm the `panel-success` copy and technical
  details appear.
- Drop a non-PDF file → confirm instant rejection with no spinner.
- Drop a PDF while a previous verification is still `PROCESSING` → confirm
  the second drop is silently ignored (Single-Active-Worker Lock).
- Check DevTools → Network while verifying a file → confirm zero requests
  containing PDF byte data (the core "zero-server" trust claim).
