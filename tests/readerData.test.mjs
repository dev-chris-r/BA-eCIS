// Barcode Reader mode data shaping: leading-FNC1 classification from the symbology
// identifier, visible control-character segmentation of raw content, byte-stream
// preference, and the rule-free read result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReaderResult,
  leadingFnc1Info,
  rawContentOf,
  rawCopyText,
  rawDisplaySegments,
  readerCopyAllText,
  readerSymbologyName
} from '../src/report/readerData.js';

const GS = String.fromCharCode(29);

test('leadingFnc1Info classifies GS1 identifiers, non-GS1 identifiers, and missing ones', () => {
  for (const code of [']C1', ']d2', ']d5', ']Q3', ']Q4', ']e0']) {
    const info = leadingFnc1Info(code);
    assert.equal(info.status, 'first', code);
    assert.match(info.detail, /never transmitted as data/);
  }
  for (const code of [']C0', ']C2', ']d1', ']Q1']) {
    assert.equal(leadingFnc1Info(code).status, 'absent', code);
  }
  assert.equal(leadingFnc1Info('').status, 'unknown');
  assert.equal(leadingFnc1Info(undefined).status, 'unknown');
  assert.match(leadingFnc1Info('').detail, /did not report/);
});

test('rawDisplaySegments renders FNC1 separators and other control characters visibly', () => {
  const segs = rawDisplaySegments(`0094${GS}42110036${GS}`, { gs1: true });
  assert.deepEqual(
    segs.map(s => (s.ctrl ? s.display : s.text)),
    ['0094', '⟨FNC1⟩', '42110036', '⟨FNC1⟩']
  );
  // Outside a proven GS1 symbol, ASCII 29 is a plain GS, not an FNC1.
  assert.deepEqual(
    rawDisplaySegments(`0094${GS}421`).map(s => (s.ctrl ? s.display : s.text)),
    ['0094', '⟨GS⟩', '421']
  );
  // The underlying characters are preserved so copy actions stay byte-faithful.
  assert.equal(segs.map(s => s.text).join(''), `0094${GS}42110036${GS}`);
  const other = rawDisplaySegments(`AB${String.fromCharCode(28)}CD`);
  assert.equal(other[1].display, '⟨0x1C⟩');
  assert.deepEqual(rawDisplaySegments(''), []);
});

test('rawContentOf prefers the byte stream and falls back to decoded text', () => {
  const withBytes = rawContentOf({ rawValue: '(00)123', rawBytes: `00123${GS}` });
  assert.equal(withBytes.fromBytes, true);
  assert.equal(withBytes.raw, `00123${GS}`);
  const textOnly = rawContentOf({ rawValue: '(00)123' });
  assert.equal(textOnly.fromBytes, false);
  assert.equal(textOnly.raw, '(00)123');
});

test('readerSymbologyName names symbols from the reported format only', () => {
  assert.equal(readerSymbologyName({ format: 'code_128' }), 'Code 128');
  assert.equal(readerSymbologyName({ format: 'data_matrix' }), 'DataMatrix');
  assert.equal(readerSymbologyName({ format: 'qr_code' }), 'QR Code');
  assert.equal(readerSymbologyName({ format: 'ean_13' }), 'EAN-13');
  assert.equal(readerSymbologyName({ format: 'ean_8' }), 'EAN-8');
  assert.equal(readerSymbologyName({ format: 'pdf417' }), 'PDF417');
  // No payload sniffing: a Code 128 whose digits contain "8008" stays Code 128.
  assert.equal(readerSymbologyName({ format: 'code_128', rawValue: '12800800' }), 'Code 128');
});

test('buildReaderResult shapes a rule-free READ result and copy-all lists raw values', () => {
  const data = {
    fileInfo: { filename: 'x.png' },
    labelImages: { labelPreview: 'data:img' },
    detectedBarcodes: [
      { rawValue: '(00)000000000000000017', rawBytes: '00000000000000000017', format: 'code_128' },
      { rawValue: 'PRM2000MEL', format: 'code_128' }
    ],
    scanDiagnostics: [{ label: 'x' }]
  };
  const result = buildReaderResult(data);
  assert.equal(result.carrier, 'reader');
  assert.equal(result.summary.overallStatus, 'READ');
  assert.equal(result.summary.barcodeCount, 2);
  assert.deepEqual(result.validations, []);
  assert.equal(result.selectedAuditMode.carrier, 'reader');
  assert.equal(readerCopyAllText(result), '00000000000000000017\nPRM2000MEL');
});

test('rawCopyText writes each FNC1 separator as <GS>, so it survives pasting', () => {
  const dm = `0199312650999998912JD545583901000938305${GS}4203121${GS}9266724819${GS}8008250604201510`;
  assert.equal(rawCopyText(dm), '0199312650999998912JD545583901000938305<GS>4203121<GS>9266724819<GS>8008250604201510');
  assert.equal(rawCopyText('PRM4807TSV'), 'PRM4807TSV', 'values without control characters copy unchanged');
  assert.equal(rawCopyText('A\x1eB\x04\x07'), 'A<RS>B<EOT><0x07>');
  assert.equal(rawCopyText('AYR   '), 'AYR   ', 'fixed-width padding is kept');
  assert.equal(
    readerCopyAllText({ detectedBarcodes: [{ rawValue: '(01)1(420)3121', rawBytes: `011${GS}4203121` }] }),
    '011<GS>4203121'
  );
});
