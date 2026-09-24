// Audit-level regression tests for the eParcel SSCC FNC1-in-first-position rule
// (EP-SS-09): the linear SSCC barcode must be GS1-128, proven by the decoder's
// ISO/IEC 15424 symbology identifier ]C1 — mirroring StarTrack's ST-SSC-09. Also the
// DataMatrix separator (EP-DM-11) and AI 8008 (EP-DM-07) checks, read from the scanned bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditLabel, calculateEparcelCheckDigit } from '../src/auditEngine.js';

const VALID_SSCC = '00000000000000000017'; // AI 00 + 18 digits, mod-10 check digit 7

// A standard label: GS1-128 linear article plus a GS1 DataMatrix, whose captured bytes carry
// real ASCII 29 separators while the decoder's readable (HRI) text shows brackets instead.
const GS = '\x1d';
const ARTICLE_BODY = '2JD1234567' + '01' + '00093' + '03' + '0';
const ARTICLE = ARTICLE_BODY + calculateEparcelCheckDigit(ARTICLE_BODY).checkDigit;
const DM_BYTES = `0199312650999998${'91' + ARTICLE}${GS}4203000${GS}8008250601120000`;
const DM_HRI = `(01)99312650999998(91)${ARTICLE}(420)3000(8008)250601120000`;

function runEparcelDataMatrixAudit(dataMatrix) {
  return auditLabel({
    fileInfo: {},
    extractedText: '',
    labelFormat: 'standard',
    detectedBarcodes: [
      { rawValue: `0199312650999998${'91' + ARTICLE}`, format: 'code_128', symbologyIdentifier: ']C1' },
      { format: 'data_matrix', symbologyIdentifier: ']d2', ...dataMatrix }
    ]
  });
}

function runEparcelSsccAudit(detectedBarcodes) {
  return auditLabel({
    fileInfo: {},
    detectedBarcodes,
    extractedText: '',
    labelFormat: 'sscc'
  });
}

function findValidation(audit, ruleId) {
  return audit.validations.find(v => v.id === ruleId || String(v.id).startsWith(`${ruleId}_`));
}

test('EP-SS-09 passes when the decoder reports ]C1 (FNC1 in first position)', () => {
  const audit = runEparcelSsccAudit([
    { rawValue: VALID_SSCC, format: 'code_128', symbologyIdentifier: ']C1', source: 'ZXing-WASM crop scanner' }
  ]);
  const row = findValidation(audit, 'EP-SS-09');
  assert.ok(row, 'expected an EP-SS-09 validation row');
  assert.equal(row.status, 'pass');
  assert.match(row.message, /FNC1 is encoded in the first position/);
  assert.match(row.evidence, /\]C1/);
});

test('EP-SS-09 fails when the identifier shows plain Code 128 (no leading FNC1)', () => {
  const audit = runEparcelSsccAudit([
    { rawValue: VALID_SSCC, format: 'code_128', symbologyIdentifier: ']C0', source: 'ZXing-WASM crop scanner' }
  ]);
  const row = findValidation(audit, 'EP-SS-09');
  assert.equal(row.status, 'fail');
  assert.match(row.message, /does NOT start with FNC1/);
  assert.match(row.evidence, /\]C0/);
});

test('EP-SS-09 defers to manual review when no symbology identifier was reported', () => {
  const audit = runEparcelSsccAudit([{ rawValue: VALID_SSCC, format: 'code_128', source: 'Browser BarcodeDetector' }]);
  const row = findValidation(audit, 'EP-SS-09');
  assert.equal(row.status, 'manual_review');
  assert.match(row.message, /could not be verified digitally/);
});

test('EP-SS-09 never lets a DataMatrix repeat of the SSCC stand in for the linear symbol', () => {
  // Only a DataMatrix decoded: no linear SSCC exists, so EP-SS-09 has nothing to assess
  // (EP-SS-01 separately fails the missing linear scan).
  const audit = runEparcelSsccAudit([
    { rawValue: `019931265099999891${VALID_SSCC}`, format: 'data_matrix', symbologyIdentifier: ']d2' }
  ]);
  assert.equal(findValidation(audit, 'EP-SS-09'), undefined, 'no EP-SS-09 row without a linear SSCC decode');
  assert.equal(findValidation(audit, 'EP-SS-01')?.status, 'fail');
});

test('EP-DM-11 reads the scanned bytes, so a trailing FNC1 fails even when the readable text drops it', () => {
  const clean = runEparcelDataMatrixAudit({ rawValue: DM_HRI, rawBytes: DM_BYTES });
  assert.equal(findValidation(clean, 'EP-DM-11').status, 'pass');
  assert.equal(findValidation(clean, 'EP-DM-08').status, 'pass');
  const trailing = runEparcelDataMatrixAudit({ rawValue: DM_HRI, rawBytes: `${DM_BYTES}${GS}` });
  const row = findValidation(trailing, 'EP-DM-11');
  assert.equal(row.status, 'fail');
  assert.match(row.message, /doubled or trailing FNC1/);
});

test('EP-DM-07 checks AI 8008 is present, without checking the date', () => {
  assert.equal(
    findValidation(runEparcelDataMatrixAudit({ rawValue: DM_HRI, rawBytes: DM_BYTES }), 'EP-DM-07').status,
    'pass'
  );
  const impossible = DM_BYTES.replace('250601120000', '259931999999');
  assert.equal(
    findValidation(runEparcelDataMatrixAudit({ rawValue: impossible, rawBytes: impossible }), 'EP-DM-07').status,
    'pass',
    'the date itself is not checked'
  );
  const noDate = `0199312650999998${'91' + ARTICLE}${GS}4203000`;
  const row = findValidation(runEparcelDataMatrixAudit({ rawValue: noDate, rawBytes: noDate }), 'EP-DM-07');
  assert.equal(row.status, 'fail');
  assert.match(row.message, /no AI 8008/);
});
