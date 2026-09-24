// Verifies the barcode field breakdown metadata: every field's obligation is a known
// value and every citation resolves through the documents registry to a full document
// title (and version where the registry has one) — so the report can always show
// "position, length · obligation · document title version · page" per field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTICLE_FIELD_SPECS,
  FIELD_DOCUMENTS,
  fieldMetaText,
  fieldSpecsFor,
  QR_FIELD_SOURCE
} from '../src/report/barcodeFieldSpecs.js';

const OBLIGATIONS = new Set(['mandatory', 'conditional', 'optional']);

// Every field-spec group the UI can render, via the same selector it uses.
const GROUPS = {
  'eparcel article/GS1': fieldSpecsFor('linear', []),
  'eparcel SSCC': fieldSpecsFor('linear', [{ label: 'Extension digit' }]),
  'startrack SSCC': fieldSpecsFor('freight', [{ label: 'Extension digit' }]),
  freight: fieldSpecsFor('freight', []),
  routing: fieldSpecsFor('routing', []),
  atl: fieldSpecsFor('atl', [])
};

test('every barcode field has a valid obligation and a resolvable citation', () => {
  const problems = [];
  for (const [group, specs] of Object.entries(GROUPS)) {
    for (const [label, def] of Object.entries(specs)) {
      const where = `${group} / ${label}`;
      // The unrecognised-element fallback and the raw-data markers carry no spec metadata.
      if (['GS1 element', 'Group separator', 'Control character'].includes(label)) continue;
      if (!OBLIGATIONS.has(def.obligation)) problems.push(`${where}: obligation ${def.obligation}`);
      if (!def.source?.doc) {
        problems.push(`${where}: no source doc`);
        continue;
      }
      const documentInfo = FIELD_DOCUMENTS[def.source.doc];
      if (!documentInfo?.title) problems.push(`${where}: doc "${def.source.doc}" not in the documents registry`);
      if (!def.source.page && !def.source.ref) problems.push(`${where}: citation has neither page nor ref`);
    }
  }
  assert.deepEqual(problems, []);
});

test('fieldMetaText renders obligation plus full document title, version and page', () => {
  assert.equal(
    fieldMetaText(ARTICLE_FIELD_SPECS['Service code']),
    'Mandatory · Parcel Post and Express Post - Label & Barcode Specification v1.4 · p21'
  );
  assert.equal(
    fieldMetaText(fieldSpecsFor('linear', [])['AI 92 DPID']),
    'Conditional · Parcel Post and Express Post - Label & Barcode Specification v1.4 · p19'
  );
  assert.equal(
    fieldMetaText(fieldSpecsFor('freight', [])['Despatch ID']),
    'Mandatory · StarTrack Label Specifications - Modify Your Own System (MOS) v9 · p12'
  );
  assert.equal(fieldMetaText(null), '');
});

test('SSCC structure fields cite the carrier-appropriate SSCC section', () => {
  assert.match(fieldMetaText(GROUPS['eparcel SSCC']['Extension digit']), /Parcel Post and Express Post.*p26$/);
  assert.match(fieldMetaText(GROUPS['startrack SSCC']['Extension digit']), /StarTrack Label Specifications.*p13$/);
});

test('StarTrack QR fields share the fixed-width layout citation (MOS v9 p16)', () => {
  assert.equal(
    fieldMetaText(QR_FIELD_SOURCE),
    'StarTrack Label Specifications - Modify Your Own System (MOS) v9 · p16'
  );
});

test('field checks still behave (spot checks)', () => {
  const article = fieldSpecsFor('linear', []);
  assert.equal(article['Consignment serial'].check('1234567'), 'pass');
  assert.equal(article['Consignment serial'].check('12345'), 'fail');
  assert.equal(article['Service code'].check('03'), 'pass');
  assert.equal(article['Service code'].check('99'), 'fail');
  assert.equal(fieldSpecsFor('atl', []).Prefix.check('C'), 'pass');
  assert.equal(fieldSpecsFor('routing', [])['Label code'].check('EXP'), 'pass');
});

test('routing depot/port is held at manual review, never passed digitally', () => {
  const depot = fieldSpecsFor('routing', [])['Depot/port'];
  assert.equal(depot.check('SYD'), 'manual_review');
  assert.equal(depot.check('ME'), 'manual_review');
  assert.equal(depot.check('TOOLONG'), 'fail');
  assert.match(depot.detail('SYD'), /requires manual validation/);
  assert.match(depot.detail('SYD'), /Location Master File/);
});

test('SSCC field maps judge FNC1-in-first-position from the ]C1 identifier', () => {
  const specs = GROUPS['startrack SSCC'];
  assert.equal(specs['FNC1 start'].check(']C1'), 'pass');
  assert.match(specs['FNC1 start'].detail(']C1'), /FNC1 in the first position/);
  assert.equal(specs['Symbology identifier'].check(']C0'), 'fail', 'a non-GS1 identifier is evidence of no FNC1');
  assert.match(specs['Symbology identifier'].detail(']C0'), /not GS1-128/);
  assert.match(fieldMetaText(specs['FNC1 start']), /StarTrack Label Specifications.*p13$/);
  assert.match(fieldMetaText(GROUPS['eparcel SSCC']['FNC1 start']), /Parcel Post and Express Post.*p26$/);
});

test('FNC1 separator rows pass only on a captured ASCII 29', () => {
  const specs = GROUPS['eparcel article/GS1'];
  assert.equal(specs['FNC1 separator'].check('\x1d'), 'pass');
  assert.equal(specs['FNC1 separator'].check(''), null);
  assert.equal(specs['Symbology identifier'].check(']d1'), 'fail');
  assert.equal(GROUPS.routing['FNC1 start'].check(']C1', { joined: '4210364000\x1d403PRM' }), 'pass');
  assert.equal(GROUPS.routing['FNC1 start'].check(']C1', { joined: 'PRM4807TSV' }), null, 'no verdict off GS1 routing');
});

test('article check-digit drawer shows the full weighted-sum working', () => {
  const detail = ARTICLE_FIELD_SPECS['Check digit'].detail('5', { article: '2JD545583901000938305' });
  assert.match(detail, /^expected 5 /);
  assert.match(detail, /Converted=/);
  assert.match(detail, /sum=175/);
});

test('SSCC check-digit drawer shows the full mod-10 working (spec p26 example)', () => {
  const specs = fieldSpecsFor('eparcel-linear-sscc', [{ label: 'Extension digit' }]);
  const detail = specs['Check digit'].detail('9', { joined: '00123456789123456789' });
  assert.match(detail, /^expected 9 /);
  assert.match(detail, /= 171;/);
  assert.match(detail, /mod 10 = 9$/);
});
