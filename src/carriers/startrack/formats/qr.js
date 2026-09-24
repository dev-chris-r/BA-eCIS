// The StarTrack fixed-width QR payload: field layout (MOS v9 p16), the
// mandatory-field list, and the parser. Single source of truth for both
// validation and the report's field-by-field breakdown.
import { STARTRACK_PRODUCT_CODE_MAP } from '../referenceData.js';

// 1-based fixed-position slice, matching the spec's character positions.
function fixed(raw, start, length) {
  return String(raw || '').slice(start - 1, start - 1 + length);
}

// [field key, report label] pairs for every field the spec marks obligation M (mandatory).
export const ST_QR_MANDATORY_FIELDS = [
  ['receiverSuburb', 'Receiver suburb'],
  ['receiverPostcode', 'Receiver postcode'],
  ['connoteNumber', 'Consignment number'],
  ['freightItemNumber', 'Freight item number'],
  ['productCode', 'Product code'],
  ['consignmentQuantity', 'Consignment quantity'],
  ['consignmentWeight', 'Consignment weight'],
  ['despatchDate', 'Despatch date'],
  ['receiverName1', 'Receiver name'],
  ['unitType', 'Unit type'],
  ['destinationDepot', 'Destination depot'],
  ['receiverAddress1', 'Receiver address line 1'],
  ['dangerousGoodsIndicator', 'Dangerous goods indicator'],
  ['movementTypeIndicator', 'Movement type indicator']
];

// The StarTrack fixed-width QR payload, field by field. Single source of truth for both
// the parser (below) and the report's field-by-field breakdown (src/main.jsx), so the two
// can never drift. pos/len are 1-based character offsets per MOS v9 p16; rule is the
// per-field validation rule id (ST-QR-Fnn) when one exists. Obligation: M/COND/O.
export const STARTRACK_QR_FIELDS = [
  {
    num: 1,
    key: 'receiverSuburb',
    label: 'Receiver suburb',
    pos: 1,
    len: 30,
    obligation: 'M',
    rule: 'ST-QR-F01',
    criteria: 'Non-blank'
  },
  {
    num: 2,
    key: 'receiverPostcode',
    label: 'Receiver postcode',
    pos: 31,
    len: 4,
    obligation: 'M',
    rule: 'ST-QR-F02',
    criteria: '4 digits (9901 for NZ Premium)'
  },
  {
    num: 3,
    key: 'connoteNumber',
    label: 'Consignment number',
    pos: 35,
    len: 12,
    obligation: 'M',
    rule: 'ST-QR-F03',
    criteria: '4 alphanumeric + 8 digits'
  },
  {
    num: 4,
    key: 'freightItemNumber',
    label: 'Freight item number',
    pos: 47,
    len: 20,
    obligation: 'M',
    rule: 'ST-QR-F04',
    criteria: '20-char freight item ID'
  },
  {
    num: 5,
    key: 'productCode',
    label: 'Product code',
    pos: 67,
    len: 3,
    obligation: 'M',
    rule: 'ST-QR-F05',
    criteria: 'Valid StarTrack product code'
  },
  {
    num: 6,
    key: 'payerAccount',
    label: 'Payer account',
    pos: 70,
    len: 8,
    obligation: 'COND',
    rule: 'ST-QR-F06',
    criteria: 'Required for returns/transfers'
  },
  {
    num: 7,
    key: 'senderAccount',
    label: 'Sender account',
    pos: 78,
    len: 8,
    obligation: 'COND',
    rule: 'ST-QR-F07',
    criteria: 'Required for despatch movements'
  },
  {
    num: 8,
    key: 'consignmentQuantity',
    label: 'Consignment quantity',
    pos: 86,
    len: 4,
    obligation: 'M',
    rule: 'ST-QR-F08',
    criteria: 'Numeric, >= 1'
  },
  {
    num: 9,
    key: 'consignmentWeight',
    label: 'Consignment weight',
    pos: 90,
    len: 5,
    obligation: 'M',
    rule: 'ST-QR-F09',
    criteria: 'Numeric whole kg'
  },
  {
    num: 10,
    key: 'consignmentCube',
    label: 'Consignment cube',
    pos: 95,
    len: 5,
    obligation: 'COND',
    rule: 'ST-QR-F10',
    criteria: 'Numeric m3 x 1000 (or *****); req. non-satchel'
  },
  {
    num: 11,
    key: 'despatchDate',
    label: 'Despatch date',
    pos: 100,
    len: 8,
    obligation: 'M',
    criteria: 'YYYYMMDD. Not checked'
  },
  {
    num: 12,
    key: 'receiverName1',
    label: 'Receiver name',
    pos: 108,
    len: 40,
    obligation: 'M',
    rule: 'ST-QR-F12',
    criteria: 'Non-blank'
  },
  {
    num: 13,
    key: 'receiverName2',
    label: 'Receiver name 2',
    pos: 148,
    len: 40,
    obligation: 'O',
    rule: null,
    criteria: 'Optional'
  },
  {
    num: 14,
    key: 'unitType',
    label: 'Unit type',
    pos: 188,
    len: 3,
    obligation: 'M',
    rule: 'ST-QR-F14',
    criteria: 'Appendix A unit permitted for product'
  },
  {
    num: 15,
    key: 'destinationDepot',
    label: 'Destination depot',
    pos: 191,
    len: 4,
    obligation: 'M',
    rule: 'ST-QR-F15',
    criteria: 'Non-blank'
  },
  {
    num: 16,
    key: 'receiverAddress1',
    label: 'Receiver address',
    pos: 195,
    len: 40,
    obligation: 'M',
    rule: 'ST-QR-F16',
    criteria: 'Non-blank'
  },
  {
    num: 17,
    key: 'receiverAddress2',
    label: 'Receiver address 2',
    pos: 235,
    len: 40,
    obligation: 'O',
    rule: null,
    criteria: 'Optional'
  },
  {
    num: 18,
    key: 'receiverPhone',
    label: 'Receiver phone',
    pos: 275,
    len: 14,
    obligation: 'O',
    rule: 'ST-QR-F18',
    criteria: 'Numeric when present'
  },
  {
    num: 19,
    key: 'dangerousGoodsIndicator',
    label: 'Dangerous goods indicator',
    pos: 289,
    len: 1,
    obligation: 'M',
    rule: 'ST-QR-F19',
    criteria: 'Y or N'
  },
  {
    num: 20,
    key: 'movementTypeIndicator',
    label: 'Movement type indicator',
    pos: 290,
    len: 1,
    obligation: 'M',
    rule: 'ST-QR-F20',
    criteria: 'N, C or T'
  },
  {
    num: 21,
    key: 'notBeforeDate',
    label: 'Book-in not-before date',
    pos: 291,
    len: 12,
    obligation: 'COND',
    criteria: 'YYYYMMDDHHMM, not after the end date. Not checked'
  },
  {
    num: 22,
    key: 'notAfterDate',
    label: 'Book-in not-after date',
    pos: 303,
    len: 12,
    obligation: 'COND',
    criteria: 'YYYYMMDDHHMM. Not checked'
  },
  {
    num: 23,
    key: 'atlNumber',
    label: 'ATL number',
    pos: 315,
    len: 10,
    obligation: 'COND',
    rule: 'ST-QR-F23',
    criteria: 'C999999999 when present'
  },
  {
    num: 24,
    key: 'raNumber',
    label: 'RA/TA number',
    pos: 325,
    len: 10,
    obligation: 'COND',
    rule: 'ST-QR-F24',
    criteria: 'Required for movement C/T'
  }
];

/** Parses the StarTrack fixed-width QR payload into named fields used by validation and reports. */
export function parseStarTrackQrBarcode(raw) {
  const text = String(raw || '').replace(/^\]Q[0-9]/, '');
  const fields = {};
  for (const f of STARTRACK_QR_FIELDS) fields[f.key] = fixed(text, f.pos, f.len).trim();
  const product = STARTRACK_PRODUCT_CODE_MAP[fields.productCode] || null;
  // Any decoded QR long enough to carry the mandatory fields (suburb..product end at
  // position 69) is treated as an attempt at the StarTrack QR, so every field is sliced
  // and validated against the fixed-width layout for the report - even when the payload
  // is non-conforming (wrong field order, short, etc.). The per-field rules then show
  // exactly which positions fail, and ST-QR-03 flags the length. Field shapes also catch
  // a recognisable-but-short payload. Clearly-unrelated short QR codes (e.g. marketing
  // URLs) match none of these and are not exploded into fields. `conformant` records
  // whether the payload is the full fixed-width length.
  const looksStarTrack =
    text.length >= 67 ||
    /^[A-Z0-9]{4}\d{8}[A-Z0-9]{3}\d{5}$/.test(fields.freightItemNumber) ||
    /^[A-Z0-9]{4}\d{8}$/.test(fields.connoteNumber) ||
    Boolean(product);
  if (!looksStarTrack) {
    return { valid: false, raw, length: text.length, fields, reason: 'Not a StarTrack fixed-width QR payload.' };
  }
  return {
    valid: true,
    type: 'startrack-qr',
    raw,
    length: text.length,
    conformant: text.length >= 290,
    fields,
    productCode: fields.productCode,
    productName: product?.name || 'Unknown StarTrack product code',
    productGroup: product?.group || 'Unknown',
    expectedLabelCode: product?.labelCode || null
  };
}
