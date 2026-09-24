// Audit-level tests for the merchant profile, the embedded reference data (postcode
// states, Metro area, test MLIDs, GS1 Australia prefixes) and the StarTrack Location
// Master File checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditLabel, calculateEparcelCheckDigit, STARTRACK_QR_FIELDS } from '../src/auditEngine.js';
import { parseLocationMasterFile } from '../src/carriers/startrack/formats/locationMasterFile.js';
import { gs1Mod10CheckDigit } from '../src/carriers/formats/gs1.js';

const GS = String.fromCharCode(29);
/** An 18-digit SSCC with a valid GS1 check digit, from its first 17 digits. */
const withCheck = body17 => body17 + gs1Mod10CheckDigit(body17);
const rows = (audit, id) => audit.validations.filter(v => v.id === id || String(v.id).startsWith(`${id}_`));
const one = (audit, id) => rows(audit, id)[0];

// ---- eParcel -------------------------------------------------------------------------

function eparcelLabel({
  mlid = '2JD',
  product = '00093',
  service = '03',
  postcode = '3000',
  text = '',
  profile = null
}) {
  const body = `${mlid}1234567` + `01${product}${service}0`;
  const article = body + calculateEparcelCheckDigit(body).checkDigit;
  return auditLabel({
    fileInfo: {},
    labelFormat: 'standard',
    extractedText: text,
    merchantProfile: profile,
    detectedBarcodes: [
      { rawValue: `019931265099999891${article}`, format: 'code_128', symbologyIdentifier: ']C1' },
      {
        rawValue: `019931265099999891${article}${GS}420${postcode}${GS}8008250601120000`,
        format: 'data_matrix',
        symbologyIdentifier: ']d2'
      }
    ]
  });
}

const ADDRESSES = (to, from) =>
  ['Deliver To', 'JANE CITIZEN', '1 TEST ST', to, 'From', 'ACME PTY LTD', '2 SHOP RD', from].join('\n');

test('EP-ART-09 notes a test MLID without changing the verdict', () => {
  const row = one(eparcelLabel({ mlid: 'JDQ' }), 'EP-ART-09');
  assert.equal(row.status, 'info');
  assert.match(row.message, /test MLID/);
  assert.equal(one(eparcelLabel({ mlid: '2JD' }), 'EP-ART-09').status, 'pass');
});

test('EP-MER-01 checks the MLID against the merchant profile only when one is entered', () => {
  assert.equal(one(eparcelLabel({}), 'EP-MER-01'), undefined, 'no profile, no row');
  assert.equal(one(eparcelLabel({ profile: { mlids: '2JD' } }), 'EP-MER-01').status, 'pass');
  const fail = one(eparcelLabel({ profile: { mlids: 'ABC, 1ABC2' } }), 'EP-MER-01');
  assert.equal(fail.status, 'fail');
  assert.match(fail.message, /isn't in the merchant profile/);
});

test('EP-TO-09 catches a DataMatrix carrying the sender postcode', () => {
  const audit = eparcelLabel({ postcode: '2000', text: ADDRESSES('MELBOURNE VIC 3000', 'SYDNEY NSW 2000') });
  assert.equal(one(audit, 'EP-TO-08').status, 'pass', 'the old check matches any printed postcode');
  const row = one(audit, 'EP-TO-09');
  assert.equal(row.status, 'warning');
  assert.match(row.message, /NSW postcode, but the delivery address is in VIC/);
});

test('EP-ADR-01 warns when a printed postcode belongs to another state', () => {
  const audit = eparcelLabel({ postcode: '3013', text: ADDRESSES('YARRAVILLE NSW 3013', 'SYDNEY NSW 2000') });
  const row = one(audit, 'EP-ADR-01');
  assert.equal(row.status, 'warning');
  assert.match(row.message, /3013 is a VIC postcode/);
});

test('Metro: EP-MET-07 warns out of area and EP-MET-08 warns across cities', () => {
  const inArea = eparcelLabel({
    product: '00121',
    service: '09',
    postcode: '3000',
    text: ADDRESSES('MELBOURNE VIC 3000', 'SYDNEY NSW 2000')
  });
  assert.equal(one(inArea, 'EP-MET-07').status, 'pass');
  const cities = one(inArea, 'EP-MET-08');
  assert.equal(cities.status, 'warning');
  assert.match(cities.message, /sender is in Sydney but the delivery is in Melbourne/);

  const outside = eparcelLabel({
    product: '00121',
    service: '09',
    postcode: '3350',
    text: ADDRESSES('BALLARAT VIC 3350', 'MELBOURNE VIC 3000')
  });
  const row = one(outside, 'EP-MET-07');
  assert.equal(row.status, 'warning');
  assert.match(row.message, /outside the Metro area/);
});

test('eParcel SSCC: profile ranges decide EP-MER-02; without them EP-SS-10 is a note', () => {
  const sscc = withCheck('39312345000000001');
  const run = (profile, text = '') =>
    auditLabel({
      fileInfo: {},
      labelFormat: 'sscc',
      extractedText: text,
      merchantProfile: profile,
      detectedBarcodes: [{ rawValue: `00${sscc}`, format: 'code_128', symbologyIdentifier: ']C1' }]
    });
  const bare = run(null);
  assert.equal(one(bare, 'EP-MER-02'), undefined);
  assert.equal(one(bare, 'EP-SS-10').status, 'pass');
  assert.equal(one(run({ eparcelSsccParcelPost: '39312345' }), 'EP-MER-02').status, 'pass');
  const wrongProduct = one(run({ eparcelSsccParcelPost: '39312345' }, 'EXPRESS POST'), 'EP-MER-02');
  assert.equal(wrongProduct.status, 'fail');
  assert.match(wrongProduct.message, /Express Post label, but SSCC .* is in the Parcel Post range/);
  assert.equal(one(run({ eparcelSsccExpressPost: '49' }), 'EP-MER-02').status, 'fail');
});

// ---- StarTrack -----------------------------------------------------------------------

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

const lmfRecord = ({ postcode, depot, suburb, primary, secondary }) =>
  `${postcode}${depot.padEnd(3)}${suburb.padEnd(30)}3MELZ01Z02AG01${primary.padEnd(3)}${secondary.padEnd(3)}NNN0101`;
const LMF = parseLocationMasterFile(
  [lmfRecord({ postcode: '3000', depot: 'MEL', suburb: 'MELBOURNE', primary: 'MEP', secondary: 'MES' })].join('\n')
);

function startrackLabel({
  qr = {},
  freight = 'ABCZ12345678EXP00001',
  routing = 'EXP3000MEL',
  profile = null,
  lmf = null,
  text = ''
}) {
  return auditLabel({
    labelFamily: 'startrack',
    fileInfo: {},
    labelFormat: 'standard',
    extractedText: text,
    merchantProfile: profile,
    locationMasterFile: lmf,
    detectedBarcodes: [
      { rawValue: qrPayload(qr), format: 'qr_code' },
      { rawValue: freight, format: 'code_128' },
      { rawValue: routing, format: 'code_128' }
    ]
  });
}

test('ST-MER-01 checks every despatch ID against the profile', () => {
  assert.equal(one(startrackLabel({}), 'ST-MER-01'), undefined);
  assert.equal(one(startrackLabel({ profile: { despatchIds: 'abcz' } }), 'ST-MER-01').status, 'pass');
  const fail = one(startrackLabel({ profile: { despatchIds: 'F2GZ' } }), 'ST-MER-01');
  assert.equal(fail.status, 'fail');
  assert.match(fail.message, /Despatch ID ABCZ isn't in the merchant profile/);
});

test('ST-MER-02 fails a foreign sender account; ST-MER-03 only reviews a foreign payer', () => {
  const audit = startrackLabel({ qr: { payerAccount: '99999999' }, profile: { startrackAccounts: '87654321' } });
  assert.equal(one(audit, 'ST-MER-02').status, 'fail');
  assert.equal(one(audit, 'ST-MER-03').status, 'manual_review');
  assert.equal(one(startrackLabel({ profile: { startrackAccounts: '1234-5678' } }), 'ST-MER-02').status, 'pass');
});

test('Location Master File: matching depots pass and replace the depot review row', () => {
  const audit = startrackLabel({ lmf: LMF });
  assert.equal(one(audit, 'ST-LMF-01').status, 'pass');
  assert.equal(one(audit, 'ST-LMF-02').status, 'pass');
  assert.equal(one(audit, 'ST-LMF-03').status, 'pass');
  assert.equal(rows(audit, 'ST-RTE-05').length, 0, 'the manual depot review steps aside once the file validates');
  assert.equal(audit.locationMasterFileLoaded, true);
});

test('Location Master File: wrong routing depot fails; Premium uses the ports', () => {
  const wrong = one(startrackLabel({ routing: 'EXP3000SYD', lmf: LMF }), 'ST-LMF-02');
  assert.equal(wrong.status, 'fail');
  assert.match(wrong.message, /Routing depot SYD should be MEL, the Location Master File Nearest Depot/);

  const premium = startrackLabel({
    qr: { productCode: 'PRM', freightItemNumber: 'ABCZ12345678PRM00001', destinationDepot: 'MES' },
    freight: 'ABCZ12345678PRM00001',
    routing: 'PRM3000MEP',
    lmf: LMF
  });
  assert.equal(one(premium, 'ST-LMF-02').status, 'pass', 'Premium routing depot is the Primary Port');
  assert.equal(one(premium, 'ST-LMF-03').status, 'pass', 'Premium QR depot is the Secondary Port');
});

test('Location Master File: an unknown delivery location warns', () => {
  const audit = startrackLabel({ qr: { receiverSuburb: 'NOWHERE', receiverPostcode: '3000' }, lmf: LMF });
  const row = one(audit, 'ST-LMF-01');
  assert.equal(row.status, 'warning');
  assert.match(row.message, /NOWHERE isn't listed for postcode 3000/);
  const outside = one(
    startrackLabel({ qr: { receiverPostcode: '3999' }, routing: 'EXP3999MEL', lmf: LMF }),
    'ST-LMF-01'
  );
  assert.equal(outside.status, 'warning');
  assert.match(outside.message, /isn't in the Location Master File/);
});

test('ST-ADR-01 warns on a printed postcode from another state', () => {
  const row = one(startrackLabel({ text: 'JANE CITIZEN\nMELBOURNE NSW 3000' }), 'ST-ADR-01');
  assert.equal(row.status, 'warning');
});

test('StarTrack SSCC: profile ranges decide ST-MER-04; otherwise ST-SSC-10 is a note', () => {
  const run = profile =>
    auditLabel({
      labelFamily: 'startrack',
      fileInfo: {},
      labelFormat: 'sscc',
      extractedText: '',
      merchantProfile: profile,
      detectedBarcodes: [
        { rawValue: `00${withCheck('06141411234567890')}`, format: 'code_128', symbologyIdentifier: ']C1' }
      ]
    });
  const note = one(run(null), 'ST-SSC-10');
  assert.equal(note.status, 'info', 'a non-93 prefix is a note, not a warning');
  assert.equal(one(run({ startrackSscc: '0614141' }), 'ST-MER-04').status, 'pass');
  assert.equal(one(run({ startrackSscc: '0999' }), 'ST-MER-04').status, 'fail');
});
