// Pure lookups behind the reference-data, merchant-profile and Location Master File checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTestMlid,
  parseSuburbLine,
  postcodeAllowsState,
  statesForPostcode
} from '../src/carriers/shared/reference.js';
import { normalizeMerchantProfile, parseSsccRange, ssccInRange } from '../src/carriers/shared/merchantProfile.js';
import { metroLocation } from '../src/carriers/eparcel/metro/area.js';
import { findLocation, parseLocationMasterFile } from '../src/carriers/startrack/formats/locationMasterFile.js';

test('postcode ranges fix the state, with shared border postcodes allowed both ways', () => {
  assert.deepEqual(statesForPostcode('3013'), ['VIC']);
  assert.equal(postcodeAllowsState('3013', 'VIC'), true);
  assert.equal(postcodeAllowsState('3013', 'NSW'), false);
  assert.equal(postcodeAllowsState('2600', 'ACT'), true);
  assert.equal(postcodeAllowsState('3644', 'NSW'), true, 'Barooga NSW shares 3644 with Cobram VIC');
  assert.equal(postcodeAllowsState('0872', 'WA'), true);
  assert.equal(postcodeAllowsState('ABCD', 'VIC'), null, 'malformed postcodes are unknown, never a mismatch');
});

test('parseSuburbLine splits a printed suburb line', () => {
  assert.deepEqual(
    { ...parseSuburbLine('Yarraville VIC 3013'), line: undefined },
    { suburb: 'YARRAVILLE', state: 'VIC', postcode: '3013', line: undefined }
  );
  assert.equal(parseSuburbLine('1 Test Street'), null);
});

test('test MLIDs come from reference-values.json', () => {
  assert.equal(isTestMlid('JDQ'), true);
  assert.equal(isTestMlid('1jdq1'), true);
  assert.equal(isTestMlid('2JD'), false);
});

test('SSCC ranges accept a prefix or a start-end pair, ignoring a pasted AI 00', () => {
  assert.deepEqual(parseSsccRange('393123'), { kind: 'prefix', value: '393123', label: '393123' });
  const range = parseSsccRange('393123450000000000-393123450000999999');
  assert.equal(range.kind, 'range');
  assert.equal(ssccInRange('393123450000012345', range), true);
  assert.equal(ssccInRange('393123450001000000', range), false);
  assert.equal(parseSsccRange('00393123450000000000').value, '393123450000000000', 'leading AI 00 is dropped');
  assert.equal(parseSsccRange('39-1'), null, 'mismatched range ends are rejected');
  assert.equal(parseSsccRange('abc'), null);
});

test('normalizeMerchantProfile splits lists and flags bad SSCC entries', () => {
  const p = normalizeMerchantProfile({
    mlids: 'jdq, 2JD\n',
    startrackAccounts: '1234 5678',
    startrackSscc: '3931\nnope'
  });
  assert.deepEqual(p.mlids, ['JDQ', '2JD']);
  assert.deepEqual(p.startrackAccounts, ['12345678']);
  assert.equal(p.startrackSscc.length, 1);
  assert.deepEqual(p.invalidSsccEntries, ['nope']);
  assert.equal(p.active, true);
  assert.equal(normalizeMerchantProfile({}).active, false);
});

test('metroLocation places postcodes and suburbs against the Metro area', () => {
  const cbd = metroLocation('3000', 'Melbourne');
  assert.equal(cbd.inArea, true);
  assert.equal(cbd.city, 'MEL');
  assert.equal(cbd.suburbListed, true);
  assert.equal(metroLocation('3000', 'NOWHERE').suburbListed, false);
  assert.equal(metroLocation('3000').suburbListed, null, 'no suburb means a postcode-only check');
  assert.equal(metroLocation('3350', 'BALLARAT').inArea, false, 'Ballarat is outside Metro');
  assert.equal(metroLocation('3220', 'GEELONG').city, 'MEL', 'the spec puts Geelong inside the Melbourne Metro zone');
});

/** One fixed-width LOCATIONS.DAT record per MOS v9 pages 8-9. */
function lmfRecord({ postcode, depot, suburb, state, primary, secondary }) {
  return `${postcode}${depot.padEnd(3)}${suburb.padEnd(30)}${state}${'MEL'}${'Z01'}${'Z02'}${'AG01'}${primary.padEnd(3)}${secondary.padEnd(3)}NNN0101`;
}

test('parseLocationMasterFile reads fixed-width records and finds suburb + postcode', () => {
  const text = [
    lmfRecord({ postcode: '3000', depot: 'MEL', suburb: 'MELBOURNE', state: '3', primary: 'MEP', secondary: 'MES' }),
    lmfRecord({
      postcode: '3000',
      depot: 'MEL',
      suburb: 'MELBOURNE UNIVERSITY',
      state: '3',
      primary: 'MEP',
      secondary: 'MES'
    }),
    'short line'
  ].join('\r\n');
  const lmf = parseLocationMasterFile(text);
  assert.equal(lmf.recordCount, 2);
  assert.equal(lmf.malformed, 1);
  const { match, candidates } = findLocation(lmf, '3000', 'Melbourne');
  assert.equal(candidates.length, 2);
  assert.equal(match.nearestDepot, 'MEL');
  assert.equal(match.primaryPort, 'MEP');
  assert.equal(match.secondaryPort, 'MES');
  assert.equal(match.state, 'VIC');
  assert.equal(findLocation(lmf, '3000', '').match, null, 'two suburbs share 3000, so no suburb means no match');
});
