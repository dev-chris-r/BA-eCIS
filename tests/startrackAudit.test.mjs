// Audit-level regression tests for the StarTrack rule outcomes that cannot be seen from a
// parser alone: the SSCC FNC1-in-first-position rule (ST-SSC-09) driven by the decoder's
// ISO/IEC 15424 symbology identifier, the routing depot/port manual-review hold
// (ST-RTE-05) applied to every decoded routing barcode, APT's Special Services rule set,
// and the ST-HDR-06 review status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditLabel, STARTRACK_QR_FIELDS } from '../src/auditEngine.js';

/** A fixed-width StarTrack QR payload with sensible defaults. */
function qrPayload(over = {}) {
  const v = {
    receiverSuburb: 'MELBOURNE',
    receiverPostcode: '3000',
    connoteNumber: 'ABCZ12345678',
    freightItemNumber: 'ABCZ12345678EXP00001',
    productCode: 'EXP',
    senderAccount: '12345678',
    consignmentQuantity: '1',
    consignmentWeight: '3',
    consignmentCube: '10',
    despatchDate: '20260901',
    receiverName1: 'JANE CITIZEN',
    unitType: 'CTN',
    destinationDepot: 'MEL',
    receiverAddress1: '1 TEST ST',
    dangerousGoodsIndicator: 'N',
    movementTypeIndicator: 'N',
    ...over
  };
  return STARTRACK_QR_FIELDS.map(f =>
    String(v[f.key] || '')
      .padEnd(f.len)
      .slice(0, f.len)
  ).join('');
}

function runStandardLabel({ qr = {}, freight = 'ABCZ12345678EXP00001', routing = 'EXP3000MEL' } = {}) {
  return auditLabel({
    labelFamily: 'startrack',
    fileInfo: {},
    labelFormat: 'standard',
    extractedText: '',
    detectedBarcodes: [
      { rawValue: qrPayload(qr), format: 'qr_code' },
      { rawValue: freight, format: 'code_128' },
      { rawValue: routing, format: 'code_128' }
    ]
  });
}

const VALID_SSCC = '00000000000000000017'; // AI 00 + 18 digits, mod-10 check digit 7

function runStarTrackAudit(detectedBarcodes, labelFormat = 'sscc') {
  return auditLabel({
    labelFamily: 'startrack',
    fileInfo: {},
    detectedBarcodes,
    extractedText: '',
    labelFormat
  });
}

function findValidation(audit, ruleId) {
  return audit.validations.find(v => v.id === ruleId || String(v.id).startsWith(`${ruleId}_`));
}

test('ST-SSC-09 passes when the decoder reports ]C1 (FNC1 in first position)', () => {
  const audit = runStarTrackAudit([
    { rawValue: VALID_SSCC, format: 'code_128', symbologyIdentifier: ']C1', source: 'ZXing-WASM crop scanner' }
  ]);
  const row = findValidation(audit, 'ST-SSC-09');
  assert.ok(row, 'expected an ST-SSC-09 validation row');
  assert.equal(row.status, 'pass');
  assert.match(row.message, /FNC1 is encoded in the first position/);
  assert.equal(audit.startrack.ssccParses[0].fnc1FirstPosition, true);
  assert.equal(audit.startrack.ssccParses[0].symbologyIdentifier, ']C1');
});

test('an SSCC label audited as SSCC passes the format mode check (no phantom freight item)', () => {
  const audit = runStarTrackAudit([{ rawValue: VALID_SSCC, format: 'code_128', symbologyIdentifier: ']C1' }]);
  assert.equal(audit.startrack.freightParses.length, 0, 'the all-digit SSCC must not classify as a freight item');
  assert.equal(findValidation(audit, 'AUDIT_MODE_FORMAT')?.status, 'pass');
});

test('an SSCC failing its check digit still detects as SSCC format; the check-digit rule fails', () => {
  const audit = runStarTrackAudit([{ rawValue: '00000000000000000018', format: 'code_128' }]);
  assert.equal(findValidation(audit, 'AUDIT_MODE_FORMAT')?.status, 'pass');
  assert.equal(findValidation(audit, 'AUDIT_MODE_FORMAT')?.evidence.includes('failing their check digit'), true);
  assert.equal(findValidation(audit, 'ST-SSC-02')?.status, 'fail');
});

test('ST-SSC-09 fails when the identifier shows plain Code 128 (no leading FNC1)', () => {
  const audit = runStarTrackAudit([
    { rawValue: VALID_SSCC, format: 'code_128', symbologyIdentifier: ']C0', source: 'ZXing-WASM crop scanner' }
  ]);
  const row = findValidation(audit, 'ST-SSC-09');
  assert.equal(row.status, 'fail');
  assert.match(row.message, /does NOT start with FNC1/);
  assert.match(row.evidence, /\]C0/);
});

test('ST-SSC-09 defers to manual review when no symbology identifier was reported', () => {
  const audit = runStarTrackAudit([{ rawValue: VALID_SSCC, format: 'code_128', source: 'Browser BarcodeDetector' }]);
  const row = findValidation(audit, 'ST-SSC-09');
  assert.equal(row.status, 'manual_review');
  assert.match(row.message, /could not be verified digitally/);
});

test('ST-RTE-05 holds every decoded routing barcode at manual review with a depot/port note', () => {
  const audit = runStarTrackAudit(
    [
      { rawValue: 'ABCD12345678EXP00001', format: 'code_128' },
      { rawValue: 'EXP2000SYD', format: 'code_128' },
      { rawValue: '4210362000403EXP', format: 'code_128' }
    ],
    'standard'
  );
  const rows = audit.validations.filter(v => String(v.id).startsWith('ST-RTE-05'));
  assert.equal(rows.length, 2, 'one review row per decoded routing barcode');
  for (const row of rows) {
    assert.equal(row.status, 'manual_review');
    assert.match(row.message, /Location Master File/);
  }
  const standardRow = rows.find(r => /Depot SYD is well-formed/.test(r.message));
  assert.ok(standardRow, 'SSS9999DD routing names its decoded depot/port');
  const gs1Row = rows.find(r => /GS1 421 routing barcode has no depot/.test(r.message));
  assert.ok(gs1Row, 'GS1 421 routing points the review at the QR destination depot');
  assert.notEqual(audit.summary.overallStatus, 'PASS', 'routing audits can no longer end in a clean PASS');
});

test('APT runs the Express and Special Services checks, as MOS v9 lists it', () => {
  const audit = runStandardLabel({
    qr: { productCode: 'APT', freightItemNumber: 'ABCZ12345678APT00001' },
    freight: 'ABCZ12345678APT00001',
    routing: 'APT3000MEL'
  });
  assert.equal(audit.ruleSet.variant, 'express');
  assert.equal(findValidation(audit, 'ST-PRD-01').status, 'pass');
  assert.ok(findValidation(audit, 'ST-LOC-02'), 'the Nearest Depot location row applies');
  assert.equal(findValidation(audit, 'ST-LOC-01'), undefined, 'no Premium port row');
});

test('ST-HDR-06 sends a missing *RETURN* marker to review rather than failing the label', () => {
  const row = findValidation(runStandardLabel({ qr: { movementTypeIndicator: 'C' } }), 'ST-HDR-06');
  assert.equal(row.status, 'manual_review');
  assert.match(row.message, /\*RETURN\* or \*TRANSFER\* wasn't found/);
});
