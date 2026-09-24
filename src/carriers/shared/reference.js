// Lookups over the hand-editable reference values in reference-values.json: postcode
// ranges per state, cross-border postcodes, Australia Post test MLIDs and GS1 Australia
// company prefixes. Pure and carrier-neutral, so both carrier packs and the Node tests
// share one reading of the file.
import reference from './reference-values.json' with { type: 'json' };

/** A section's "values", tolerating the "_about" help keys that sit beside them. */
const section = name => reference?.[name]?.values ?? {};

const STATE_RANGES = Object.entries(section('postcodeStates')).map(([state, ranges]) => [
  state.toUpperCase(),
  ranges.map(range => {
    const [start, end] = String(range).split('-');
    return [Number(start), Number(end ?? start)];
  })
]);

const SHARED_POSTCODES = section('sharedPostcodes');

export const TEST_MLIDS = section('testMlids').map(v => String(v).toUpperCase());
export const GS1_AUSTRALIA_PREFIXES = section('gs1AustraliaPrefixes').map(String);

/** Every state a 4-digit postcode can belong to; empty when the postcode is malformed. */
export function statesForPostcode(postcode) {
  const pc = String(postcode || '').trim();
  if (!/^\d{4}$/.test(pc)) return [];
  const n = Number(pc);
  const byRange = STATE_RANGES.filter(([, ranges]) => ranges.some(([a, b]) => n >= a && n <= b)).map(([s]) => s);
  return [...new Set([...byRange, ...(SHARED_POSTCODES[pc] || []).map(s => String(s).toUpperCase())])];
}

/** True when the postcode may carry this state, false when it can't, null when unknown. */
export function postcodeAllowsState(postcode, state) {
  const states = statesForPostcode(postcode);
  if (!states.length || !state) return null;
  return states.includes(String(state).trim().toUpperCase());
}

/** Splits a printed "SUBURB STATE 1234" line into its parts; null when it isn't one. */
export function parseSuburbLine(line) {
  const m = String(line || '')
    .trim()
    .toUpperCase()
    .match(/^(.*?)[,\s]+(ACT|NSW|NT|QLD|SA|TAS|VIC|WA)[,\s]+(\d{4})$/);
  return m
    ? { suburb: m[1].replace(/\s+/g, ' ').trim(), state: m[2], postcode: m[3], line: String(line).trim() }
    : null;
}

export function isTestMlid(mlid) {
  return TEST_MLIDS.includes(String(mlid || '').toUpperCase());
}
