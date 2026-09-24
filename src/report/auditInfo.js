// Pure helpers that read the audit result object: header/summary data for the
// rail and report chrome, decoded-barcode grouping, and copy-all text.
import {
  FORMAT_KIND,
  hasFnc1First,
  isDataMatrixBarcode,
  isLinearBarcode,
  isQrBarcode
} from '../scanner/barcodeTypes.js';
import { rawContentOf, rawCopyText } from './readerData.js';
import { isStarTrackAtlValue, isStarTrackFreightItemValue, isStarTrackRoutingValue } from '../scanner/labelImages.js';
import { SERVICE_CODE_MAP, STARTRACK_PRODUCT_CODE_MAP } from '../auditEngine.js';

export function selectedServiceCodes(audit) {
  return [...new Set((audit?.articles || []).map(a => a.serviceCode).filter(Boolean))];
}

export function selectedProductCodes(audit) {
  return [...new Set((audit?.articles || []).map(a => a.productCode).filter(Boolean))];
}

/** True when the label carries only SSCC data (SSCC = the GS1 Serial Shipping Container Code):
 *  the user selected the SSCC format, or an SSCC parsed and no standard eParcel article did. */
export function auditHasSsccOnly(audit) {
  const articles = audit?.articles || [];
  return (
    audit?.selectedAuditMode?.labelFormat === 'sscc' ||
    (articles.some(a => a?.type === 'sscc') && !articles.some(a => a?.type === 'eparcel-standard'))
  );
}

function isSsccArticle(article) {
  return article?.type === 'sscc';
}
/** Decoded barcodes of one symbol family; 'linear' means strictly 1D (DataMatrix/QR excluded). */
export function decodedBarcodeList(audit, type) {
  const all = audit?.detectedBarcodes || [];
  if (type === 'datamatrix') return all.filter(isDataMatrixBarcode);
  if (type === 'qr') return all.filter(isQrBarcode);
  if (type === 'linear') return all.filter(b => isLinearBarcode(b) && !isDataMatrixBarcode(b) && !isQrBarcode(b));
  return all;
}

export function starTrackRoutingBarcodeList(audit) {
  return decodedBarcodeList(audit, 'linear').filter(b => isStarTrackRoutingValue(b.rawValue));
}

export function starTrackAtlBarcodeList(audit) {
  return decodedBarcodeList(audit, 'linear').filter(b => isStarTrackAtlValue(b.rawValue));
}

export function starTrackFreightBarcodeList(audit) {
  return decodedBarcodeList(audit, 'linear').filter(b => isStarTrackFreightItemValue(b.rawValue));
}

/** Human-readable symbology name, tolerant of the varied format/symbology strings decoders emit.
 *  "GS1" is claimed only when the symbology identifier proves FNC1 in the first position. */
export function barcodeDisplayName(b) {
  const value = String(b?.format || b?.symbology || '').toLowerCase();
  if (value.includes('data')) return hasFnc1First(b?.symbologyIdentifier) ? 'GS1 DataMatrix' : 'DataMatrix';
  if (value.includes('qr') || b?.kind === FORMAT_KIND.qr) return 'QR Barcode';
  if (value.includes('128') || b?.kind === FORMAT_KIND.linear) return 'Linear / Code128';
  return b?.format || b?.symbology || 'barcode';
}

/** Assembles a labelled block per decoded barcode on the label, in report order, for
 *  the header "copy all" action:
 *
 *    Label:
 *    ------------------
 *    raw value
 *    ------------------
 *
 *  Raw values are the captured bytes with each FNC1 separator written as <GS> (fixed-width
 *  QR payloads keep their padding), deduped so a symbol decoded on multiple passes is
 *  copied once; anything not covered by a named group falls back to its display name. */
export function allBarcodesCopyText(audit) {
  const groups =
    audit?.carrier === 'startrack'
      ? [
          ['StarTrack 2D QR barcode', decodedBarcodeList(audit, 'qr')],
          ['Routing barcode', starTrackRoutingBarcodeList(audit)],
          ['ATL barcode', starTrackAtlBarcodeList(audit)],
          ['Freight item barcode', starTrackFreightBarcodeList(audit)]
        ]
      : [
          ['Linear barcode', decodedBarcodeList(audit, 'linear')],
          ['DataMatrix barcode', decodedBarcodeList(audit, 'datamatrix')],
          ['QR barcode', decodedBarcodeList(audit, 'qr')]
        ];
  const RULE = '-'.repeat(18);
  const seen = new Set();
  const blocks = [];
  const push = (label, b) => {
    const raw = rawCopyText(rawContentOf(b).raw);
    const key = raw.trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    blocks.push(`${label}:\n${RULE}\n${raw}\n${RULE}`);
  };
  for (const [label, list] of groups) for (const b of list || []) push(label, b);
  for (const b of audit?.detectedBarcodes || []) push(barcodeDisplayName(b), b);
  return blocks.join('\n\n');
}
/** The article that drives the header: prefer a standard eParcel article over SSCC entries. */
function getPrimaryArticle(audit) {
  return (audit?.articles || []).find(a => a?.type === 'eparcel-standard') || (audit?.articles || [])[0] || null;
}

/** Coarse family name ('Express Post' / 'Parcel Post') via description keywords - display only. */
function productFamilyForArticle(article) {
  if (isSsccArticle(article)) return 'SSCC label';
  const desc = String(article?.productDescription || '').toLowerCase();
  if (desc.includes('express')) return 'Express Post';
  if (desc.includes('parcel')) return 'Parcel Post';
  return article?.productDescription || 'Product not parsed';
}

/**
 * Header/summary strings for one audit (article number, product, service, file line,
 * tab text). Each value walks a fallback chain because any individual parse - QR,
 * freight, routing, SSCC, article - can be missing on a damaged or partial decode.
 */
export function auditDisplayHeader(audit, index = 0) {
  if (audit?.carrier === 'startrack') {
    const article = getPrimaryArticle(audit);
    const qr = (audit?.startrack?.qrParses || [])[0];
    const freight = (audit?.startrack?.freightParses || [])[0];
    const route = (audit?.startrack?.routingParses || [])[0];
    const sscc = (audit?.startrack?.ssccParses || [])[0];
    const productCode = freight?.productCode || qr?.productCode || '';
    const productMeta = productCode ? STARTRACK_PRODUCT_CODE_MAP[productCode] : null;
    const labelCode = route?.labelCode || productMeta?.labelCode || audit?.labelFacts?.labelCode || '';
    const articleNumber =
      freight?.freightItemId ||
      article?.articleId ||
      (sscc ? `00${sscc.sscc}` : '') ||
      qr?.fields?.freightItemNumber ||
      (audit?.labelFacts?.articleIds || [])[0] ||
      `Label ${index + 1}`;
    const product =
      sscc && !productCode
        ? 'StarTrack SSCC label'
        : productMeta?.name || freight?.productName || qr?.productName || 'StarTrack product not parsed';
    return {
      article,
      articleNumber,
      product,
      productCode,
      productName: productMeta?.name || freight?.productName || qr?.productName || '',
      serviceCode: labelCode || 'not parsed',
      serviceName: route?.formatDescription || (productMeta?.labelCode ? `Label code ${productMeta.labelCode}` : ''),
      isSsccOnly: Boolean(audit?.startrack?.ssccOnly),
      filename: audit?.fileInfo?.filename || `Label ${index + 1}`,
      pageLabel: audit?.fileInfo?.sourcePdfPage
        ? `Page ${audit.fileInfo.sourcePdfPage} of ${audit.fileInfo.sourcePdfPageCount || '?'}`
        : '',
      displayFile: `${audit?.fileInfo?.filename || `Label ${index + 1}`}${audit?.fileInfo?.sourcePdfPage ? ` — page ${audit.fileInfo.sourcePdfPage} of ${audit.fileInfo.sourcePdfPageCount || '?'}` : ''}`,
      tabText: `${articleNumber} · ${product} · ${labelCode || 'no routing'}`
    };
  }
  const article = getPrimaryArticle(audit);
  const ssccOnly = auditHasSsccOnly(audit);
  const articleNumber =
    article?.articleId || article?.sscc || (audit?.labelFacts?.articleIds || [])[0] || `Label ${index + 1}`;
  const product = ssccOnly ? 'SSCC label' : productFamilyForArticle(article);
  const serviceCode = ssccOnly ? 'Not applicable' : article?.serviceCode || '';
  return {
    article,
    articleNumber,
    product,
    productCode: ssccOnly ? '' : article?.productCode || '',
    productName: ssccOnly ? 'SSCC label — product code not encoded' : article?.productDescription || '',
    serviceCode,
    serviceName: ssccOnly
      ? 'SSCC barcode does not encode eParcel service code'
      : SERVICE_CODE_MAP[article?.serviceCode]?.name || article?.serviceDescription || '',
    isSsccOnly: ssccOnly,
    filename: audit?.fileInfo?.filename || `Label ${index + 1}`,
    pageLabel: audit?.fileInfo?.sourcePdfPage
      ? `Page ${audit.fileInfo.sourcePdfPage} of ${audit.fileInfo.sourcePdfPageCount || '?'}`
      : '',
    displayFile: `${audit?.fileInfo?.filename || `Label ${index + 1}`}${audit?.fileInfo?.sourcePdfPage ? ` — page ${audit.fileInfo.sourcePdfPage} of ${audit.fileInfo.sourcePdfPageCount || '?'}` : ''}`,
    tabText: `${articleNumber} · ${product} · ${serviceCode || 'no service'}`
  };
}
/** Batch totals across all labels; the combined verdict is worst-of: FAIL beats REVIEW beats PASS. */
export function combinedAuditSummary(audits = []) {
  const totals = audits.reduce(
    (acc, audit) => {
      acc.total += audit?.summary?.total || 0;
      acc.passed += audit?.summary?.passed || 0;
      acc.failed += audit?.summary?.failed || 0;
      acc.manualReview += audit?.summary?.manualReview || 0;
      acc.decoded += audit?.detectedBarcodes?.length || 0;
      if (audit?.summary?.overallStatus === 'FAIL') acc.hasFail = true;
      if (audit?.summary?.overallStatus === 'REVIEW') acc.hasReview = true;
      return acc;
    },
    { total: 0, passed: 0, failed: 0, manualReview: 0, decoded: 0, hasFail: false, hasReview: false }
  );
  totals.overallStatus = totals.hasFail ? 'FAIL' : totals.hasReview ? 'REVIEW' : 'PASS';
  totals.labelCount = audits.length;
  return totals;
}

/** Consignment ID detected for a label, for the rail file navigator. */
export function auditConsignmentId(audit) {
  if (audit?.carrier === 'startrack') {
    return (
      audit?.startrack?.freightParses?.[0]?.connoteNumber ||
      String(audit?.startrack?.qrParses?.[0]?.fields?.connoteNumber || '').trim() ||
      (audit?.labelFacts?.consignmentIds || [])[0] ||
      ''
    );
  }
  return getPrimaryArticle(audit)?.consignmentId || (audit?.labelFacts?.consignmentIds || [])[0] || '';
}
