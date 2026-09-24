// The eParcel audit: decoded-symbol gathering, the evidence context, variant
// selection, and the carrier-specific rule functions.
import { evaluateRuleSet, registerRuleFunction } from '../../ruleEngine.js';
import {
  buildPageContext,
  decodedRawValues,
  diagnosticManualValues,
  normalizeLabelFormat,
  result,
  summarizeValidations,
  validateSelectedAuditMode
} from '../shared/audit.js';
import { addressState, lastAddressLine } from '../shared/text.js';
import { parseSuburbLine } from '../shared/reference.js';
import { normalizeMerchantProfile } from '../shared/merchantProfile.js';
import { gs1LinearComplianceEvidence, parseSsccBarcode } from '../formats/gs1.js';
import { metroLocation } from './metro/area.js';
import { extractLabelFacts } from './facts.js';
import { calculateEparcelCheckDigit, parseEparcelBarcode } from './formats/article.js';
import { dataMatrixComplianceEvidence, looksLikeDataMatrix, parseGs1DataMatrix } from './formats/dataMatrix.js';
import { SERVICE_CODE_MAP, SERVICE_TO_PRODUCT_MAP } from './referenceData.js';
import { ruleSetFor } from './ruleSets.js';
// The SSCC (Serial Shipping Container Code) is an article identifier that, per spec,
// must be carried by the linear (Code 128 / GS1-128) barcode. A GS1 Data Matrix on the
// same label legitimately repeats the SSCC under AI (00) (AI = GS1 Application
// Identifier, the numeric prefix that names a field), so parsing SSCC from any decoded
// symbol would let the Data Matrix stand in for an absent or unreadable linear barcode.
// Classify by decoded symbology only (never by payload content - a real SSCC's digits
// can coincidentally contain "8008"/"420") so the SSCC check reflects the linear scan
// being to spec.
function decodedLinearBarcodes(detectedBarcodes) {
  return detectedBarcodes.filter(b => {
    const fmt = String(b.format || b.symbology || '');
    if (/data[_\s-]?matrix|qr/i.test(fmt)) return false;
    return /code[_\s-]?128|gs1/i.test(fmt) || b.kind === 'linear';
  });
}

// True only when a linear (1D) symbol decoded in its own right; 2D symbols never count.
function decodedLinearPresent(detectedBarcodes) {
  return detectedBarcodes.some(b => {
    const fmt = String(b.format || b.symbology || '');
    // A decoded DataMatrix/QR must never satisfy the "linear barcode present"
    // requirement - the linear symbol has to be readable in its own right.
    if (/data[_\s-]?matrix|qr|aztec|pdf417/i.test(fmt)) return false;
    if (/code[_\s-]?128|gs1/i.test(fmt) || b.kind === 'linear') return true;
    // Content fallback only when the scanner reported no usable symbology.
    return !fmt && parseEparcelBarcode(b.rawValue || '').hasAi91;
  });
}

function decodedDataMatrixPresent(detectedBarcodes) {
  return detectedBarcodes.some(b => looksLikeDataMatrix(b.rawValue || '', b.format || b.symbology || ''));
}

// Reports what the label's text layer exposed (text, header, IDs, weight) as
// informational validation rows, so reviewers can see what fact extraction found.
function validateLabelFacts(facts) {
  const validations = [];
  validations.push(
    facts.extractedLineCount > 0
      ? result(
          'TEXT_EXTRACTED',
          'PDF/text content extracted',
          'INFO',
          'label-layout',
          'pass',
          `${facts.extractedLineCount} text line(s) were extracted from the file.`,
          { evidence: facts.lines.slice(0, 40).join('\n') }
        )
      : result(
          'TEXT_EXTRACTED',
          'PDF/text content extracted',
          'WARNING',
          'label-layout',
          'manual_review',
          'No selectable or OCR text was extracted from this label.'
        )
  );

  validations.push(
    facts.labelType
      ? result(
          'LABEL_TYPE',
          'Label product branding / header',
          'INFO',
          'label-layout',
          'pass',
          `Detected label header text: ${facts.labelType}.`,
          { actual: facts.labelType }
        )
      : result(
          'LABEL_TYPE',
          'Label product branding / header',
          'INFO',
          'label-layout',
          'not_applicable',
          'Product branding/header was not exposed in the PDF text layer. Product family is assessed from the decoded product code instead.'
        )
  );

  validations.push(
    facts.articleIds.length
      ? result(
          'VISIBLE_ARTICLE_ID',
          'Visible AP Article ID text',
          'INFO',
          'address-format',
          'pass',
          `Visible AP Article ID value(s) extracted: ${facts.articleIds.join(', ')}.`,
          { actual: facts.articleIds.join(', ') }
        )
      : result(
          'VISIBLE_ARTICLE_ID',
          'Visible AP Article ID text',
          'INFO',
          'address-format',
          'warning',
          'No visible AP Article ID was extracted from text.'
        )
  );

  validations.push(
    facts.consignmentIds.length
      ? result(
          'VISIBLE_CONS_NO',
          'Visible Cons No text',
          'INFO',
          'address-format',
          'pass',
          `Visible consignment number extracted: ${facts.consignmentIds.join(', ')}.`,
          { actual: facts.consignmentIds.join(', ') }
        )
      : result(
          'VISIBLE_CONS_NO',
          'Visible Cons No text',
          'INFO',
          'address-format',
          'manual_review',
          'No visible Cons No value was extracted.'
        )
  );

  validations.push(
    facts.weightKg
      ? result(
          'WEIGHT_PRESENT',
          'Weight value visible',
          'INFO',
          'label-layout',
          'pass',
          `Weight value found: ${facts.weightKg}kg.`,
          { actual: `${facts.weightKg}kg` }
        )
      : result(
          'WEIGHT_PRESENT',
          'Weight value visible',
          'INFO',
          'label-layout',
          'manual_review',
          'Weight value was not extracted from the text layer or decoded barcode payload.'
        )
  );

  return validations;
}
// The rule functions below are referenced by name from the variant rules.json files
// and run by the rule engine; they cover checks a declarative rule cannot express.
registerRuleFunction('eparcelCheckDigit', article => {
  if (!article?.withoutCheckDigit) {
    return { pass: false, status: 'manual_review', message: 'Article body unavailable for check digit calculation.' };
  }
  const cd = calculateEparcelCheckDigit(article.withoutCheckDigit);
  const pass = cd.checkDigit === article.checkDigit;
  return {
    pass,
    expected: cd.checkDigit,
    actual: article.checkDigit,
    evidence: cd.steps,
    message: pass
      ? `Check digit is valid: ${article.checkDigit}.`
      : `Check digit mismatch. Expected ${cd.checkDigit}, got ${article.checkDigit}.`
  };
});

registerRuleFunction('serviceProductCompatible', article => {
  const service = SERVICE_CODE_MAP[article?.serviceCode];
  if (!service) {
    return {
      pass: true,
      message: `Service code ${article?.serviceCode || 'unknown'} is not recognised; the known-service rule reports that separately.`
    };
  }
  const validProducts = SERVICE_TO_PRODUCT_MAP[article.serviceCode] || [];
  const pass = validProducts.includes(article.productCode);
  return {
    pass,
    expected: validProducts.join(', '),
    actual: article.productCode,
    message: pass
      ? `Service ${article.serviceCode} (${service.name}) supports product ${article.productCode}.`
      : `Service ${article.serviceCode} (${service.name}) does not support product ${article.productCode}.`
  };
});

registerRuleFunction('linearDmAgreement', derived => {
  const linear = [...new Set(derived?.linearArticleIds || [])];
  const dm = [...new Set(derived?.dmArticleIds || [])];
  const pass = dm.every(id => linear.includes(id)) && linear.every(id => dm.includes(id));
  return {
    pass,
    expected: 'identical article numbers in both symbols',
    actual: `linear: ${linear.join(', ') || 'none'} | datamatrix: ${dm.join(', ') || 'none'}`,
    message: pass
      ? 'The linear barcode and DataMatrix encode the same article number(s).'
      : 'The linear barcode and DataMatrix do not encode the same article number(s).'
  };
});

// Metro only delivers to listed localities in five cities (Metro V2.0 page 7). The
// delivery location comes from the barcode postcode plus the printed suburb.
registerRuleFunction('metroInArea', loc => {
  if (!loc?.inArea) {
    return {
      pass: false,
      expected: 'a Metro locality',
      actual: `${loc?.suburb ? `${loc.suburb} ` : ''}${loc?.postcode || 'unknown'}`,
      message: `Delivery postcode ${loc?.postcode} is outside the Metro area. Metro only delivers to listed localities in Adelaide, Brisbane, Melbourne, Perth and Sydney.`
    };
  }
  if (loc.suburbListed === false) {
    return {
      pass: false,
      expected: `a listed ${loc.cityName} Metro locality`,
      actual: `${loc.suburb} ${loc.postcode}`,
      message: `${loc.suburb} isn't a listed Metro locality for postcode ${loc.postcode}, so it may be outside the Metro area. Listed localities include ${loc.listedSuburbs.join(', ')}.`
    };
  }
  return {
    pass: true,
    actual: `${loc.suburb ? `${loc.suburb} ` : ''}${loc.postcode}`,
    message:
      loc.suburbListed === null
        ? `Postcode ${loc.postcode} is in the ${loc.cityName} Metro area. The suburb wasn't read, so confirm it's a listed locality.`
        : `${loc.suburb} ${loc.postcode} is in the ${loc.cityName} Metro area.`
  };
});

// Metro is a same-city service: pickup and delivery must be in the same Metro city.
registerRuleFunction('metroSameCity', route => {
  const { delivery, sender } = route || {};
  if (!sender?.inArea) {
    return {
      pass: false,
      expected: 'a sender inside a Metro city',
      actual: `sender postcode ${sender?.postcode}`,
      message: `Sender postcode ${sender?.postcode} is outside the Metro area. Metro parcels are picked up and delivered within one city. Check the lodgement site if the sender address differs.`
    };
  }
  if (delivery?.inArea && delivery.city !== sender.city) {
    return {
      pass: false,
      expected: `delivery in ${sender.cityName}`,
      actual: `sender ${sender.cityName}, delivery ${delivery.cityName}`,
      message: `The sender is in ${sender.cityName} but the delivery is in ${delivery.cityName}. Metro only runs within one city.`
    };
  }
  return { pass: true, message: `Sender and delivery are both in the ${sender.cityName} Metro area.` };
});

// Assembles the evidence context (page, text, barcodes, derived values) that the
// declarative rule set evaluates against.
function buildEparcelRuleContext({
  fileInfo,
  facts,
  selectedFormat,
  parsed,
  dmParses,
  articles,
  invalidAnalyses,
  validSsccs,
  invalidSsccs,
  decodedLinear,
  decodedDm,
  visualEvidence,
  profile
}) {
  const linearParses = parsed.filter(p => p.hasAi01 !== undefined);
  const gs1Items = [
    ...linearParses.map(p => ({ parse: p, sourceType: 'linear' })),
    ...dmParses
      .map(p => p.base)
      .filter(Boolean)
      .map(p => ({ parse: p, sourceType: 'datamatrix' }))
  ].map(({ parse: p, sourceType }) => ({
    raw: p.raw,
    compact: p.compact,
    prefix16: (p.compact || '').slice(0, 16),
    hasAi01: Boolean(p.hasAi01),
    hasAi91: Boolean(p.hasAi91),
    hasAusPostGtin: Boolean(p.hasAusPostGtin),
    sourceType
  }));
  const toBlock = facts.toBlock || [];
  const fromBlock = facts.fromBlock || [];
  const toPostcodes = [...new Set(toBlock.flatMap(line => String(line).match(/\b\d{4}\b/g) || []))];
  const postcodes4 = [
    ...new Set([...(facts.postcodeLines || []), ...toBlock].flatMap(line => String(line).match(/\b\d{4}\b/g) || []))
  ];
  // Metro area evidence: the barcode's AI 420 postcode is the delivery truth; the printed
  // suburb narrows it to a locality. The sender side comes from the FROM block only.
  const toLine = parseSuburbLine(lastAddressLine(toBlock));
  const fromLine = parseSuburbLine(lastAddressLine(fromBlock));
  const deliveryPostcode = dmParses.find(p => p.postcode)?.postcode || toLine?.postcode || null;
  const metroDelivery = deliveryPostcode ? metroLocation(deliveryPostcode, toLine?.suburb) : null;
  const metroSender = fromLine ? metroLocation(fromLine.postcode, fromLine.suburb) : null;
  return {
    page: buildPageContext(fileInfo),
    text: {
      ...facts,
      toLastLine: lastAddressLine(toBlock),
      fromLastLine: lastAddressLine(fromBlock),
      toPostcodes,
      toState: addressState(lastAddressLine(toBlock)),
      postcodes4,
      labelDates: facts.dateCodeMMDD ? [facts.dateCodeMMDD] : [],
      dgPresent: Boolean(facts.dangerousGoodsDeclarationPresent),
      dgBlock: (facts.dgBlock || []).join('\n')
    },
    barcodes: {
      linearPresent: Boolean(decodedLinear),
      dataMatrixPresent: Boolean(decodedDm),
      linearVisible: Boolean(visualEvidence?.linearBarcodeVisible),
      dataMatrixVisible: Boolean(visualEvidence?.dataMatrixVisible),
      gs1: gs1Items,
      datamatrix: dmParses,
      sscc: { valid: validSsccs, invalid: invalidSsccs }
    },
    articles,
    derived: {
      linearArticleIds: linearParses.map(p => p.article?.articleId).filter(Boolean),
      dmArticleIds: dmParses.map(p => p.base?.article?.articleId).filter(Boolean),
      linearSsccIds: validSsccs.map(s => s.articleId).filter(Boolean),
      invalidArticleReasons: invalidAnalyses.map(a => `${a.candidate}: ${a.reason}`).join('\n'),
      invalidSsccReasons: invalidSsccs.map(s => s.reason).join('\n'),
      metroDelivery,
      metroRoute: metroDelivery && metroSender ? { delivery: metroDelivery, sender: metroSender } : null
    },
    profile,
    selected: { carrier: 'eparcel', format: selectedFormat }
  };
}

// Picks the rule-set variant. Decoded product codes are authoritative; the label's
// header text is only a fallback when no article decoded to a product.
function selectEparcelVariant(selectedFormat, articles, facts) {
  if (selectedFormat === 'sscc') return 'sscc';
  const products = articles.filter(a => a.type === 'eparcel-standard').map(a => a.productCode);
  if (products.some(code => code === '00065' || code === '00068')) return 'returns';
  if (products.some(code => code === '00096' || code === '00087')) return 'express-post';
  if (products.some(code => code === '00121' || code === '00120')) return 'metro';
  if (products.length) return 'parcel-post';
  if (/m2m|metro/i.test(facts?.labelType || '')) return 'metro';
  if (/return/i.test(facts?.labelType || '')) return 'returns';
  if (/express/i.test(facts?.labelType || '')) return 'express-post';
  if (/parcel/i.test(facts?.labelType || '')) return 'parcel-post';
  return 'base';
}

// Entry point for a full eParcel audit of one label: extracts text facts, parses the
// decoded symbols, evaluates the variant rule set, and returns the report payload.
export function auditEparcelLabel({
  fileInfo,
  detectedBarcodes = [],
  manualBarcodes = '',
  extractedText = '',
  visualEvidence = null,
  labelFormat = 'standard',
  merchantProfile = null
}) {
  const validations = [];
  const selectedFormat = normalizeLabelFormat(labelFormat);
  const profile = normalizeMerchantProfile(merchantProfile || {});
  const facts = extractLabelFacts(extractedText);
  const manualValues = diagnosticManualValues(manualBarcodes);
  const decodedValues = decodedRawValues(detectedBarcodes);

  validations.push(...validateLabelFacts(facts));

  const decodedLinear = decodedLinearPresent(detectedBarcodes);
  const decodedDm = decodedDataMatrixPresent(detectedBarcodes);

  const parsed = detectedBarcodes
    .map(b => ({
      raw: b.rawValue || b.raw || b.text || '',
      format: b.format || b.symbology || '',
      symbologyIdentifier: b.symbologyIdentifier || '',
      decoderSource: b.source || ''
    }))
    .filter(s => s.raw)
    .map(s =>
      looksLikeDataMatrix(s.raw, s.format)
        ? { ...parseGs1DataMatrix(s.raw), ...dataMatrixComplianceEvidence(s) }
        : parseEparcelBarcode(s.raw)
    );
  // SSCC is proven by the linear barcode only (EP-SS-01); never let a GS1 Data
  // Matrix that repeats AI (00) SSCC stand in for the linear scan. Each parse keeps
  // the decoder's ISO/IEC 15424 symbology identifier: ]C1 is the only digital proof
  // the symbol starts with FNC1 (GS1-128), assessed by EP-SS-09.
  const ssccParses = decodedLinearBarcodes(detectedBarcodes)
    .filter(b => b.rawValue || b.raw || b.text)
    .map(b => ({
      ...parseSsccBarcode(b.rawValue || b.raw || b.text || ''),
      ...gs1LinearComplianceEvidence({
        raw: b.rawValue || b.raw || b.text || '',
        symbologyIdentifier: b.symbologyIdentifier,
        decoderSource: b.source
      })
    }))
    .filter(p => p.type === 'sscc' && p.valid !== undefined && p.raw);
  const validSsccs = ssccParses.filter(p => p.valid);
  const invalidSsccs = ssccParses.filter(p => !p.valid);
  const articleMap = new Map();
  for (const article of parsed.map(p => p.article || p.base?.article).filter(Boolean)) {
    articleMap.set(article.articleId || article.sscc, article);
  }
  const allArticles = [...articleMap.values()];
  const standardArticles = allArticles.filter(article => article.type === 'eparcel-standard');
  const articles =
    selectedFormat === 'sscc' ? allArticles.filter(article => article.type === 'sscc') : standardArticles;
  const invalidMap = new Map();
  for (const invalid of parsed.map(p => p.articleAnalysis || p.base?.articleAnalysis).filter(a => a && !a.valid)) {
    invalidMap.set(invalid.candidate, invalid);
  }
  const invalidAnalyses = [...invalidMap.values()];
  const dmParses = parsed.filter(p => 'hasAi420' in p);
  const detectedCarrier = standardArticles.length || dmParses.length || validSsccs.length ? 'eparcel' : 'unknown';
  const detectedFormat =
    validSsccs.length && !standardArticles.length
      ? 'sscc'
      : standardArticles.length
        ? 'standard'
        : validSsccs.length
          ? 'sscc'
          : 'unknown';
  const modeEvidence = [
    standardArticles.length ? `standard eParcel article(s): ${standardArticles.map(a => a.articleId).join(', ')}` : '',
    validSsccs.length ? `SSCC barcode(s): ${validSsccs.map(s => `00${s.sscc}`).join(', ')}` : '',
    dmParses.length ? `GS1 DataMatrix parse(s): ${dmParses.length}` : ''
  ]
    .filter(Boolean)
    .join('\n');
  validations.unshift(
    ...validateSelectedAuditMode({
      selectedCarrier: 'eparcel',
      selectedFormat,
      detectedCarrier,
      detectedFormat,
      evidence: modeEvidence || decodedValues.join('\n')
    })
  );

  for (const [i, article] of articles.entries()) {
    if (article.type === 'sscc') {
      validations.push(
        result(
          `SSCC_${i}`,
          'SSCC article detected',
          'INFO',
          'sscc',
          'pass',
          `SSCC detected: ${article.sscc}. Embedded product/service/check-digit validation does not apply.`,
          { actual: article.sscc }
        )
      );
    }
  }

  const ruleContext = buildEparcelRuleContext({
    fileInfo,
    facts,
    selectedFormat,
    parsed,
    dmParses,
    articles,
    invalidAnalyses,
    validSsccs,
    invalidSsccs,
    decodedLinear,
    decodedDm,
    visualEvidence,
    profile
  });
  const ruleVariant = selectEparcelVariant(selectedFormat, articles, facts);
  const ruleSet = ruleSetFor(ruleVariant);
  validations.push(...evaluateRuleSet(ruleSet, ruleContext));

  const summary = summarizeValidations(validations);

  return {
    generatedAt: new Date().toISOString(),
    carrier: 'eparcel',
    fileInfo,
    labelFacts: facts,
    visualEvidence,
    detectedBarcodes,
    manualBarcodeCount: manualValues.length,
    selectedAuditMode: { carrier: 'eparcel', labelFormat: selectedFormat },
    merchantProfileActive: profile.active,
    ruleSet: { id: ruleSet.id, name: ruleSet.name, variant: ruleVariant, spec: ruleSet.spec || null },
    parsed,
    articles,
    invalidArticleCandidates: invalidAnalyses,
    summary,
    validations
  };
}
