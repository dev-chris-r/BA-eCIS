// Metro service-area lookups over metro-localities.json (from the Metro V2.0 spec's
// postcode spreadsheet). Metro only runs within one city, between listed localities.
import metro from './metro-localities.json' with { type: 'json' };

const normalizeSuburb = s =>
  String(s || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

// postcode -> [{ city, cityName, suburbs: Set }]
const INDEX = new Map();
for (const [city, { name, localities }] of Object.entries(metro.cities || {})) {
  for (const [postcode, suburbs] of Object.entries(localities || {})) {
    if (!INDEX.has(postcode)) INDEX.set(postcode, []);
    INDEX.get(postcode).push({ city, cityName: name, suburbs: new Set(suburbs.map(normalizeSuburb)) });
  }
}

/**
 * Where a postcode (and suburb, when known) sits against the Metro area:
 * - inArea false: the postcode has no Metro locality at all
 * - suburbListed false: the postcode is Metro, but not for this suburb (or a misspelling)
 * - suburbListed null: the suburb wasn't available, so only the postcode was checked
 */
export function metroLocation(postcode, suburb) {
  const pc = String(postcode || '').trim();
  const entries = INDEX.get(pc) || [];
  if (!entries.length) return { postcode: pc, suburb: suburb || null, inArea: false, city: null, cityName: null };
  const wanted = normalizeSuburb(suburb);
  const exact = wanted ? entries.find(e => e.suburbs.has(wanted)) : null;
  const hit = exact || entries[0];
  return {
    postcode: pc,
    suburb: suburb || null,
    inArea: true,
    city: hit.city,
    cityName: hit.cityName,
    suburbListed: wanted ? Boolean(exact) : null,
    listedSuburbs: [...hit.suburbs].slice(0, 6)
  };
}
