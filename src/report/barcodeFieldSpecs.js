// Per-field specifications for the barcode breakdown tables. Display-only: statuses
// re-use the same reference maps and check-digit functions the rule engine validates with
// (PRODUCT/SERVICE maps, calculateEparcelCheckDigit, parseSsccBarcode, STARTRACK maps);
// no new validation logic is introduced here. Keyed by the rawSegments field label.
//
// Each field also carries its spec obligation and citation ({ doc, page/ref }), resolved
// against the same `documents` registry the rules use, so the breakdown line reads e.g.
// "position 12, length 2 · Mandatory · Parcel Post and Express Post - Label & Barcode
// Specification v1.4 · p21". Kept out of the JSX so Node tests can verify every citation.
import {
  calculateEparcelCheckDigit,
  parseSsccBarcode,
  PRODUCT_CODE_MAP,
  SERVICE_CODE_MAP,
  STARTRACK_LABEL_CODE_MAP,
  STARTRACK_PRODUCT_CODE_MAP
} from '../auditEngine.js';
import { resolveRuleSource } from '../ruleEngine.js';
import { getRuleSet } from '../carriers/index.js';
import { formatRuleSource } from './ruleSource.js';
import { leadingFnc1Info } from './readerData.js';

// Short document keys into FIELD_DOCUMENTS below; citations resolve them to full spec titles.
const EP_SPEC = 'PP&EP v1.4';
const ST_SPEC = 'MOS v9';

/** Same registry the rules cite, so field and rule citations can never disagree. */
export const FIELD_DOCUMENTS = {
  ...getRuleSet('eparcel', 'base').documents,
  ...getRuleSet('startrack', 'base').documents
};

const OBLIGATION_LABEL = { mandatory: 'Mandatory', conditional: 'Conditional', optional: 'Optional' };

/** Obligation + spec citation for one field: cite('mandatory', EP_SPEC, 17) or cite(..., null, '4.001'). */
const cite = (obligation, doc, page, ref) => ({
  obligation,
  source: { doc, ...(page ? { page } : {}), ...(ref ? { ref } : {}) }
});

/** "Mandatory · <full document title> <version> · p<page>" for a field definition. */
export function fieldMetaText(def) {
  if (!def?.obligation && !def?.source) return '';
  return [
    def.obligation ? OBLIGATION_LABEL[def.obligation] || def.obligation : '',
    def.source ? formatRuleSource(resolveRuleSource({ source: def.source }, { documents: FIELD_DOCUMENTS })) : ''
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Citation shared by every StarTrack QR field: the fixed-width layout table (MOS v9 p16). */
export const QR_FIELD_SOURCE = { source: { doc: ST_SPEC, page: 16 } };

/** Field spec shape: display string, status check(text, ctx), optional detail text, citation meta. */
const pf = (spec, check, detail, meta) => ({ spec, check, detail, ...meta });
const digitsCheck = n => t => (new RegExp(`^\\d{${n}}$`).test(t) ? 'pass' : 'fail');
const literalCheck = lit => t => (t === lit ? 'pass' : 'fail');

export const ARTICLE_FIELD_SPECS = {
  MLID: pf(
    'Merchant location ID — 3 or 5 alphanumeric',
    t => (/^[A-Z0-9]{3}$|^[A-Z0-9]{5}$/i.test(t) ? 'pass' : 'fail'),
    null,
    cite('mandatory', EP_SPEC, 6)
  ),
  'Consignment serial': pf('Consignment serial — 7 digits', digitsCheck(7), null, cite('mandatory', EP_SPEC, 6)),
  'Article count': pf(
    'Article number within consignment — 2 digits',
    digitsCheck(2),
    null,
    cite('mandatory', EP_SPEC, 6)
  ),
  'Product code': pf(
    '5-digit eParcel product code',
    t => (PRODUCT_CODE_MAP[t] ? 'pass' : 'fail'),
    t => PRODUCT_CODE_MAP[t] || 'not in the eParcel product map',
    cite('mandatory', EP_SPEC, 21)
  ),
  'Service code': pf(
    '2-digit eParcel service code',
    t => (SERVICE_CODE_MAP[t] ? 'pass' : 'fail'),
    t => SERVICE_CODE_MAP[t]?.name || 'not in the eParcel service map',
    cite('mandatory', EP_SPEC, 21)
  ),
  'Postage paid': pf('Postage paid indicator — 1 character', null, null, cite('mandatory', EP_SPEC, 17)),
  'Check digit': pf(
    'Weighted mod-10 check digit over the preceding characters',
    (t, ctx) => {
      const calc = calculateEparcelCheckDigit(String(ctx.article || '').slice(0, -1));
      return calc.validInput ? (calc.checkDigit === t ? 'pass' : 'fail') : null;
    },
    // The drawer shows the full working (conversion, weighted terms, sum) so a reviewer
    // can verify the expected digit by hand.
    (t, ctx) => {
      const calc = calculateEparcelCheckDigit(String(ctx.article || '').slice(0, -1));
      return calc.validInput ? `expected ${calc.checkDigit} · ${calc.steps}` : '';
    },
    cite('mandatory', EP_SPEC, 22)
  )
};

/** Human-readable GS1 mod-10 working for the check-digit drawer: each digit×weight term,
 *  the weighted sum, and the final subtraction that yields the expected digit. */
function gs1Mod10Steps(body) {
  const digits = String(body || '').replace(/\D/g, '');
  if (!digits) return '';
  const terms = [];
  let sum = 0;
  let weight = 3;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    sum += Number(digits[i]) * weight;
    terms.unshift(`${digits[i]}×${weight}`);
    weight = weight === 3 ? 1 : 3;
  }
  return `${terms.join(' + ')} = ${sum}; (10 − ${sum % 10}) mod 10 = ${(10 - (sum % 10)) % 10}`;
}

// Re-parse the full SSCC from the joined segments, tolerating a decode that dropped the AI 00 prefix.
const ssccFromContext = ctx => parseSsccBarcode(ctx.joined.length === 18 ? `00${ctx.joined}` : ctx.joined);

/** SSCC (GS1 serial shipping container code) structure fields. The citation is carrier-aware:
 *  StarTrack freight decodes cite the MOS SSCC section (p13), everything else the Parcel Post
 *  SSCC section (p26). */
const ssccFieldSpecs = kind => {
  const src = kind === 'freight' ? cite('mandatory', ST_SPEC, 13) : cite('mandatory', EP_SPEC, 26);
  return {
    'FNC1 start': pf(
      'GS1-128 symbol start: FNC1 in the FIRST position, ahead of AI 00. Scanners signal it as symbology identifier ]C1; it is not a data character',
      t => (t === ']C1' ? 'pass' : null),
      t => `symbology identifier ${t}: FNC1 in the first position (GS1-128)`,
      src
    ),
    'Symbology identifier': pf(
      'GS1-128 starts with FNC1, which scanners report as ]C1',
      t => (/^\]C\d$/.test(t) ? 'fail' : null),
      t => `symbology identifier ${t}: no FNC1 in the first position, so this is plain Code 128, not GS1-128`,
      src
    ),
    'AI 00': pf('GS1 Application Identifier 00 — SSCC follows', literalCheck('00'), null, src),
    'Extension digit': pf('Extension digit 0–9 (merchant assigned)', digitsCheck(1), null, src),
    'Company prefix + serial': pf('GS1 company prefix + serial reference — 16 digits', digitsCheck(16), null, src),
    'SSCC payload (malformed)': pf(
      'SSCC — exactly 18 digits after AI 00',
      () => 'fail',
      t => (/\D/.test(t) ? 'contains a non-digit character' : `found ${t.length} digits, expected 18`),
      src
    ),
    'SSCC payload (AI 00 missing)': pf(
      'SSCC must be preceded by Application Identifier 00',
      () => 'fail',
      () => 'no AI 00 prefix on the decoded value',
      src
    ),
    'Check digit': pf(
      'GS1 mod-10 check digit',
      (t, ctx) => (ssccFromContext(ctx).valid ? 'pass' : 'fail'),
      // The drawer shows the full mod-10 working over the 17 digits before the check
      // digit, so a reviewer can verify the expected digit by hand.
      (t, ctx) => {
        const parsed = ssccFromContext(ctx);
        if (!parsed.expectedCheckDigit) return '';
        const working = gs1Mod10Steps(String(parsed.sscc || '').slice(0, -1));
        return `expected ${parsed.expectedCheckDigit}${working ? ` · ${working}` : ''}`;
      },
      src
    )
  };
};

const GS1_FIELD_SPECS = {
  'AI 01 GTIN': pf(
    'GS1 Application Identifier 01 — GTIN follows',
    literalCheck('01'),
    null,
    cite('mandatory', EP_SPEC, 17)
  ),
  'AI 01 GTIN value': pf(
    '14-digit GTIN (99312650999998 = Australia Post eParcel)',
    digitsCheck(14),
    null,
    cite('mandatory', EP_SPEC, 17)
  ),
  'AI 91 article': pf(
    'GS1 AI 91 — eParcel article and services data follows',
    literalCheck('91'),
    null,
    cite('mandatory', EP_SPEC, 17)
  ),
  'AI 91 article value': pf(
    'eParcel article ID — 21 chars (3-char MLID) or 23 chars (5-char MLID)',
    () => 'manual_review',
    () => 'payload did not parse as a standard eParcel article',
    cite('mandatory', EP_SPEC, 17)
  ),
  'AI 420 postcode': pf(
    'GS1 AI 420 — ship-to postcode follows',
    literalCheck('420'),
    null,
    cite('mandatory', EP_SPEC, 19)
  ),
  'AI 420 postcode value': pf('Delivery postcode — 4 digits', digitsCheck(4), null, cite('mandatory', EP_SPEC, 19)),
  'AI 92 DPID': pf(
    'GS1 AI 92 — delivery point identifier follows',
    literalCheck('92'),
    null,
    cite('conditional', EP_SPEC, 19)
  ),
  'AI 92 DPID value': pf(
    'Delivery point identifier (DPID) — 8 digits',
    digitsCheck(8),
    null,
    cite('conditional', EP_SPEC, 19)
  ),
  'AI 8008 date/time': pf(
    'GS1 AI 8008 — production date/time follows',
    literalCheck('8008'),
    null,
    cite('mandatory', EP_SPEC, 19)
  ),
  'AI 8008 date/time value': pf('Date/time — YYMMDDHHMMSS, not checked', null, null, cite('mandatory', EP_SPEC, 19)),
  'AI 00 SSCC': pf(
    'GS1 Application Identifier 00 — SSCC follows',
    literalCheck('00'),
    null,
    cite('mandatory', EP_SPEC, 26)
  ),
  'AI 00 SSCC value': pf(
    '18-digit SSCC with GS1 mod-10 check digit',
    t => (parseSsccBarcode(`00${t}`).valid ? 'pass' : 'fail'),
    null,
    cite('mandatory', EP_SPEC, 26)
  ),
  // Shown only when the scan's symbology identifier proves FNC1 in the first position.
  'FNC1 start': pf(
    'GS1 symbol start: FNC1 in the FIRST position. Scanners signal it as symbology identifier ]d2 (DataMatrix) or ]C1 (GS1-128); it is not a data character',
    t => (leadingFnc1Info(t).status === 'first' ? 'pass' : null),
    t => `symbology identifier ${t}: FNC1 in the first position (GS1 symbol)`,
    cite('mandatory', 'GS1 DataMatrix Guideline', null, 'ISO/IEC 16022 FNC1 in first position')
  ),
  // Shown when the scan reported an identifier that does not prove FNC1 first.
  'Symbology identifier': pf(
    'GS1 symbols start with FNC1, which scanners report as ]d2 (DataMatrix) or ]C1 (GS1-128)',
    t => (/^\]d\d$/.test(t) ? 'fail' : null),
    t => `symbology identifier ${t}: no FNC1 in the first position, so this is not a GS1 symbol`,
    cite('mandatory', 'GS1 DataMatrix Guideline', null, 'ISO/IEC 16022 FNC1 in first position')
  ),
  // One row per ASCII 29 byte actually captured in a GS1 symbol - never inferred.
  'FNC1 separator': pf(
    'GS1 FNC1 group separator, captured as ASCII 29',
    t => (t === '\x1d' ? 'pass' : null),
    () => 'ASCII 29 group separator, as captured',
    cite('mandatory', EP_SPEC, 28)
  ),
  'GS1 element': pf('Unrecognised GS1 element', () => 'manual_review'),
  // Raw-data markers, not spec fields: they carry no citation.
  'Group separator': pf("ASCII 29 group separator. This symbol isn't GS1, so it isn't read as an FNC1", () => null),
  'Control character': pf('Control character captured in the barcode data', () => null)
};

const FREIGHT_FIELD_SPECS = {
  'Despatch ID': pf(
    'Despatch/depot identifier — 4 alphanumeric',
    t => (/^[A-Z0-9]{4}$/i.test(t) ? 'pass' : 'fail'),
    null,
    cite('mandatory', ST_SPEC, 12)
  ),
  'Connote sequence': pf('Consignment note sequence — 8 digits', digitsCheck(8), null, cite('mandatory', ST_SPEC, 12)),
  'Product code': pf(
    'StarTrack product code — 3 characters',
    t => (STARTRACK_PRODUCT_CODE_MAP[t] ? 'pass' : 'fail'),
    t => STARTRACK_PRODUCT_CODE_MAP[t]?.name || 'not in the StarTrack product map',
    cite('mandatory', ST_SPEC, 7)
  ),
  'Item sequence': pf('Freight item sequence — 5 digits', digitsCheck(5), null, cite('mandatory', ST_SPEC, 12))
};

const ROUTING_FIELD_SPECS = {
  'Label code': pf(
    'StarTrack service label code (e.g. EXP / PRM / ARL)',
    t => (STARTRACK_LABEL_CODE_MAP[t] ? 'pass' : 'manual_review'),
    t =>
      STARTRACK_LABEL_CODE_MAP[t]
        ? `products: ${STARTRACK_LABEL_CODE_MAP[t].join(', ')}`
        : 'not a known StarTrack label code',
    cite('mandatory', ST_SPEC, 14)
  ),
  Postcode: pf('Destination postcode — 4 digits', digitsCheck(4), null, cite('mandatory', ST_SPEC, 14)),
  'Depot/port': pf(
    'Destination depot/port — 2–3 characters, assigned from the StarTrack Location Master File',
    // Format is checkable, validity is not: the Location Master File has no digital
    // lookup, so a well-formed depot/port is held at manual review rather than passed.
    t => (/^[A-Z0-9]{2,3}$/i.test(t) ? 'manual_review' : 'fail'),
    t =>
      /^[A-Z0-9]{2,3}$/i.test(t)
        ? `depot/port ${t.toUpperCase()} requires manual validation — the StarTrack Location Master File cannot be queried digitally`
        : 'not a 2-3 character depot/port code',
    cite('mandatory', ST_SPEC, 14)
  ),
  'AI 421': pf(
    'GS1 AI 421 — postal code with ISO country follows',
    literalCheck('421'),
    null,
    cite('mandatory', ST_SPEC, null, '4.001')
  ),
  'Country code': pf(
    'ISO 3166 numeric country code (036 = Australia)',
    digitsCheck(3),
    null,
    cite('mandatory', ST_SPEC, null, '4.001')
  ),
  'AI 403': pf(
    'GS1 AI 403 — routing code follows',
    literalCheck('403'),
    null,
    cite('mandatory', ST_SPEC, null, '4.001')
  ),
  // The GS1 421 routing form is GS1-128; the standard routing barcode is plain Code 128, so a
  // captured FNC1 there is shown without a verdict.
  'FNC1 start': pf(
    'GS1 421 routing barcode: FNC1 in the first position, reported by scanners as ]C1',
    (t, ctx) => (t === ']C1' && /^421/.test(ctx?.joined || '') ? 'pass' : null),
    t => `symbology identifier ${t}: FNC1 in the first position`,
    cite('mandatory', ST_SPEC, null, '4.001')
  ),
  'FNC1 separator': pf(
    'GS1 FNC1 group separator between AI 421 and AI 403, captured as ASCII 29',
    t => (t === '\x1d' ? 'pass' : null),
    () => 'ASCII 29 group separator, as captured',
    cite('mandatory', ST_SPEC, null, '4.001')
  )
};

const ATL_FIELD_SPECS = {
  Prefix: pf('Literal character C', literalCheck('C'), null, cite('conditional', ST_SPEC, 18)),
  Counter: pf(
    'Nine-digit sequential counter (starts 000000001)',
    digitsCheck(9),
    null,
    cite('conditional', ST_SPEC, 18)
  )
};

/** Picks the field-spec map for a segmented barcode. SSCC-split segments can surface under
 *  several kinds (freight, linear, sscc), so their labels take precedence over the kind. */
export function fieldSpecsFor(kind, segments) {
  if (segments.some(s => s.label === 'Extension digit' || String(s.label).startsWith('SSCC payload')))
    return { ...GS1_FIELD_SPECS, ...ssccFieldSpecs(kind) };
  if (kind === 'freight') return FREIGHT_FIELD_SPECS;
  if (kind === 'routing') return ROUTING_FIELD_SPECS;
  if (kind === 'atl') return ATL_FIELD_SPECS;
  return { ...GS1_FIELD_SPECS, ...ARTICLE_FIELD_SPECS };
}
