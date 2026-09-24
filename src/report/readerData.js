// Barcode Reader mode data shaping - pure and Node-testable (no JSX, no browser APIs
// beyond Date). The reader applies no validation rules: it lists every decoded barcode
// with its raw content, making FNC1 evidence visible. Two FNC1 facts matter here:
//   1. The LEADING FNC1 (first symbol position on GS1 carriers) is never transmitted as
//      data - the ISO/IEC 15424 symbology identifier (]C1 / ]d2 / ]Q3...) is its only proof.
//   2. In-payload FNC1 group separators arrive as ASCII 29 (GS) in the raw byte stream,
//      which display text modes often strip or rewrite - so the byte stream is preferred.

import { hasFnc1First } from '../scanner/barcodeTypes.js';

/** Classifies the leading-FNC1 evidence from a decoder's symbology identifier. */
export function leadingFnc1Info(symbologyIdentifier) {
  const code = String(symbologyIdentifier || '');
  if (hasFnc1First(code)) {
    return {
      status: 'first',
      code,
      label: 'FNC1 in first position',
      detail: `Symbology identifier ${code} (GS1 carrier). The leading FNC1 is signalled by the identifier - it is never transmitted as data.`
    };
  }
  if (/^\][A-Za-z]\d+$/.test(code)) {
    return {
      status: 'absent',
      code,
      label: 'No leading FNC1',
      detail: `Symbology identifier ${code} - the symbol was not encoded in GS1 mode (no FNC1 in the first position).`
    };
  }
  return {
    status: 'unknown',
    code: '',
    label: 'Leading FNC1 not reported',
    detail: 'This decoder did not report an ISO/IEC 15424 symbology identifier, so the leading FNC1 cannot be shown.'
  };
}

/** The truest raw content available for a decode: the byte stream when the decoder
 *  reported one (FNC1 separators preserved as ASCII 29), else the decoded text. */
export function rawContentOf(barcode) {
  const bytes = String(barcode?.rawBytes || '');
  if (bytes) return { raw: bytes, fromBytes: true };
  return { raw: String(barcode?.rawValue || ''), fromBytes: false };
}

/** Splits raw content into display segments: printable runs plus visible control-character
 *  markers. ASCII 29 (GS) renders as an FNC1 marker only in a GS1 symbol (`gs1`, proven by
 *  the symbology identifier); otherwise as a plain GS. Other control chars show their hex. */
export function rawDisplaySegments(raw, { gs1 = false } = {}) {
  const out = [];
  for (const ch of String(raw || '')) {
    const codePoint = ch.charCodeAt(0);
    const isControl = codePoint < 0x20 || codePoint === 0x7f;
    if (!isControl) {
      const last = out[out.length - 1];
      if (last && !last.ctrl) last.text += ch;
      else out.push({ ctrl: false, text: ch });
      continue;
    }
    const hex = `0x${codePoint.toString(16).toUpperCase().padStart(2, '0')}`;
    out.push(
      codePoint === 0x1d
        ? gs1
          ? { ctrl: true, text: ch, display: '⟨FNC1⟩', title: 'FNC1 group separator (ASCII 29 GS)' }
          : { ctrl: true, text: ch, display: '⟨GS⟩', title: 'Group separator (ASCII 29). Not GS1, so not an FNC1' }
        : { ctrl: true, text: ch, display: `⟨${hex}⟩`, title: `Control character ${hex}` }
    );
  }
  return out;
}

/** Plain display name from the reported symbology only - the reader never renames a
 *  symbol from its payload content the way the audit views do. */
export function readerSymbologyName(barcode) {
  const fmt = String(barcode?.format || barcode?.symbology || '').toLowerCase();
  if (fmt.includes('data')) return 'DataMatrix';
  if (fmt.includes('qr')) return 'QR Code';
  if (fmt.includes('128')) return 'Code 128';
  if (fmt.includes('pdf417') || fmt.includes('pdf_417')) return 'PDF417';
  if (fmt.includes('ean') && fmt.includes('13')) return 'EAN-13';
  if (fmt.includes('ean') && fmt.includes('8')) return 'EAN-8';
  if (fmt.includes('upc')) return 'UPC-A';
  return barcode?.format || barcode?.symbology || 'Barcode';
}

/** Every decoded raw value, one per line, for the copy-all action. */
export function readerCopyAllText(result) {
  return (result?.detectedBarcodes || [])
    .map(b => rawContentOf(b).raw)
    .filter(Boolean)
    .join('\n');
}

/** Shapes one scanned label into the reader result the report view renders. No rules run:
 *  the summary carries a READ status and a barcode count instead of pass/fail totals. */
export function buildReaderResult(data) {
  const detectedBarcodes = data?.detectedBarcodes || [];
  return {
    generatedAt: new Date().toISOString(),
    carrier: 'reader',
    fileInfo: data?.fileInfo || {},
    labelImages: data?.labelImages || {},
    detectedBarcodes,
    visualEvidence: data?.visualEvidence || null,
    scanDiagnostics: data?.scanDiagnostics || [],
    selectedAuditMode: { carrier: 'reader', labelFormat: null },
    extractedText: '',
    validations: [],
    summary: {
      overallStatus: 'READ',
      total: 0,
      passed: 0,
      failed: 0,
      manualReview: 0,
      barcodeCount: detectedBarcodes.length
    }
  };
}
