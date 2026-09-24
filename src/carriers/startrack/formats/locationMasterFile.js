// The StarTrack Location Master File (LOCATIONS.DAT, MOS v9 pages 8-9): fixed-width
// records StarTrack issues per despatch site. It holds the values a label must repeat -
// Nearest Depot for Express, Primary and Secondary Port for Premium - so loading it turns
// "well-formed but not verified" depot checks into real pass/fail results.

const STATE_CODES = { 0: 'NT', 2: 'NSW', 3: 'VIC', 4: 'QLD', 5: 'SA', 6: 'WA', 7: 'TAS', A: 'ACT', 9: 'INTL' };

export const normalizeLmfSuburb = s =>
  String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

/** Parses LOCATIONS.DAT text. Each record needs at least the 57 characters up to the
 *  Secondary Port field; anything shorter, or not starting with a postcode, is counted
 *  as malformed rather than guessed at. */
export function parseLocationMasterFile(text) {
  const records = [];
  let malformed = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.length < 57 || !/^\d{4}/.test(line)) {
      malformed += 1;
      continue;
    }
    const field = (pos, len) => line.slice(pos - 1, pos - 1 + len).trim();
    records.push({
      postcode: field(1, 4),
      nearestDepot: field(5, 3).toUpperCase(),
      suburb: field(8, 30).toUpperCase(),
      state: STATE_CODES[field(38, 1).toUpperCase()] || field(38, 1),
      primaryPort: field(52, 3).toUpperCase(),
      secondaryPort: field(55, 3).toUpperCase()
    });
  }
  const byPostcode = new Map();
  for (const record of records) {
    if (!byPostcode.has(record.postcode)) byPostcode.set(record.postcode, []);
    byPostcode.get(record.postcode).push(record);
  }
  return { recordCount: records.length, malformed, byPostcode };
}

/** Finds the LMF record for a delivery postcode + suburb. Suburb and postcode together are
 *  the file's key; with no suburb, a postcode that maps to one record is still a match. */
export function findLocation(lmf, postcode, suburb) {
  const candidates = lmf?.byPostcode?.get(String(postcode || '').trim()) || [];
  const wanted = normalizeLmfSuburb(suburb);
  const match = wanted
    ? candidates.find(r => normalizeLmfSuburb(r.suburb) === wanted) || null
    : candidates.length === 1
      ? candidates[0]
      : null;
  return { candidates, match };
}
