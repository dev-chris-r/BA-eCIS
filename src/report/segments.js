// Display-layer barcode segmentation: slices a barcode's captured raw content into labelled,
// colour-coded fields. Slicing reuses the parsers (single source of truth).
//
// The display is byte-true. Segments are exact slices of the captured bytes (or of the decoded
// text when a decoder reported no bytes), so their texts join back to the raw value unchanged:
// no parentheses added, nothing trimmed, cleaned or upper-cased. FNC1 appears only with scan
// evidence - a leading marker when the symbology identifier proves FNC1 in the first position,
// and a separator marker for each ASCII 29 (GS) byte actually captured. Nothing is inferred
// from the data.
import { analyzeArticleCandidate } from '../carriers/eparcel/formats/article.js';
import { STARTRACK_QR_FIELDS } from '../carriers/startrack/formats/qr.js';
import { leadingFnc1Info, rawContentOf } from './readerData.js';

/** Splits an eParcel article number into its individual spec elements (MLID + 7-digit
 *  consignment serial + article count + product + service + postage-paid + check digit).
 *  Structure and field lengths come from the audit engine's article parser (the single
 *  slicing source of truth); the original string is sliced so the display stays faithful.
 *  Returns null when the engine does not recognise a standard eParcel article. */
function articleSegments(article) {
  const c = String(article || '');
  const parsed = analyzeArticleCandidate(c)?.article;
  if (parsed?.type !== 'eparcel-standard' || parsed.articleId.length !== c.length) return null;
  const fields = [
    [parsed.mlidLength, 'MLID'],
    [7, 'Consignment serial'],
    [2, 'Article count'],
    [5, 'Product code'],
    [2, 'Service code'],
    [1, 'Postage paid'],
    [1, 'Check digit']
  ];
  let i = 0;
  return fields.map(([len, label]) => ({ text: c.slice(i, (i += len)), label }));
}

/** Length of the eParcel article ID at the front of an AI 91 payload (AI = GS1 Application
 *  Identifier, the numeric prefix that names a field). AusPost sometimes appends further AIs
 *  (420 postcode, 92 DPID, 8008 date) after the article with no separator, so prefer the
 *  shortest valid article length whose remainder is empty or begins with a known trailing AI.
 *  Also accepts the 20-char SSCC-as-article form (SSCC = GS1 serial shipping container code:
 *  AI 00 + 18-digit SSCC in the AI 91 position, Parcel Post spec v1.4 p26); otherwise consume
 *  the whole payload (rendered as a single block). */
function eparcelArticleLength(payload) {
  const c = String(payload || '');
  const remainderOk = len => {
    const rest = c.slice(len);
    return rest === '' || /^(420|92|8008|00|01)/.test(rest);
  };
  for (const len of [21, 23]) {
    if (len <= c.length && articleSegments(c.slice(0, len)) && remainderOk(len)) return len;
  }
  if (/^00\d{18}$/.test(c.slice(0, 20)) && remainderOk(20)) return 20;
  return c.length;
}

/** Splits raw content into printable runs and single control characters. */
function tokenize(value) {
  const out = [];
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) out.push({ ctrl: true, text: ch });
    else if (out.length && !out[out.length - 1].ctrl) out[out.length - 1].text += ch;
    else out.push({ ctrl: false, text: ch });
  }
  return out;
}

/** A captured control character, kept verbatim with a visible marker. ASCII 29 (GS) is an
 *  FNC1 separator only inside a GS1 symbol; elsewhere it is shown as a plain GS. */
function controlSegment(ch, gs1) {
  const code = ch.charCodeAt(0);
  if (code === 0x1d) {
    return gs1
      ? { text: ch, label: 'FNC1 separator', display: '⟨FNC1⟩' }
      : { text: ch, label: 'Group separator', display: '⟨GS⟩' };
  }
  const hex = `0x${code.toString(16).toUpperCase().padStart(2, '0')}`;
  return { text: ch, label: 'Control character', display: `⟨${hex}⟩` };
}

/** The whole value as one block, control characters still shown as markers. */
function wholeSegments(value, gs1) {
  return tokenize(value).map(t => (t.ctrl ? controlSegment(t.text, gs1) : { text: t.text, label: 'Decoded value' }));
}

const AI_LABEL = {
  '00': 'AI 00 SSCC',
  '01': 'AI 01 GTIN',
  91: 'AI 91 article',
  420: 'AI 420 postcode',
  92: 'AI 92 DPID',
  8008: 'AI 8008 date/time'
};
// Fixed-value-length AIs can be consumed back-to-back without a separator; AI 91 (article) is
// variable so it always runs to the end of its element.
const FIXED = { '00': 18, '01': 14, 420: 4, 92: 8, 8008: 12 };

/** Walks the Australia Post AI pattern (01 GTIN, 91 article, 420 postcode, 92 DPID, 8008
 *  date/time) through one element of GS1 data - the text between two captured separators. */
function gs1ElementSegments(s) {
  const seg = (text, label) => ({ text, label });
  const out = [];
  let i = 0;
  while (i < s.length) {
    const fixed = Object.keys(FIXED).find(ai => s.startsWith(ai, i));
    if (fixed) {
      out.push(
        seg(fixed, AI_LABEL[fixed]),
        seg(s.slice(i + fixed.length, i + fixed.length + FIXED[fixed]), `${AI_LABEL[fixed]} value`)
      );
      i += fixed.length + FIXED[fixed];
      continue;
    }
    if (s.startsWith('91', i)) {
      const rest = s.slice(i + 2);
      out.push(seg('91', AI_LABEL['91']));
      // AI 91 (variable length) carries the eParcel article ID, sometimes followed by more
      // AusPost AIs (420 postcode, 92 DPID, 8008 date) with no separators. Peel the
      // fixed-length article off the front into its components, then let the loop parse the
      // trailing AIs instead of dumping the whole payload as one block.
      const artLen = eparcelArticleLength(rest);
      const artText = rest.slice(0, artLen);
      const artSegs = articleSegments(artText);
      if (artSegs) out.push(...artSegs);
      else if (/^00\d{18}$/.test(artText))
        // SSCC used as the article ID in the AI 91 position (Parcel Post spec v1.4 p26).
        out.push(seg('00', 'AI 00 SSCC'), seg(artText.slice(2), 'AI 00 SSCC value'));
      else out.push(seg(artText, `${AI_LABEL['91']} value`));
      i += 2 + artLen;
      continue;
    }
    out.push(seg(s.slice(i), 'GS1 element'));
    return out;
  }
  return out;
}

/** GS1 data: each element walked by AI, each captured control character kept in place. */
function gs1Segments(value, gs1) {
  return tokenize(value).flatMap(t => (t.ctrl ? [controlSegment(t.text, gs1)] : gs1ElementSegments(t.text)));
}

/** The StarTrack GS1 routing form: AI 421 (country + postcode), then AI 403 (label code),
 *  normally separated by a captured FNC1. */
function routing421Segments(value, gs1) {
  const out = [];
  for (const t of tokenize(value)) {
    if (t.ctrl) {
      out.push(controlSegment(t.text, gs1));
      continue;
    }
    let rest = t.text;
    while (rest) {
      const ai421 = rest.match(/^421(\d{3})(\d{4})/);
      if (ai421) {
        out.push(
          { text: '421', label: 'AI 421' },
          { text: ai421[1], label: 'Country code' },
          { text: ai421[2], label: 'Postcode' }
        );
        rest = rest.slice(ai421[0].length);
        continue;
      }
      const ai403 = rest.match(/^403([A-Z0-9]+)$/);
      if (ai403) out.push({ text: '403', label: 'AI 403' }, { text: ai403[1], label: 'Label code' });
      else out.push({ text: rest, label: 'GS1 element' });
      rest = '';
    }
  }
  return out;
}

function ssccSegments(d) {
  const seg = (text, label) => ({ text, label });
  if (/^00\d{18}$/.test(d))
    return [
      seg('00', 'AI 00'),
      seg(d.slice(2, 3), 'Extension digit'),
      seg(d.slice(3, 19), 'Company prefix + serial'),
      seg(d.slice(19), 'Check digit')
    ];
  if (/^\d{18}$/.test(d))
    return [
      seg(d.slice(0, 1), 'Extension digit'),
      seg(d.slice(1, 17), 'Company prefix + serial'),
      seg(d.slice(17), 'Check digit')
    ];
  if (/^00/.test(d)) return [seg('00', 'AI 00'), seg(d.slice(2), 'SSCC payload (malformed)')];
  if (/^\d+$/.test(d)) return [seg(d, 'SSCC payload (AI 00 missing)')];
  return null;
}

/** Field segments for one kind, and whether that content is meant to be a GS1 symbol (so a
 *  non-GS1 symbology identifier is worth showing as evidence). */
function bodyFor(value, kind, gs1) {
  const seg = (text, label) => ({ text, label });
  const dataOnly = value.replace(/[\x00-\x1f\x7f]/g, '');
  switch (kind) {
    case 'qr': {
      const out = STARTRACK_QR_FIELDS.map(f => seg(value.slice(f.pos - 1, f.pos - 1 + f.len), `${f.num}. ${f.label}`));
      const consumed = STARTRACK_QR_FIELDS.reduce((m, f) => Math.max(m, f.pos - 1 + f.len), 0);
      if (value.length > consumed) out.push(seg(value.slice(consumed), 'Overflow / extra'));
      return { segs: out, gs1Expected: false };
    }
    case 'freight':
      if (/^00\d{18}$/.test(value)) return bodyFor(value, 'sscc', gs1);
      return {
        segs: /^[A-Z0-9]{4}\d{8}[A-Z0-9]{3}\d{5}$/.test(value)
          ? [
              seg(value.slice(0, 4), 'Despatch ID'),
              seg(value.slice(4, 12), 'Connote sequence'),
              seg(value.slice(12, 15), 'Product code'),
              seg(value.slice(15, 20), 'Item sequence')
            ]
          : null,
        gs1Expected: false
      };
    case 'routing': {
      if (/^421\d{7}(403[A-Z0-9]+)?$/.test(dataOnly))
        return { segs: routing421Segments(value, gs1), gs1Expected: true };
      const m = value.match(/^([A-Z]{2,3})(\d{4})([A-Z0-9]{2,3})?$/);
      return {
        segs: m ? [seg(m[1], 'Label code'), seg(m[2], 'Postcode'), ...(m[3] ? [seg(m[3], 'Depot/port')] : [])] : null,
        gs1Expected: false
      };
    }
    case 'atl': {
      const m = value.match(/^(C)(\d{9})$/);
      return { segs: m ? [seg('C', 'Prefix'), seg(m[2], 'Counter')] : null, gs1Expected: false };
    }
    case 'sscc':
    case 'eparcel-linear-sscc':
      return { segs: ssccSegments(value), gs1Expected: true };
    case 'eparcel-linear':
      if (/^00\d{18}$/.test(value)) return { segs: ssccSegments(value), gs1Expected: true };
      // GS1-128 carries AI 01 GTIN + AI 91 article; segment it by AI like the DataMatrix.
      if (/^01\d{14}91/.test(dataOnly)) return { segs: gs1Segments(value, gs1), gs1Expected: true };
      return { segs: articleSegments(value), gs1Expected: false };
    case 'article':
      return { segs: articleSegments(value), gs1Expected: false };
    case 'datamatrix':
      return { segs: gs1Segments(value, gs1), gs1Expected: true };
    default:
      return { segs: null, gs1Expected: false };
  }
}

/** Splits captured raw content into colour-coded field segments by its kind's format.
 *  `identifier` is the decoder-reported ISO/IEC 15424 symbology identifier (]C1, ]d2...):
 *  it is not data, so it is never mixed into the value. When it proves FNC1 in the first
 *  position, a leading "FNC1 start" marker carries it; when a GS1 symbol reports another
 *  identifier, a "Symbology identifier" marker shows it as evidence; with no identifier,
 *  nothing is shown. Markers have empty text, so the segment texts always join back to the
 *  raw value exactly (a guard falls back to one block when slicing would not). */
export function rawSegments(raw, kind, identifier = '') {
  const value = String(raw ?? '');
  if (!value) return [];
  const ident = String(identifier || '');
  const gs1 = leadingFnc1Info(ident).status === 'first';
  const body = bodyFor(value, kind, gs1);
  let segs = (body.segs || []).filter(s => s && String(s.text).length > 0);
  if (!segs.length || segs.map(s => s.text).join('') !== value) segs = wholeSegments(value, gs1);
  if (!ident) return segs;
  // The leading FNC1 shows as its identifier alone (]d2, ]C1), the way the spec writes a scan
  // (PP&EP v1.4 p27); the hover names it.
  if (gs1) return [{ text: '', ident, label: 'FNC1 start', display: ident, title: 'FNC1 in first position' }, ...segs];
  return body.gs1Expected ? [{ text: '', ident, label: 'Symbology identifier', display: ident }, ...segs] : segs;
}

/** Colour-coded segments for a decoded barcode, from its captured raw content (the byte
 *  stream when the decoder reported one, else its decoded text) and symbology identifier. */
export function barcodeSegments(barcode, kind) {
  return rawSegments(rawContentOf(barcode).raw, kind, barcode?.symbologyIdentifier);
}
