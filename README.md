# eCommerce Integration Label Auditor

A web app that checks Australia Post **eParcel** and **StarTrack** shipping labels. You upload label files (PDF or image), the app reads the barcodes on them, checks everything against the carrier specifications, and shows a pass/fail report with the evidence for each check.

It runs entirely on your own machine. No label data ever leaves the workstation.

## Where the computation happens

Every stage runs in the user's browser. The bundled server (or any static web host) only delivers the files — there is no cloud compute, no upload, and no external service: label data never leaves the machine.

| Stage            | What does it                                                             | Where it runs        |
| ---------------- | ------------------------------------------------------------------------ | -------------------- |
| PDF rendering    | pdf.js                                                                   | Browser (web worker) |
| Barcode decoding | ZXing WebAssembly + ZXing-JS fallback                                    | Browser              |
| OCR              | tesseract.js — WASM cores and language data shipped in `public/`, no CDN | Browser              |
| Rule evaluation  | ruleEngine + carrier rule packs, plain JS                                | Browser              |
| Report           | React                                                                    | Browser              |

---

## How it works, step by step

1. **Upload** — you drop one or more label files (up to 7 MB each) into either the eParcel section or the StarTrack section. The two are kept separate so a label is always judged against the right rules. A third choice, **Barcode Reader**, runs the same render-and-scan steps with no rules at all: it simply lists every decoded barcode with its raw content (FNC1 characters shown where the scan captured them) — steps 4 and 5 below don't apply, and OCR is skipped.
2. **Render** — each PDF page or image is drawn in the browser. If a label is sideways it gets rotated, and a sheet with several labels on it is cut into individual labels.
3. **Read** — the app scans each label for barcodes (linear, Data Matrix, QR) using three decoders, and runs OCR to read the printed text.
4. **Check** — the audit engine works out which product the label is for (from the codes it just read), loads the matching rule set, and runs every rule: format, check digits, identity, routing, product/service combination, and printed text.
5. **Report** — you get an overall PASS / REVIEW / FAIL verdict, a list per label, and one row per rule. Each row shows the value that was read, the rule it was checked against, and the result. Each barcode is also split into its individual fields so you can see exactly which part passed or failed. Barcode values are shown exactly as scanned, and FNC1 appears only where the scan captured it. The report can be printed or saved as a PDF straight from the browser; the printed report covers the barcode findings with their colour coding (the text analysis stays on-screen only for now).

One rule to remember: **the barcode is the source of truth.** Whatever the barcode decodes to is the real value. OCR text is only used to confirm that the printed label agrees with it — never the other way around.

---

## What it checks

| Area            | What it does                                                                                                                            |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Barcode reading | Finds and decodes every barcode on the label: linear, Data Matrix, QR                                                                   |
| Barcode parsing | Splits raw barcode strings into their fields — GTIN, article ID, SSCC, despatch ID, postcode, DPID, dates                               |
| Field checks    | Each field is checked for position, length, allowed values and check digit, and shown with its own status                               |
| Rule checks     | Regex, equality, ranges, cross-field comparisons, check-digit maths, product/service matrix. Dates are shown but not checked            |
| Reference data  | Built-in tables of eParcel products and services, and StarTrack products, label codes and unit types                                    |
| Evidence        | Full-label previews, a cropped image of every barcode, and a badge on every value showing where it came from (barcode, OCR, or derived) |

---

## Supported products and service codes

These tables mirror the app's built-in reference data (`src/carriers/<carrier>/referenceData.js`), which every rule check resolves against.

### eParcel products

| Product code | Product                      |
| ------------ | ---------------------------- |
| 00091        | Parcel Post (Non-Signature)  |
| 00093        | Parcel Post + Signature      |
| 00087        | Express Post (Non-Signature) |
| 00096        | Express Post + Signature     |
| 00065        | Parcel Post Return           |
| 00068        | Express Post Return          |
| 00120        | Metro + Signature            |
| 00121        | Metro (Non-Signature)        |

### eParcel service codes

| Service code | Service                        | Valid with products        |
| ------------ | ------------------------------ | -------------------------- |
| 03           | Signature Required             | 00093, 00096, 00065, 00068 |
| 08           | Authority To Leave             | 00093, 00096, 00065, 00068 |
| 09           | Non-Signature + ATL            | 00091, 00087, 00121, 00120 |
| 15           | ATL + Partial Delivery         | 00093, 00096               |
| 45           | Partial Delivery Allowed       | 00093, 00096, 00121, 00120 |
| 50           | Safe Drop Enabled              | 00093, 00096               |
| 51           | Safe Drop + Partial Delivery   | 00093, 00096, 00121, 00120 |
| 49           | Wine Delivery – Addressee Only | 00093                      |
| 81           | Wine Delivery – Signature      | 00093                      |
| 82           | Wine Delivery – ATL            | 00093                      |
| 83           | Wine Delivery – Safe Drop      | 00093                      |

A label whose service and product codes both decode correctly but are not a valid pair fails the service/product matrix check.

### StarTrack products

| Product code | Product                        | Group            | Routing label code |
| ------------ | ------------------------------ | ---------------- | ------------------ |
| EXP          | Express                        | Express services | EXP                |
| PRM          | Premium                        | Premium services | PRM                |
| FPP          | 1, 3 & 5Kg Fixed Price Premium | Premium services | PRM                |
| ARL          | Airlock                        | Premium services | ARL                |
| FPA          | 1, 3 & 5Kg Fixed Price Airlock | Premium services | ARL                |
| RET          | Express Tail-Lift              | Special Services | RET                |
| RE2          | Express Tail-Lift 2 man        | Special Services | RE2                |
| TSE          | Tradeshow Express              | Special Services | TSE                |
| APT          | Premium Tail-Lift              | Special Services | APT                |

The routing barcode's label code must match the product's expected label code. Unit types (BAG, CTN, ITM, JIF, PAL, SAT, SKI) are checked per product family; TSE and APT labels with unit data surface as manual review because the spec defines their units by arrangement only.

---

## How a label is processed

```text
                    +----------------------------------+
                    |     Upload label file(s)         |
                    |  PDF / PNG / JPG / WEBP / BMP    |
                    +----------------+-----------------+
                                     |
            +------------------------+-------------------------+
            v                                                  v
+---------------------------+          +----------------------------------------+
| IMAGE path                |          | PDF path (per page, max 40)            |
|  decode to canvas         |          |  read selectable text layer            |
|  (max 50M pixels)         |          |  text sparse = scanned page?           |
+------------+--------------+          |   yes -> find embedded scan image,     |
             |                         |          render 1:1 at its native DPI  |
             |                         |   no  -> render at 4x (~288 DPI)       |
             |                         +-------------------+--------------------+
             +--------------------+----------------------+
                                  v
   ========= DOCUMENT PREPARATION - scanner/inputPrep.js (non-audit) =========
     1 contrast   : faded scan? stretch 2-98% luminance range
     2 orientation: barcode probe -> rotate 90/180/270 upright
     3 deskew     : symbol angle (re-probe verified) or projection
                    profile -> straighten 0.6-12 degree scan tilt
     4 segment    : white gutters -> one canvas per label on a sheet
                    (upright PDF text layer split per label region)
                                  |
                 . . . . . . per label from here . . . . . .
                                  v
   ============== BARCODE DECODE (source of truth for values) ==============
     targets : carrier crop zones + full-page safety scan
     variants: original | trim+border | 2x | 4x | threshold 150/185 |
               sharpen | square   (each records its transform)
               + 90/270 rotated rescue for linear misses
     engines : BarcodeDetector -> ZXing-WASM -> ZXing-JS fallback
     per hit : measure true bar height, count bars, map box back
               to page coordinates through the transform, dedupe
                                  v
   ===================== EVIDENCE IMAGES =====================
     label preview with green/red/amber outlines
     per-barcode crops from decoded page boxes
     (fixed template crops only as last resort)
                                  v
   ============= TEXT EXTRACTION (one-way cross-check only) =============
     PDF text layer sufficient? -> use it, skip OCR
     else full-label OCR: decoded barcodes masked white,
          uneven photo lighting flattened, text rebuilt from
          word boxes -> noise dropped, side-by-side columns
          kept as separate contiguous groups
     + aggressive OCR pass on each barcode crop (HRI digits)
     merge and dedupe lines
                                  v
   ===================== QUALITY GAUGE =====================
     sharpness | DPI or px/module (barcode as ruler) |
     contrast | OCR confidence   -> rated good / fair / poor
                                  v
   ======================== AUDIT ========================
     facts from barcodes + text -> carrier rule set
     (eParcel / StarTrack packs, per label type)
     -> pass / fail / manual review per rule, with evidence
                                  v
   ======================== REPORT ========================
     header + input-quality gauge
     full label image with barcode outlines
     per-barcode sections and field breakdowns
     visible-text checks | print / save as PDF
```

Everything above the "per label" line runs once per uploaded page; everything below
runs once per detected label. Barcodes always decode before OCR runs: decoded values
are the source of truth, and extracted text is only ever a one-way cross-check.

---

## Layout of the repo

```
src/                  The app itself
  main.jsx            React UI: upload flow and audit orchestration
  auditEngine.js      Public audit API: dispatches auditLabel through the carrier registry
  ruleEngine.js       Runs the JSON rules (generic — knows nothing about carriers)
  styles.css          All styling
  assets/             Images used in the UI
  carriers/           One package per carrier; a new carrier is a new folder here
    index.js          Carrier registry — the one place that lists the carriers
    shared/           Cross-carrier text primitives and audit plumbing
    formats/          Barcode formats used by more than one carrier (GS1 / SSCC)
    eparcel/          The eParcel pack
      audit.js             Evidence context, variant selection, carrier rule functions
      facts.js             Visible-text fact extraction
      referenceData.js     Product and service tables
      ruleSets.js          Loads each label type's rules.json, merges variant over base
      sections.jsx         eParcel-specific report sections
      standards.js         Spec standard/example text per validation id
      formats/             eParcel barcode formats (article, GS1 DataMatrix)
      base/rules.json      Base rule set + documents registry (spec citations)
      parcel-post/ express-post/ returns/ sscc/    One rules.json per label type
      metro/               rules.json + routing.js (Metro-only routing extraction)
    startrack/        The StarTrack pack — same shape: audit.js, facts.js,
                      referenceData.js, ruleSets.js, sections.jsx, standards.js,
                      formats/ (freight item, routing, ATL, QR),
                      base/ express/ premium/ fpp/ sscc/ rules.json per label type
  report/             Carrier-agnostic report UI
    reportView.jsx    The rule-by-rule report (value / rule / result panes)
    common.jsx        Shared components: section chrome, rail nav, field lines, copy buttons
    sections.jsx      Maps an audit to its report sections (dispatches by carrier)
    auditInfo.js      Pure helpers over the audit result: headers, summaries, copy-all text
    segments.js       Colour-coded barcode fields, sliced from the raw captured bytes
    printReport.jsx   Print / Save-as-PDF export: the dedicated printed document + print trigger
    print.css         The printed report's entire stylesheet (A4, one page per barcode)
    standards.js      Merges the carriers' spec example texts
    barcodeFieldSpecs.js   Barcode field breakdown specs: per-field check, obligation, citation
    ruleSource.js     Spec citation line for the report (document title, version, page)
    readerData.js     Raw byte display and leading-FNC1 evidence (all views), Reader mode data
    readerReport.jsx  Barcode Reader mode report: rule-free per-barcode cards
  preprocess.js       Rotates sideways labels, splits multi-label sheets
  ocrText.js          OCR of the printed label text
  scanner/
    pipeline.js       File in → pages → labels → decoded barcodes out
    inputPrep.js      Document preparation and quality gauge: contrast, deskew,
                      illumination flattening, sharpness/DPI assessment (non-audit)
    scanPlan.js       Decides which regions to scan and maps coordinates back
    decoders.js       The three decode engines (BarcodeDetector, ZXing-WASM, ZXing-JS)
    labelImages.js    Label previews and per-barcode evidence crops
    canvasUtils.js    Shared canvas and geometry helpers
    barcodeTypes.js   Shared names for barcode kinds
    debugLog.js       Extra logging, off unless you opt in (localStorage 'ba-debug')
    pdfWatchdog.js    30s timeout around every pdf.js call so a dead PDF worker
                      surfaces as an error instead of a silent hang

tests/                Node test suite (npm test): rule evaluator, barcode parsers,
                      preprocessing, scan planning, field specs, and a rules catalogue lint
                      (pending: end-to-end label fixtures built from Resources/Example labels,
                      so real labels regression-test the full facts -> rules -> verdict chain)

scripts/              Build tooling
  build-portable.mjs      Rebuilds portable/ from dist/ (the pre-commit hook runs this)
  sync-ocr-assets.mjs     Re-copies OCR runtime files from node_modules after an upgrade
  sync-pdf-assets.mjs     Re-copies pdf.js standard fonts from node_modules after an upgrade

public/               OCR runtime files bundled into the build (tesseract worker, WASM, language
                      data) plus pdf.js's standard 14 fallback fonts (standard_fonts/)
dist/                 The built app — committed on purpose, see note below
portable/             Ready-to-run copy: dist/ + server.mjs + a README (rebuilt on every commit)
share/README.md       End-user "run it with Node" guide, bundled into portable/
Resources/            The carrier spec PDFs and example labels the rules were written from

server.mjs            Small local web server for the built app (npm start → 127.0.0.1:3000)
index.html            Vite entry point
vite.config.js        Build config
start-auditer.bat     Windows launcher: starts the server and opens the browser
run-server.bat        Bare-bones alternative: just runs node server.mjs
.githooks/pre-commit  Rebuilds and stages portable/ on every commit
```

**Why is `dist/` committed?** The machine this tool ships to cannot run a build. It runs the prebuilt app straight from the repo with `node server.mjs`. After changing `src/`, run `npm run build` and commit the regenerated `dist/` with the source change so the two never drift apart.

---

## Commands

```bash
npm install          # once
npm run dev          # dev server with hot reload on 127.0.0.1:5173
npm run build        # build dist/ (commit it together with the source change)
npm start            # serve the built app on 127.0.0.1:3000
npm run build:portable   # rebuild portable/ from dist/
npm run sync:ocr     # re-copy OCR runtime files after a tesseract.js upgrade
npm run sync:pdf     # re-copy pdf.js standard fonts after a pdfjs-dist upgrade
npm test             # Node test suite: evaluator, parsers, preprocessing, rules lint
npm run lint         # ESLint over the whole repo
npm run format       # Prettier --write (format:check verifies without writing)
```

Needs Node 20.10 or newer.

---

## What is (and isn't) in the repo

The repo tracks what is needed to build, run, ship and verify the app: the source, the prebuilt `dist/` and `portable/`, this README, the `Resources/` folder of carrier specs and example labels, and (since v1.15.0) the Node test suite in `tests/` plus the ESLint/Prettier configs — so any clone can run `npm test` and `npm run lint` before shipping. Authoring docs, CI pipeline config, release tooling, working notes and generated reports stay on the dev machine and are git-ignored (see `.gitignore`).
