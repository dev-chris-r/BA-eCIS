// Display segmentation is byte-true: segment texts join back to the captured raw value
// exactly, and FNC1 appears only with scan evidence - a leading marker when the symbology
// identifier proves FNC1 in the first position, a separator only where ASCII 29 was captured.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barcodeSegments, rawSegments } from '../src/report/segments.js';
import { calculateEparcelCheckDigit } from '../src/auditEngine.js';
import { isDataMatrixBarcode, isLinearBarcode } from '../src/scanner/barcodeTypes.js';

const GS = '\x1d';
const SSCC = '00000000000000000017';
const body = '2JD1234567' + '01' + '00093' + '03' + '0';
const ARTICLE = body + calculateEparcelCheckDigit(body).checkDigit;
const DM = `0199312650999998` + `91${ARTICLE}${GS}4203121${GS}9266724819${GS}8008250604201510`;

const joined = segs => segs.map(s => s.text).join('');
const labels = segs => segs.map(s => s.label);

test('SSCC map leads with an FNC1 marker only when the scan captured ]C1', () => {
  const segs = rawSegments(SSCC, 'sscc', ']C1');
  assert.deepEqual(
    { label: segs[0].label, display: segs[0].display, text: segs[0].text, ident: segs[0].ident },
    { label: 'FNC1 start', display: '⟨FNC1⟩ ]C1', text: '', ident: ']C1' }
  );
  assert.equal(segs[1].label, 'AI 00');
  assert.equal(joined(segs), SSCC, 'the marker adds nothing to the raw value');
});

test('a non-GS1 identifier on an SSCC shows as evidence, never as an FNC1', () => {
  const segs = rawSegments(SSCC, 'sscc', ']C0');
  assert.equal(segs[0].label, 'Symbology identifier');
  assert.equal(segs[0].display, ']C0');
  assert.equal(
    segs.some(s => /FNC1/.test(s.label)),
    false
  );
});

test('no identifier means no leading marker at all', () => {
  for (const kind of ['sscc', 'datamatrix', 'eparcel-linear']) {
    const value = kind === 'sscc' ? SSCC : kind === 'datamatrix' ? DM : `0199312650999998${'91' + ARTICLE}`;
    const segs = rawSegments(value, kind);
    assert.equal(
      segs.some(s => s.label === 'FNC1 start' || s.label === 'Symbology identifier'),
      false,
      kind
    );
  }
});

test('DataMatrix separators appear only where ASCII 29 was captured', () => {
  const segs = rawSegments(DM, 'datamatrix', ']d2');
  assert.equal(joined(segs), DM);
  assert.equal(segs.filter(s => s.label === 'FNC1 separator').length, 3);
  // No separator captured before 420: none is drawn.
  const missing = `0199312650999998` + `91${ARTICLE}4203121`;
  const segsMissing = rawSegments(missing, 'datamatrix', ']d2');
  assert.equal(joined(segsMissing), missing);
  assert.equal(
    segsMissing.some(s => s.label === 'FNC1 separator'),
    false
  );
  assert.ok(labels(segsMissing).includes('AI 420 postcode'), 'the AI still parses');
});

test('doubled and trailing separators show one marker per captured byte', () => {
  const doubled = DM.replace(`${GS}4203121`, `${GS}${GS}4203121`);
  assert.equal(rawSegments(doubled, 'datamatrix', ']d2').filter(s => s.label === 'FNC1 separator').length, 4);
  const trailing = `${DM}${GS}`;
  const segs = rawSegments(trailing, 'datamatrix', ']d2');
  assert.equal(segs.at(-1).label, 'FNC1 separator');
  assert.equal(joined(segs), trailing);
});

test('outside a GS1 symbol, ASCII 29 is shown as a plain GS', () => {
  const segs = rawSegments(DM, 'datamatrix', ']d1');
  assert.equal(segs[0].label, 'Symbology identifier');
  assert.equal(segs.filter(s => s.label === 'Group separator').length, 3);
  assert.equal(segs.find(s => s.label === 'Group separator').display, '⟨GS⟩');
});

test('eParcel GS1-128 linear keeps its identifier', () => {
  const linear = `0199312650999998${'91' + ARTICLE}`;
  assert.equal(rawSegments(linear, 'eparcel-linear', ']C1')[0].label, 'FNC1 start');
  assert.equal(rawSegments(linear, 'eparcel-linear', ']C0')[0].label, 'Symbology identifier');
  assert.ok(labels(rawSegments(linear, 'eparcel-linear', ']C1')).includes('MLID'));
});

test('StarTrack GS1 421 routing shows the captured FNC1 start and separator', () => {
  const raw = `4210364000${GS}403PRM`;
  const segs = rawSegments(raw, 'routing', ']C1');
  assert.deepEqual(labels(segs), [
    'FNC1 start',
    'AI 421',
    'Country code',
    'Postcode',
    'FNC1 separator',
    'AI 403',
    'Label code'
  ]);
  assert.equal(joined(segs), raw);
});

test('plain Code 128 kinds show FNC1 only when the scan captured it', () => {
  const freight = 'ABCZ12345678EXP00001';
  assert.equal(rawSegments(freight, 'freight', ']C0')[0].label, 'Despatch ID', ']C0 is normal: no marker');
  assert.equal(rawSegments(freight, 'freight', ']C1')[0].label, 'FNC1 start', 'a captured FNC1 is shown');
  assert.equal(rawSegments('PRM4807TSV', 'routing', ']C0')[0].label, 'Label code');
});

test('barcodeSegments displays the byte stream, not the decoder readable text', () => {
  const barcode = {
    rawValue: `(01)99312650999998(91)${ARTICLE}(420)3121(92)66724819(8008)250604201510`,
    rawBytes: DM,
    symbologyIdentifier: ']d2'
  };
  const segs = barcodeSegments(barcode, 'datamatrix');
  assert.equal(joined(segs), DM);
  assert.equal(
    segs.some(s => /[()]/.test(s.text)),
    false
  );
  // With no byte stream, the decoded text is shown as it is.
  assert.equal(joined(barcodeSegments({ rawValue: 'PRM4807TSV' }, 'routing')), 'PRM4807TSV');
});

test('a Code 128 whose digits contain 8008 stays a linear barcode', () => {
  const freight = { format: 'Code128', rawValue: 'ABCZ58008123EXP00001' };
  assert.equal(isDataMatrixBarcode(freight), false);
  assert.equal(isLinearBarcode(freight), true);
  assert.equal(isDataMatrixBarcode({ format: 'unknown', rawValue: `(420)3121(8008)250604201510` }), true);
});

test('values that do not parse still show every character, control characters as markers', () => {
  const odd = `ab c${GS}\x04`;
  const segs = rawSegments(odd, 'freight');
  assert.equal(joined(segs), odd);
  assert.deepEqual(
    segs.map(s => s.display || null),
    [null, '⟨GS⟩', '⟨0x04⟩']
  );
});
