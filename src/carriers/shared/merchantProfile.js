// The optional merchant profile the ECIS specialist enters before an audit: the values
// Australia Post / StarTrack issued to this merchant. With a profile, ownership checks
// (MLID, despatch ID, StarTrack accounts, SSCC ranges) become real pass/fail results
// instead of "well-formed but not verified". Pure parsing only - the UI stores the text.

/** Profile fields as the specialist types them: free text, one value per line or comma. */
export const MERCHANT_PROFILE_FIELDS = [
  { key: 'mlids', label: 'eParcel MLIDs', placeholder: 'e.g. 2JD, 1ABC2' },
  { key: 'eparcelSsccParcelPost', label: 'eParcel SSCC ranges: Parcel Post', placeholder: 'prefix, or start-end' },
  { key: 'eparcelSsccExpressPost', label: 'eParcel SSCC ranges: Express Post', placeholder: 'prefix, or start-end' },
  { key: 'despatchIds', label: 'StarTrack despatch IDs', placeholder: 'e.g. ABCZ, F2GZ' },
  { key: 'startrackAccounts', label: 'StarTrack account numbers', placeholder: 'sender or payer accounts' },
  { key: 'startrackSscc', label: 'StarTrack SSCC ranges', placeholder: 'prefix, or start-end' }
];

const splitList = text =>
  String(text || '')
    .split(/[\n,;]+/)
    .map(v => v.trim())
    .filter(Boolean);

/** An SSCC range entry: a digit prefix ("39312345") or an inclusive "start-end" pair.
 *  An optional leading AI "00" or "(00)" is ignored so pasted barcode values work. */
export function parseSsccRange(entry) {
  const clean = s =>
    String(s || '')
      .replace(/^\(00\)/, '')
      .replace(/\s+/g, '');
  const stripAi = digits => (digits.length === 20 && digits.startsWith('00') ? digits.slice(2) : digits);
  const [rawStart, rawEnd] = String(entry || '').split('-');
  const start = stripAi(clean(rawStart));
  if (!/^\d{1,18}$/.test(start)) return null;
  if (rawEnd === undefined) return { kind: 'prefix', value: start, label: start };
  const end = stripAi(clean(rawEnd));
  if (!/^\d{1,18}$/.test(end) || end.length !== start.length || end < start) return null;
  return { kind: 'range', start, end, label: `${start}-${end}` };
}

/** True when an 18-digit SSCC (AI 00 removed) sits inside a parsed range entry. */
export function ssccInRange(sscc, range) {
  const digits = String(sscc || '').replace(/\D/g, '');
  if (!range || digits.length !== 18) return false;
  if (range.kind === 'prefix') return digits.startsWith(range.value);
  const head = digits.slice(0, range.start.length);
  return head >= range.start && head <= range.end;
}

/** Normalizes the typed profile into the lists the rules read. Unparseable SSCC entries are
 *  kept aside so the UI can point them out rather than silently ignoring them. */
export function normalizeMerchantProfile(raw = {}) {
  const upper = key => splitList(raw[key]).map(v => v.toUpperCase().replace(/\s+/g, ''));
  const digitsOnly = key =>
    splitList(raw[key])
      .map(v => v.replace(/\D/g, ''))
      .filter(Boolean);
  const ranges = key => splitList(raw[key]).map(entry => ({ entry, range: parseSsccRange(entry) }));
  const profile = {
    mlids: upper('mlids'),
    despatchIds: upper('despatchIds'),
    startrackAccounts: digitsOnly('startrackAccounts'),
    eparcelSsccParcelPost: ranges('eparcelSsccParcelPost')
      .map(r => r.range)
      .filter(Boolean),
    eparcelSsccExpressPost: ranges('eparcelSsccExpressPost')
      .map(r => r.range)
      .filter(Boolean),
    startrackSscc: ranges('startrackSscc')
      .map(r => r.range)
      .filter(Boolean)
  };
  profile.invalidSsccEntries = ['eparcelSsccParcelPost', 'eparcelSsccExpressPost', 'startrackSscc'].flatMap(key =>
    ranges(key)
      .filter(r => !r.range)
      .map(r => r.entry)
  );
  profile.active = MERCHANT_PROFILE_FIELDS.some(({ key }) => profile[key].length > 0);
  return profile;
}
