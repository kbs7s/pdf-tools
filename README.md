# PDF Tools

Free PDF tools for family use that run entirely in the browser, inspired by [Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF).
Files are processed on your own device and are never uploaded. Works on phones and computers, in English and Arabic,
and can be installed to the home screen (works offline after the first visit).

**Live site:** https://kbs7s.github.io/pdf-tools/

## Tools

- Merge PDFs
- Split PDF (every page, every N pages, custom ranges, extract pages)
- Organize pages (reorder, rotate, delete)
- Compress PDF
- Images to PDF / PDF to images
- Page numbers
- Watermark
- Sign PDF (draw, type or upload a signature)
- Add text and cover boxes (to hide or replace old text)
- Fill PDF forms
- OCR in Arabic and English (searchable PDF or plain text)
- Protect a PDF with a password / unlock a PDF with a known password

## How it works

A plain static site, no build step. It uses:

- [pdf-lib](https://pdf-lib.js.org/) to edit PDFs
- [PDF.js](https://mozilla.github.io/pdf.js/) to show and render pages
- [JSZip](https://stuk.github.io/jszip/) to bundle multiple output files
- [Tesseract.js](https://tesseract.projectnaptha.com/) for OCR (Arabic and English language data in `lib/tessdata/`)
- [qpdf](https://qpdf.sourceforge.io/) compiled to WebAssembly ([qpdf-wasm](https://github.com/neslinesli93/qpdf-wasm)) for password protection

The libraries are copied into `lib/` so the site has no outside dependencies.
To run it locally, serve the folder with any static web server (for example `python3 -m http.server`) and open it in a browser.
