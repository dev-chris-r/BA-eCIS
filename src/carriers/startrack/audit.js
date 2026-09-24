// The StarTrack audit: decoded-symbol classification, the evidence context,
// variant selection, and the carrier-specific rule functions.
import { evaluateRuleSet, registerRuleFunction, resolvePath } from '../../ruleEngine.js';
import {
  buildPageContext,
  decodedRawValues,
  diagnosticManualValues,
  normalizeLabelFormat,
  result,
  summarizeValidations,
  validateSelectedAuditMode
} from '../shared/audit.js';
import { uniqueNonEmpty } from '../shared/text.js';
import { normalizeMerchantProfile } from '../shared/merchantProfile.js';
import { gs1LinearComplianceEvidence, parseSsccBarcode } from '../formats/gs1.js';
import { findLocation } from './formats/locationMasterFile.js';
import { enrichStarTrackFactsFromDecodedData, extractStarTrackFacts } from './facts.js';
import { parseStarTrackFreightItemBarcode } from './formats/freightItem.js';
import { parseStarTrackRoutingBarcode } from './formats/routing.js';
import { parseStarTrackAtlBarcode } from './formats/atl.js';
import { parseStarTrackQrBarcode, ST_QR_MANDATORY_FIELDS } from './formats/qr.js';
import { STARTRACK_PRODUCT_CODE_MAP, STARTRACK_UNIT_TYPE_MAP } from './referenceData.js';
import { ruleSetFor } from './ruleSets.js';
// The routing barcode's label code must match the code the decoded product maps to
// (e.g. product FPP routes under label code PRM); a product with no mapping asserts nothing.
registerRuleFunction('routeProductMatch', (route, { context }) => {
  const product = resolvePath('derived.primaryProductCode', context);
  const expectedLabelCode = STARTRACK_PRODUCT_CODE_MAP[product]?.labelCode;
  if (!expectedLabelCode) {
    return { pass: true, message: `Product ${product || 'unknown'} has no routing label code mapping to assert.` };
  }
  const pass = route?.labelCode === expectedLabelCode;
  return {
    pass,
    expected: expectedLabelCode,
    actual: route?.labelCode || 'missing',
    message: pass
      ? `Routing label code ${route.labelCode} matches product ${product}.`
      : `Routing label code ${route?.labelCode || 'missing'} does not match product ${product}.`
  };
});

// One-way cross-check of the printed RC/R1/R2 receiver location codes against the values
// derived from decoded barcodes (MOS v9 1.009-1.011.1). Text is only compared AGAINST the
// decoded routing/QR data, never used as a value source; a miss is manual review because
// text extraction is a soft signal.
registerRuleFunction('receiverLocationCodesShown', (codes, { context }) => {
  const upper = (context?.text?.lines || []).join('\n').toUpperCase();
  const tokens = [...new Set([codes?.rc, codes?.r1, codes?.r2].filter(Boolean))];
  const missing = tokens.filter(token => !new RegExp(`\\b${token}\\b`).test(upper));
  const expected = `RC=${codes?.rc || '?'}, R1=${codes?.r1 || 'blank'}, R2=${codes?.r2 || 'blank'}`;
  const pass = tokens.length > 0 && missing.length === 0;
  const fromLmf = codes?.source === 'lmf';
  return {
    pass,
    expected,
    actual: pass ? `found in label text: ${tokens.join(' ')}` : `not found in extracted text: ${missing.join(', ')}`,
    message: pass
      ? fromLmf
        ? `The label prints ${expected}, matching the Location Master File.`
        : `The label prints ${expected}, matching the barcodes. Load the Location Master File to confirm the depot and ports themselves.`
      : `The label should print ${missing.join(', ')} (${fromLmf ? 'from the Location Master File' : 'from the routing and QR barcodes'}), but they weren't found in the label text. Check the RC/R1/R2 line beside the routing barcode.`
  };
});

// The Location Master File is StarTrack's list of delivery locations (MOS v9 page 8).
// A delivery suburb and postcode missing from it may not be serviced, so it warns.
registerRuleFunction('lmfLocationFound', lmf => {
  const where = `${lmf?.suburb ? `${lmf.suburb} ` : ''}${lmf?.postcode || ''}`.trim();
  if (lmf?.match) {
    return {
      pass: true,
      actual: where,
      message: `${where} is a StarTrack delivery location in the Location Master File.`
    };
  }
  if (!lmf?.candidateCount) {
    return {
      pass: false,
      expected: 'a postcode listed in the Location Master File',
      actual: where || 'no postcode decoded',
      message: `Postcode ${lmf?.postcode || 'unknown'} isn't in the Location Master File, so StarTrack may not deliver there. Check the postcode, and that the file matches this merchant's despatch site.`
    };
  }
  if (!lmf.suburb) {
    return {
      pass: false,
      status: 'manual_review',
      actual: where,
      message: `Postcode ${lmf.postcode} is in the Location Master File, but no suburb was decoded, so the exact location couldn't be matched.`
    };
  }
  return {
    pass: false,
    expected: `a suburb listed for ${lmf.postcode}`,
    actual: where,
    message: `${lmf.suburb} isn't listed for postcode ${lmf.postcode} in the Location Master File. Listed suburbs include ${lmf.candidateSuburbs.join(', ')}. Check the spelling.`
  };
});

/** Which LMF column a depot value must come from: Premium uses ports, Express and
 *  Special Services use the Nearest Depot (MOS v9 1.009, 1.010, QR field 15). */
function lmfExpectation(lmf, kind) {
  if (!lmf?.match) return null;
  if (kind === 'routing') {
    return lmf.premium
      ? { value: lmf.match.primaryPort, column: 'Primary Port' }
      : { value: lmf.match.nearestDepot, column: 'Nearest Depot' };
  }
  return lmf.premium
    ? { value: lmf.match.secondaryPort, column: 'Secondary Port' }
    : { value: lmf.match.nearestDepot, column: 'Nearest Depot' };
}

registerRuleFunction('lmfRoutingDepot', (route, { context }) => {
  const lmf = resolvePath('derived.lmf', context);
  const want = lmfExpectation(lmf, 'routing');
  const got = String(route?.depotOrPort || '').toUpperCase();
  const where = `${lmf.match.suburb} ${lmf.match.postcode}`;
  const pass = got === want.value;
  return {
    pass,
    expected: want.value,
    actual: got,
    message: pass
      ? `Routing depot ${got} matches the Location Master File ${want.column} for ${where}.`
      : `Routing depot ${got} should be ${want.value}, the Location Master File ${want.column} for ${where}.`
  };
});

registerRuleFunction('lmfQrDepot', (depot, { context }) => {
  const lmf = resolvePath('derived.lmf', context);
  const want = lmfExpectation(lmf, 'qr');
  const got = String(depot || '')
    .trim()
    .toUpperCase();
  const where = `${lmf.match.suburb} ${lmf.match.postcode}`;
  const pass = got === want.value;
  return {
    pass,
    expected: want.value,
    actual: got || 'blank',
    message: pass
      ? `QR destination depot ${got} matches the Location Master File ${want.column} for ${where}.`
      : `QR destination depot ${got || 'is blank and'} should be ${want.value}, the Location Master File ${want.column} for ${where}.`
  };
});

// Depot and port destinations are issued from StarTrack's Location Master File, which has
// no digital lookup, so every decoded routing barcode is held at manual review instead of
// passing outright (ST-RTE-05). The GS1 421 routing form carries no depot segment; there the
// sortation destination lives in the QR destination depot, which needs the same manual check.
registerRuleFunction('routingDepotManualReview', route => {
  const depot = String(route?.depotOrPort || '').toUpperCase();
  return {
    pass: false,
    status: 'manual_review',
    expected: 'depot/port confirmed against the StarTrack Location Master File',
    actual: depot || 'no depot segment (GS1 421 routing form)',
    message: depot
      ? `Depot ${depot} is well-formed, but depots come from StarTrack's Location Master File. Load the file in the merchant profile panel to check it, or confirm it with StarTrack.`
      : 'This GS1 421 routing barcode has no depot, so the QR destination depot decides the sortation. Load the Location Master File in the merchant profile panel to check it, or confirm it with StarTrack.'
  };
});

// Every field the QR spec marks mandatory must decode non-blank (list defined in formats/qr.js).
registerRuleFunction('qrMandatoryFields', fields => {
  const missing = ST_QR_MANDATORY_FIELDS.filter(([key]) => !String(fields?.[key] || '').trim()).map(
    ([, label]) => label
  );
  return {
    pass: missing.length === 0,
    expected: 'all mandatory QR fields populated',
    actual: missing.length ? `missing: ${missing.join(', ')}` : 'all populated',
    message: missing.length
      ? `QR mandatory fields missing: ${missing.join(', ')}.`
      : 'Mandatory QR fields are populated.'
  };
});

// The QR unit type (the packaging unit, e.g. carton or pallet) must be an Appendix A unit the
// spec permits for the decoded product; an unknown unit or unlisted pairing cannot be confirmed.
registerRuleFunction('startrackUnitPermitted', fields => {
  const unitType = fields?.unitType;
  const allowed = STARTRACK_UNIT_TYPE_MAP[unitType] || [];
  const pass = Boolean(allowed.length && (!fields?.productCode || allowed.includes(fields.productCode)));
  return {
    pass,
    expected: allowed.length ? `unit ${unitType} permitted for: ${allowed.join(', ')}` : 'a known Appendix A unit type',
    actual: `${unitType || 'blank'} for product ${fields?.productCode || 'unknown'}`,
    message: pass
      ? `Unit type ${unitType} is permitted${fields?.productCode ? ` for ${fields.productCode}` : ''}.`
      : `Unit type ${unitType || 'blank'} could not be confirmed against product ${fields?.productCode || 'unknown'}.`
  };
});

// Assembles the context object the JSON rule sets resolve their paths against:
// page geometry, visible-text facts, classified barcode parses, and derived cross-check values.
function buildStarTrackRuleContext({
  fileInfo,
  facts,
  rawFacts = null,
  selectedFormat,
  qrParses,
  freightParses,
  routingParses,
  atlParses,
  validSsccs,
  invalidSsccs,
  unclassifiedLinear = [],
  expectedAtlNumbers,
  atlExpected,
  visualEvidence,
  profile,
  locationMasterFile = null
}) {
  const lines = facts.lines || [];
  const hasStarTrackHeaderText = lines.some(l => /STAR\s*TRACK|STARTRACK/i.test(l));
  // A decoded StarTrack barcode is authoritative proof of label identity, so it
  // confirms the StarTrack header without needing OCR of the logo wordmark.
  const starTrackBarcodeDecoded =
    qrParses.length > 0 ||
    freightParses.length > 0 ||
    routingParses.length > 0 ||
    atlParses.length > 0 ||
    validSsccs.length > 0;
  const primaryProductCode = freightParses[0]?.productCode || qrParses[0]?.productCode || '';
  // Receiver location codes RC/R1/R2 printed with the routing barcode (MOS v9 1.009-1.011.1):
  // expectations derive from decoded data only. Premium-group products print R1 = Primary
  // Port (the routing barcode depot segment) and R2 = Secondary Port (the QR destination
  // depot); Express/Special Services print R2 = Nearest Depot (the routing depot segment);
  // NZ Premium (routing postcode 9901) prints the fixed NZ/SYD/ZNA trio. LMF validity
  // cannot be checked digitally - this only pins the values the label must repeat.
  const routeWithDepot = routingParses.find(r => r.depotOrPort) || null;
  const qrDepot =
    String(qrParses[0]?.fields?.destinationDepot || '')
      .trim()
      .toUpperCase() || null;
  const premiumGroup =
    STARTRACK_PRODUCT_CODE_MAP[primaryProductCode]?.group === 'Premium services' ||
    (!primaryProductCode && ['PRM', 'ARL'].includes((routeWithDepot || routingParses[0])?.labelCode));
  // Location Master File match for the delivery location: the QR suburb and postcode are
  // the decoded truth (routing postcode as fallback). NZ (9901) is out of scope here.
  const lmfPostcode = qrParses[0]?.fields?.receiverPostcode || routingParses[0]?.postcode || '';
  const lmfSuburb = qrParses[0]?.fields?.receiverSuburb || '';
  let lmf = { loaded: false };
  if (locationMasterFile?.byPostcode && lmfPostcode && lmfPostcode !== '9901') {
    const { candidates, match } = findLocation(locationMasterFile, lmfPostcode, lmfSuburb);
    lmf = {
      loaded: true,
      postcode: lmfPostcode,
      suburb: lmfSuburb.trim().toUpperCase() || null,
      match,
      premium: premiumGroup,
      candidateCount: candidates.length,
      candidateSuburbs: candidates.slice(0, 6).map(r => r.suburb)
    };
  }
  let receiverLocationCodes = null;
  if (lmf.match) {
    // With the LMF loaded, the printed codes are checked against its values directly.
    receiverLocationCodes = premiumGroup
      ? { rc: 'AU', r1: lmf.match.primaryPort, r2: lmf.match.secondaryPort, source: 'lmf' }
      : { rc: 'AU', r1: null, r2: lmf.match.nearestDepot, source: 'lmf' };
  } else if (routeWithDepot) {
    const routeDepot = String(routeWithDepot.depotOrPort).toUpperCase();
    receiverLocationCodes =
      routeWithDepot.postcode === '9901'
        ? { rc: 'NZ', r1: 'SYD', r2: 'ZNA', source: 'barcodes' }
        : premiumGroup
          ? { rc: 'AU', r1: routeDepot, r2: qrDepot, source: 'barcodes' }
          : { rc: 'AU', r1: null, r2: routeDepot, source: 'barcodes' };
  }
  // Pre-enrichment (print-only) facts back the visible-content checks; the enriched
  // facts remain available for rules where decoded data is a legitimate source.
  const visible = rawFacts || facts;
  return {
    page: buildPageContext(fileInfo),
    text: {
      ...facts,
      hasStarTrackHeader: hasStarTrackHeaderText,
      returnTransferIndicator: ((lines.join('\n').match(/\*\s*(RETURN|TRANSFER)\s*\*/i) || [])[0] || '').trim(),
      visibleLabelCode: visible.labelCode || '',
      visibleConsignmentIds: visible.consignmentIds || [],
      visibleArticleIds: visible.articleIds || [],
      visibleWeightKg: visible.weightKg || '',
      visibleCube: visible.cube || '',
      visibleUnit: visible.unit || '',
      visibleSsccIds: visible.visibleSsccIds || []
    },
    barcodes: {
      qrPresent: qrParses.length > 0,
      freightPresent: freightParses.length > 0,
      routingPresent: routingParses.length > 0,
      linearVisible: Boolean(visualEvidence?.linearBarcodeVisible),
      dataMatrixVisible: Boolean(visualEvidence?.dataMatrixVisible),
      qr: qrParses,
      freight: freightParses,
      routing: routingParses,
      atl: atlParses,
      linearUnclassified: unclassifiedLinear,
      sscc: { valid: validSsccs, invalid: invalidSsccs }
    },
    derived: {
      qrPostcodes: uniqueNonEmpty(qrParses.map(q => q.fields?.receiverPostcode)),
      freightConnotes: uniqueNonEmpty(freightParses.map(f => f.connoteNumber)),
      freightIds: uniqueNonEmpty(freightParses.map(f => f.freightItemId)),
      primaryProductCode,
      receiverLocationCodes,
      expectedAtlNumbers,
      atlExpected: Boolean(atlExpected),
      starTrackConfirmed: starTrackBarcodeDecoded || hasStarTrackHeaderText,
      invalidSsccReasons: invalidSsccs.map(s => s.reason).join('\n'),
      // Print-only evidence: the receiver block must actually be printed on the
      // label, so QR-backfilled address data must not satisfy this check.
      receiverEvidence: [...(visible.toBlock || []), ...(visible.postcodeLines || [])],
      // Every despatch ID the label carries: freight item barcodes and QR connotes.
      despatchIds: uniqueNonEmpty([
        ...freightParses.map(f => f.despatchId),
        ...qrParses.map(q => String(q.fields?.connoteNumber || '').slice(0, 4))
      ]),
      lmf,
      lmfValidated: Boolean(lmf.match)
    },
    profile,
    selected: { carrier: 'startrack', format: selectedFormat }
  };
}

/** Picks the rule-set variant from the selected format or the decoded product codes. */
function selectStarTrackVariant(selectedFormat, productCodes) {
  if (selectedFormat === 'sscc') return 'sscc';
  const codes = productCodes.filter(Boolean);
  if (codes.some(c => c === 'FPP' || c === 'FPA')) return 'fpp';
  if (codes.some(c => ['PRM', 'APT', 'ARL'].includes(c))) return 'premium';
  if (codes.some(c => ['EXP', 'TSE', 'RET', 'RE2'].includes(c))) return 'express';
  return 'base';
}

/** Validates StarTrack visible-content facts before the barcode-specific checks are added. */
function validateStarTrackTextFacts(facts) {
  const validations = [];
  const lineCount = facts.extractedLineCount;
  validations.push(
    lineCount > 0
      ? result(
          'ST_TEXT_EXTRACTED',
          'Label text read',
          'INFO',
          'startrack-label-layout',
          'pass',
          `${lineCount} ${lineCount === 1 ? 'line' : 'lines'} of text read.`,
          { evidence: facts.lines.slice(0, 50).join('\n') }
        )
      : result(
          'ST_TEXT_EXTRACTED',
          'Label text read',
          'WARNING',
          'startrack-label-layout',
          'manual_review',
          'No text could be read. The barcodes are still checked.'
        )
  );
  return validations;
}

/** Runs the full StarTrack rule set against one rendered label/page. */
export function auditStarTrackLabel({
  fileInfo,
  detectedBarcodes = [],
  manualBarcodes = '',
  extractedText = '',
  visualEvidence = null,
  labelFormat = 'standard',
  merchantProfile = null,
  locationMasterFile = null
}) {
  const validations = [];
  const selectedFormat = normalizeLabelFormat(labelFormat);
  const profile = normalizeMerchantProfile(merchantProfile || {});
  let facts = extractStarTrackFacts(extractedText);
  const manualValues = diagnosticManualValues(manualBarcodes);
  const decodedValues = decodedRawValues(detectedBarcodes);
  // 2D formats are excluded outright: "qr_code" would otherwise match /code/, letting a QR
  // payload starting with "00" + 18 digits masquerade as the SSCC (Serial Shipping Container
  // Code, the GS1 article identifier) linear symbol.
  const linearBarcodes = detectedBarcodes.filter(b => {
    const fmt = String(b.format || b.symbology || '');
    if (/qr|data[_\s-]?matrix|aztec|pdf417/i.test(fmt)) return false;
    return /128|code/i.test(fmt) || b.kind === 'linear';
  });
  const linearValues = linearBarcodes.map(b => b.rawValue).filter(Boolean);
  const qrValues = detectedBarcodes
    .filter(b => /qr/i.test(String(b.format || b.symbology || '')) || b.kind === 'qr')
    .map(b => b.rawValue)
    .filter(Boolean);

  const qrParses = qrValues.map(parseStarTrackQrBarcode).filter(p => p.valid);
  // The scan pipeline measures the bar count of Code 128 symbols; it rides
  // along with the parsed freight item as encodation evidence (ST-FRT-09).
  const freightParses = linearBarcodes
    .filter(b => b.rawValue)
    .map(b => {
      const parsed = parseStarTrackFreightItemBarcode(b.rawValue);
      return parsed.valid && Number.isInteger(b.barCount) ? { ...parsed, barCount: b.barCount } : parsed;
    })
    .filter(p => p.valid);
  // SSCC is an article identifier carried by the linear (Code 128) freight barcode,
  // so parse it from linear decodes only. Sourcing from every decoded value would let
  // a "00" + 18-digit run inside the QR payload masquerade as an SSCC article.
  // Each parse keeps the decoder's ISO/IEC 15424 symbology identifier: ]C1 is the only
  // digital proof the symbol starts with FNC1 (GS1-128), assessed by ST-SSC-09.
  const ssccParses = linearBarcodes
    .filter(b => b.rawValue)
    .map(b => ({
      ...parseSsccBarcode(b.rawValue),
      ...gs1LinearComplianceEvidence({
        raw: b.rawValue,
        symbologyIdentifier: b.symbologyIdentifier,
        decoderSource: b.source
      }),
      // The captured byte stream, so the report can show the barcode exactly as scanned.
      rawBytes: b.rawBytes || ''
    }))
    .filter(p => p.type === 'sscc' && p.valid !== undefined && p.raw);
  const validSsccs = ssccParses.filter(p => p.valid);
  const invalidSsccs = ssccParses.filter(p => !p.valid);
  const routingParses = linearValues.map(parseStarTrackRoutingBarcode).filter(p => p.valid);
  const atlParses = linearValues.map(parseStarTrackAtlBarcode).filter(p => p.valid);
  // Linear symbols that decoded but match no StarTrack structure are surfaced for
  // review instead of silently disappearing as "not decoded" - the symbol DID read,
  // its content is just malformed or foreign.
  const classifiedLinearValues = new Set(
    [...freightParses, ...routingParses, ...atlParses, ...ssccParses].map(p => p.raw)
  );
  const unclassifiedLinear = uniqueNonEmpty(linearValues.filter(v => !classifiedLinearValues.has(v))).map(value => ({
    value,
    reasons: [
      parseStarTrackFreightItemBarcode(value).reason,
      parseStarTrackRoutingBarcode(value).reason,
      parseStarTrackAtlBarcode(value).reason,
      parseSsccBarcode(value).reason
    ]
      .filter(Boolean)
      .join('\n')
  }));
  // ATL (Authority To Leave) evidence: printed ATL text/numbers or a QR ATL number
  // mean an ATL barcode is expected on the label.
  const expectedAtlNumbers = uniqueNonEmpty([
    ...(facts.visibleAtlNumbers || []),
    ...qrParses.map(q => q.fields?.atlNumber).filter(Boolean)
  ]);
  const atlExpected = Boolean(facts.authorityToLeavePresent || expectedAtlNumbers.length);
  const ssccOnly = selectedFormat === 'sscc' || (validSsccs.length > 0 && freightParses.length === 0);
  const detectedCarrier =
    qrParses.length ||
    freightParses.length ||
    routingParses.length ||
    atlParses.length ||
    validSsccs.length ||
    /STAR\s*TRACK|STARTRACK/i.test(extractedText || '')
      ? 'startrack'
      : 'unknown';
  // An SSCC that fails its check digit is still format evidence: the AI 00 + 18-digit
  // shape identifies the label format, and the check-digit rule reports the failure.
  const ssccShaped = ssccParses.length > 0;
  const detectedFormat =
    ssccShaped && !freightParses.length ? 'sscc' : freightParses.length ? 'standard' : ssccShaped ? 'sscc' : 'unknown';
  const modeEvidence = [
    qrParses.length ? `StarTrack QR payload(s): ${qrParses.length}` : '',
    freightParses.length ? `freight item barcode(s): ${freightParses.map(f => f.freightItemId).join(', ')}` : '',
    validSsccs.length ? `SSCC barcode(s): ${validSsccs.map(s => `00${s.sscc}`).join(', ')}` : '',
    invalidSsccs.length
      ? `SSCC barcode(s) failing their check digit: ${invalidSsccs.map(s => `00${s.sscc}`).join(', ')}`
      : '',
    routingParses.length ? `routing barcode(s): ${routingParses.map(r => r.raw).join(', ')}` : ''
  ]
    .filter(Boolean)
    .join('\n');

  // Keep the pre-enrichment facts: rules that verify what is PRINTED on the label
  // must compare against text-only evidence, never against values backfilled from
  // the very barcodes they are meant to cross-check.
  const rawFacts = facts;
  facts = enrichStarTrackFactsFromDecodedData(facts, { qrParses, freightParses, routingParses, validSsccs });
  validations.push(
    ...validateSelectedAuditMode({
      selectedCarrier: 'startrack',
      selectedFormat,
      detectedCarrier,
      detectedFormat,
      evidence: modeEvidence || decodedValues.join('\n'),
      formatReason:
        detectedFormat === 'standard'
          ? `freight item barcode ${freightParses[0].freightItemId} was read`
          : detectedFormat === 'sscc'
            ? `SSCC barcode 00${ssccParses[0].sscc} was read`
            : ''
    })
  );
  validations.push(...validateStarTrackTextFacts(facts));
  // SSCC validation only runs when the user explicitly selected SSCC mode, or when
  // auto-detection found only SSCC barcodes (no freight item barcodes). SSCC is now
  // parsed from linear decodes only, but the gate still keeps a coincidental "00" +
  // 18-digit linear run on a standard label from raising false CRITICAL failures.
  if (ssccOnly) {
    for (const [i, sscc] of validSsccs.entries()) {
      validations.push(
        result(
          `ST_SSCC_${i}`,
          'SSCC freight item detected',
          'INFO',
          'startrack-sscc',
          'pass',
          `Valid AI 00 SSCC detected: 00${sscc.sscc}.`,
          { actual: `00${sscc.sscc}` }
        )
      );
    }
    for (const [i, sscc] of invalidSsccs.entries()) {
      validations.push(
        result(`ST_SSCC_INVALID_${i}`, 'SSCC check digit', 'CRITICAL', 'startrack-sscc', 'fail', sscc.reason, {
          expected: sscc.expectedCheckDigit,
          actual: sscc.checkDigit
        })
      );
    }
    if (selectedFormat !== 'sscc') {
      validations.push(
        result(
          'ST_SSCC_PRODUCT_RULE',
          'SSCC product handling',
          'INFO',
          'startrack-sscc',
          'pass',
          'SSCC freight labels encode AI 00 SSCC data. StarTrack product may be supplied by QR/routing data, but it is not embedded in the SSCC article identifier.'
        )
      );
    }
  }

  const ruleContext = buildStarTrackRuleContext({
    fileInfo,
    facts,
    rawFacts,
    selectedFormat,
    qrParses,
    freightParses,
    routingParses,
    atlParses,
    validSsccs,
    invalidSsccs,
    unclassifiedLinear,
    expectedAtlNumbers,
    atlExpected,
    visualEvidence,
    profile,
    locationMasterFile
  });
  const ruleVariant = selectStarTrackVariant(selectedFormat, [
    ...freightParses.map(f => f.productCode),
    ...qrParses.map(q => q.productCode),
    facts.labelCode
  ]);
  const ruleSet = ruleSetFor(ruleVariant);
  validations.push(...evaluateRuleSet(ruleSet, ruleContext));

  const summary = summarizeValidations(validations);
  const articles = [
    ...freightParses.map(f => ({ type: 'startrack-code128-freight', articleId: f.freightItemId, ...f })),
    ...validSsccs.map(s => ({ type: 'sscc', articleId: `00${s.sscc}`, sscc: `00${s.sscc}`, ...s }))
  ];
  return {
    generatedAt: new Date().toISOString(),
    carrier: 'startrack',
    fileInfo,
    labelFacts: facts,
    visualEvidence,
    detectedBarcodes,
    manualBarcodeCount: manualValues.length,
    selectedAuditMode: { carrier: 'startrack', labelFormat: selectedFormat },
    merchantProfileActive: profile.active,
    locationMasterFileLoaded: Boolean(locationMasterFile?.byPostcode),
    ruleSet: { id: ruleSet.id, name: ruleSet.name, variant: ruleVariant, spec: ruleSet.spec || null },
    parsed: [...qrParses, ...freightParses, ...routingParses, ...atlParses, ...validSsccs],
    startrack: { qrParses, freightParses, routingParses, ssccParses: validSsccs, atlParses, ssccOnly },
    articles,
    invalidArticleCandidates: [],
    summary,
    validations
  };
}
