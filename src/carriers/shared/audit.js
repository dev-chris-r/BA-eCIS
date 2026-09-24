// Shared audit plumbing between the rule engine and the carrier packs:
// the validation-row shape, audit-mode checks, decoded-value helpers, the
// overall summary, page geometry, and the carrier-agnostic rule functions.
import { applyNormalize, registerRuleFunction, resolvePath } from '../../ruleEngine.js';
import { parseSuburbLine, postcodeAllowsState, statesForPostcode } from './reference.js';
import { ssccInRange } from './merchantProfile.js';

/** Creates one normalized validation row consumed by both the React UI and exported HTML. */
export function result(id, title, severity, category, status, message, extra = {}) {
  return { id, title, severity, category, status, message, ...extra };
}

export function normalizeLabelFormat(value) {
  return value === 'sscc' ? 'sscc' : 'standard';
}

function labelFormatName(format) {
  return normalizeLabelFormat(format) === 'sscc' ? 'SSCC article identifier' : 'Standard article format';
}

function carrierName(carrier) {
  if (carrier === 'unknown') return 'unknown';
  return carrier === 'startrack' ? 'StarTrack' : 'eParcel';
}

// How the format choice reads in a sentence: "You chose SSCC", "looks like a standard label".
const FORMAT_CHOICE = { sscc: 'SSCC', standard: 'a standard label' };
const FORMAT_LOOK = { sscc: 'an SSCC label', standard: 'a standard label' };

/** CRITICAL cross-check that the selected carrier and label format match the decoded evidence,
 *  so a label audited under the wrong mode is flagged rather than silently scored.
 *  `formatReason` names the barcode that decided the format, e.g. "SSCC barcode 00193… was read". */
export function validateSelectedAuditMode({
  selectedCarrier = 'eparcel',
  selectedFormat = 'standard',
  detectedCarrier = 'unknown',
  detectedFormat = 'unknown',
  evidence = '',
  formatReason = ''
}) {
  const chosen = carrierName(selectedCarrier);
  const validations = [];
  validations.push(
    detectedCarrier === selectedCarrier
      ? result(
          'AUDIT_MODE_CARRIER',
          'Selected carrier matches label evidence',
          'CRITICAL',
          'audit-mode',
          'pass',
          `The barcodes match your choice: ${chosen}.`,
          { expected: chosen, actual: carrierName(detectedCarrier), evidence }
        )
      : result(
          'AUDIT_MODE_CARRIER',
          'Selected carrier matches label evidence',
          'CRITICAL',
          'audit-mode',
          'fail',
          detectedCarrier === 'unknown'
            ? `You chose ${chosen}, but no ${chosen} barcode was read. Check the carrier choice, and that the barcodes are readable.`
            : `You chose ${chosen}, but the barcodes look like ${carrierName(detectedCarrier)}.`,
          {
            expected: chosen,
            actual: detectedCarrier === 'unknown' ? 'unknown' : carrierName(detectedCarrier),
            evidence
          }
        )
  );
  const chosenFormat = normalizeLabelFormat(selectedFormat);
  validations.push(
    detectedFormat === selectedFormat
      ? result(
          'AUDIT_MODE_FORMAT',
          'Selected label format matches barcode evidence',
          'CRITICAL',
          'audit-mode',
          'pass',
          `The barcodes match your choice: ${labelFormatName(selectedFormat)}.`,
          { expected: labelFormatName(selectedFormat), actual: labelFormatName(detectedFormat), evidence }
        )
      : result(
          'AUDIT_MODE_FORMAT',
          'Selected label format matches barcode evidence',
          'CRITICAL',
          'audit-mode',
          'fail',
          detectedFormat === 'unknown'
            ? `You chose ${FORMAT_CHOICE[chosenFormat]}, but no article barcode was read, so the format couldn't be confirmed.`
            : `You chose ${FORMAT_CHOICE[chosenFormat]}, but the barcodes look like ${FORMAT_LOOK[normalizeLabelFormat(detectedFormat)]}${formatReason ? `: ${formatReason}` : ''}.`,
          {
            expected: labelFormatName(selectedFormat),
            actual: detectedFormat === 'unknown' ? 'unknown' : labelFormatName(detectedFormat),
            evidence
          }
        )
  );
  return validations;
}

export function decodedRawValues(detectedBarcodes) {
  return detectedBarcodes.map(b => b.rawValue || b.raw || b.text || '').filter(Boolean);
}

// Manual entries are useful for investigation counts, but never substitute for decoded barcode proof.
export function diagnosticManualValues(manualBarcodes) {
  return String(manualBarcodes || '')
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(Boolean);
}

/** Rolls validation rows up into severity/status counts and the overall PASS/FAIL/REVIEW verdict. */
export function summarizeValidations(validations) {
  const summary = {
    overallStatus: 'PASS',
    total: validations.length,
    critical: 0,
    errors: 0,
    warnings: 0,
    manualReview: 0,
    failed: 0,
    passed: 0
  };
  for (const validation of validations) {
    if (validation.severity === 'CRITICAL') summary.critical += 1;
    if (validation.severity === 'ERROR') summary.errors += 1;
    if (validation.severity === 'WARNING') summary.warnings += 1;
    if (validation.status === 'manual_review') summary.manualReview += 1;
    if (validation.status === 'fail') summary.failed += 1;
    if (validation.status === 'pass') summary.passed += 1;
    if (validation.status === 'fail' && (validation.severity === 'CRITICAL' || validation.severity === 'ERROR')) {
      summary.overallStatus = 'FAIL';
    } else if (
      summary.overallStatus !== 'FAIL' &&
      (validation.status === 'warning' || validation.status === 'manual_review')
    ) {
      summary.overallStatus = 'REVIEW';
    }
  }
  return summary;
}

// The page must match one of the allowed label sizes (either orientation) within a small
// tolerance for PDF rounding; files with no physical size defer to manual review.
registerRuleFunction('pageSizeWithin', (page, { args }) => {
  const widthMm = page?.widthMm;
  const heightMm = page?.heightMm;
  if (!widthMm || !heightMm) {
    return {
      pass: false,
      status: args?.unverifiedStatus || 'manual_review',
      message: page?.isRasterImage
        ? "Images have no physical size, so the label size can't be checked. Upload the PDF to check it."
        : "This file has no physical size, so the label size can't be checked."
    };
  }
  const tolerance = args?.toleranceMm ?? 5;
  const sizes = args?.sizesMm || [];
  const pass = sizes.some(
    ([w, h]) =>
      (Math.abs(widthMm - w) <= tolerance && Math.abs(heightMm - h) <= tolerance) ||
      (Math.abs(widthMm - h) <= tolerance && Math.abs(heightMm - w) <= tolerance)
  );
  return {
    pass,
    expected: `${sizes.map(([w, h]) => `${w}mm x ${h}mm`).join(' or ')} (within ${tolerance}mm, either orientation)`,
    actual: `${widthMm.toFixed(1)}mm x ${heightMm.toFixed(1)}mm`
  };
});

// A spec-required barcode did not decode. The message separates "visible but not decoded"
// from "absent", and for low-DPI raster uploads explains that the narrow bars are unrecoverable.
registerRuleFunction('requiredDecode', (value, { context, args }) => {
  if (value === true) return { pass: true };
  const visible = args?.visiblePath ? Boolean(resolvePath(args.visiblePath, context)) : false;
  const page = context.page || {};
  const parts = [];
  parts.push(
    visible
      ? `${args?.label || 'The required barcode'} is visible but couldn't be read.`
      : `${args?.label || 'The required barcode'} wasn't found on the label.`
  );
  if (page.isRasterImage && page.estimatedDpi && page.estimatedDpi < MIN_LINEAR_DECODE_DPI) {
    parts.push(
      `The image is about ${page.estimatedDpi} DPI (${page.pixelWidth}x${page.pixelHeight}px), too low to read thin barcode bars. Upload the original PDF, or export the label at 300 DPI or more.`
    );
  }
  return { pass: false, message: parts.join(' ') };
});

// Membership check: passes when the value equals any normalized value found at args.path in
// the context; with nothing to compare against it defers to manual review instead of failing.
// args.label names the comparison source in plain words, e.g. "printed connote".
registerRuleFunction('inPathList', (value, { context, item, args }) => {
  const raw = resolvePath(args?.path, context, item);
  const list = (Array.isArray(raw) ? raw : raw === undefined || raw === null || raw === '' ? [] : [raw])
    .map(v => applyNormalize(v, args?.normalize))
    .filter(Boolean);
  const needle = applyNormalize(value, args?.normalize);
  if (!list.length) {
    return {
      pass: false,
      status: 'manual_review',
      expected: 'none read',
      actual: needle || 'missing',
      message: args?.label
        ? `The ${args.label} couldn't be read, so there's nothing to compare the barcode with.`
        : "There's nothing to compare the barcode with."
    };
  }
  return { pass: list.includes(needle), expected: list.join(', '), actual: needle || 'missing' };
});

// Every printed "SUBURB STATE 1234" line must pair a postcode with a state its range
// allows (reference-values.json). A mismatch only warns: border towns share postcodes,
// and the shared list is hand-maintained.
registerRuleFunction('postcodesMatchStates', lines => {
  const parsed = (Array.isArray(lines) ? lines : []).map(parseSuburbLine).filter(Boolean);
  const mismatches = parsed.filter(p => postcodeAllowsState(p.postcode, p.state) === false);
  if (!mismatches.length) {
    return {
      pass: true,
      actual: parsed.map(p => p.line).join(' | '),
      message: 'Every printed postcode matches its state.'
    };
  }
  const describe = p => `${p.line}: ${p.postcode} is a ${statesForPostcode(p.postcode).join(' or ')} postcode`;
  return {
    pass: false,
    expected: 'each postcode inside its state',
    actual: mismatches.map(describe).join(' | '),
    message: `${mismatches.map(describe).join('. ')}. Check the state and postcode on the label.`
  };
});

// A barcode postcode must belong to the state printed in the delivery address.
registerRuleFunction('postcodeInState', (postcode, { context, item, args }) => {
  const state = String(resolvePath(args?.statePath, context, item) || '').toUpperCase();
  const allowed = postcodeAllowsState(postcode, state);
  if (allowed === null)
    return { pass: true, message: 'The postcode or state could not be read, so they were not compared.' };
  const states = statesForPostcode(postcode).join(' or ');
  return {
    pass: allowed,
    expected: `a ${state} postcode`,
    actual: `${postcode} (${states})`,
    message: allowed
      ? `Barcode postcode ${postcode} is a ${state} postcode, matching the delivery address.`
      : `Barcode postcode ${postcode} is a ${states} postcode, but the delivery address is in ${state}. Check the barcode carries the delivery postcode, not the sender's.`
  };
});

// An SSCC must fall inside a range the merchant profile lists. When the label's printed
// product is known (eParcel Parcel Post vs Express Post), the matching range must be for
// that product - the spec reserves a separate SSCC prefix for each.
registerRuleFunction('ssccInProfileRange', (sscc, { context, args }) => {
  const digits = String(sscc?.sscc || sscc || '').replace(/\D/g, '');
  const lists = (args?.ranges || []).map(r => ({ ...r, ranges: resolvePath(r.path, context) || [] }));
  const hits = lists.filter(l => l.ranges.some(range => ssccInRange(digits, range)));
  const all = lists.flatMap(l => l.ranges.map(r => r.label)).join(', ');
  if (!hits.length) {
    return {
      pass: false,
      expected: `inside ${all}`,
      actual: digits,
      message: `SSCC ${digits} isn't in the merchant profile's SSCC ranges (${all}). Check the label uses this merchant's reserved range.`
    };
  }
  const printed = String(resolvePath(args?.productPath, context) || '');
  const printedProduct = /express/i.test(printed) ? 'Express Post' : /parcel/i.test(printed) ? 'Parcel Post' : null;
  if (printedProduct && hits.every(h => h.product && h.product !== printedProduct)) {
    return {
      pass: false,
      expected: `a ${printedProduct} range`,
      actual: `${digits} is in the ${hits.map(h => h.product).join(' / ')} range`,
      message: `This is a ${printedProduct} label, but SSCC ${digits} is in the ${hits.map(h => h.product).join(' / ')} range. Each product needs its own reserved SSCC range.`
    };
  }
  return {
    pass: true,
    expected: `inside ${all}`,
    actual: digits,
    message: `SSCC ${digits} is inside the merchant's ${hits.map(h => h.name).join(' / ')}.`
  };
});

// Raster uploads carry no physical size: DPI is estimated against the standard
// 100mm short edge, and linear barcodes are typically unrecoverable below
// about 200 DPI (narrow bars collapse to under a pixel).
const ASSUMED_LABEL_SHORT_EDGE_MM = 100;
const MIN_LINEAR_DECODE_DPI = 200;

/** Page geometry context shared by both carriers, including raster-image DPI estimation. */
export function buildPageContext(fileInfo) {
  const pixelWidth = fileInfo?.pixelWidth || null;
  const pixelHeight = fileInfo?.pixelHeight || null;
  const isRasterImage = Boolean(pixelWidth && !fileInfo?.widthMm);
  // Raster uploads carry no physical size; estimate DPI by assuming the short
  // side is a standard 100mm label edge so low-resolution exports can be flagged.
  const estimatedDpi =
    isRasterImage && pixelWidth && pixelHeight
      ? Math.round(Math.min(pixelWidth, pixelHeight) / (ASSUMED_LABEL_SHORT_EDGE_MM / 25.4))
      : null;
  return {
    widthMm: fileInfo?.widthMm,
    heightMm: fileInfo?.heightMm,
    pageCount: fileInfo?.pageCount || 1,
    pixelWidth,
    pixelHeight,
    isRasterImage,
    estimatedDpi
  };
}
