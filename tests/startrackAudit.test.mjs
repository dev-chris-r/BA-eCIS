// Audit-level regression tests for the StarTrack rule outcomes that cannot be seen from a
// parser alone: the SSCC FNC1-in-first-position rule (ST-SSC-09) driven by the decoder's
// ISO/IEC 15424 symbology identifier, and the routing depot/port manual-review hold
// (ST-RTE-05) applied to every decoded routing barcode.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditLabel } from '../src/auditEngine.js';

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
