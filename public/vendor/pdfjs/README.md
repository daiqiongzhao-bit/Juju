# PDF.js (vendored)

- **Version:** 4.10.38 (`apiVersion` inside `pdf.min.mjs`; the bundled core-js is 3.39.0)
- **Source:** `build/pdf.min.mjs` and `build/pdf.worker.min.mjs` from the
  [`pdfjs-dist`](https://github.com/mozilla/pdf.js) npm package, plus the
  `standard_fonts/` folder the viewer needs for PDFs that embed none.
- **License:** Apache-2.0, full text in `LICENSE`. The standard fonts carry their own
  licenses: `standard_fonts/LICENSE_FOXIT` (Foxit) and `standard_fonts/LICENSE_LIBERATION`
  (Liberation Fonts).

## Usage

Import lazily where a PDF is rendered (this is the original of the pattern the other
vendor READMEs point at):

```js
const pdfjs = await import('/vendor/pdfjs/pdf.min.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';
// getDocument({ ..., standardFontDataUrl: '/vendor/pdfjs/standard_fonts/' })
```

Do not import it eagerly from app-shell code — pages that never preview a PDF must not
pay for it.

## Updating

1. Fetch the new version's tarball from `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-<version>.tgz`.
2. Copy `build/pdf.min.mjs`, `build/pdf.worker.min.mjs` and `standard_fonts/` here.
3. Replace `LICENSE` (and the font licenses) if they changed upstream, and bump the
   version in this README.
