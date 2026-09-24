// Visible-text fact extraction for eParcel labels: article IDs, consignment
// numbers, address blocks, weight, and the DG (dangerous goods) declaration.
import {
  extractDgBlock,
  extractFromBlock,
  extractPostcodeLines,
  extractToBlock,
  firstLineValue,
  textLines
} from '../shared/text.js';
import { extractRoutingDetails } from './metro/routing.js';

/** Reads the visible "n of N" article count, which may sit under an Article/Parcel heading. */
function extractArticleCountLine(lines) {
  const inline = firstLineValue(lines, /(?:Article|Parcel)\s+(\d+\s+of\s+\d+)/i);
  if (inline) return inline.replace(/\s+/g, ' ');
  const idx = lines.findIndex(line => /^(?:Article|Parcel)s?$/i.test(String(line).trim()));
  const next = idx >= 0 ? String(lines[idx + 1] || '').trim() : '';
  return /^\d+\s+of\s+\d+$/i.test(next) ? next.replace(/\s+/g, ' ') : null;
}

// Matches a visible article ID: an AI 00 SSCC (the GS1 serial shipping container code,
// 00 + 18 digits), or an eParcel article (3- or 5-char MLID - the merchant location ID
// Australia Post assigns - followed by exactly 18 digits). This is tighter than a
// generic [A-Z0-9]{21|23} and avoids capturing watermark text.
const EPARCEL_ARTICLE_RE = /\b(00\d{18}|[A-Z0-9]{3}\d{18}|[A-Z0-9]{5}\d{18})\b/g;

/** Finds visible article IDs, preferring labelled "Article Id" lines over loose digit runs. */
function extractArticleIdsFromLines(lines) {
  const ids = [];
  // Primary pass: labelled lines are most reliable (avoids watermark false-positives).
  for (const line of lines) {
    if (!/(?:AP\s*)?Article\s*Id/i.test(line)) continue;
    const after = String(line)
      .replace(/^.*?(?:AP\s*)?Article\s*Id\s*:?\s*/i, '')
      .toUpperCase();
    const matches = after.match(EPARCEL_ARTICLE_RE) || [];
    ids.push(...matches);
  }
  // Secondary pass: barcode human-readable text appears above/below the symbol
  // without a heading, often space-grouped (e.g. "00 39312 65000 00012 3"), so
  // match with the line's spacing removed. Scan all lines but apply the stricter
  // pattern and require the candidate to dominate the line (reduces watermark noise).
  if (ids.length === 0) {
    for (const line of lines) {
      if (/(?:AP\s*)?Article\s*Id/i.test(line)) continue;
      const stripped = String(line).toUpperCase().replace(/\s/g, '');
      const matches = stripped.match(EPARCEL_ARTICLE_RE) || [];
      for (const m of matches) {
        if (stripped.startsWith(m) || stripped.endsWith(m)) {
          ids.push(m);
        }
      }
    }
  }
  return [...new Set(ids)];
}

/** Extracts visible eParcel label facts: address blocks, article IDs, weight, and DG text. */
export function extractLabelFacts(extractedText) {
  const lines = textLines(extractedText);
  const joined = lines.join('\n');
  const upper = joined.toUpperCase();

  const articleIds = extractArticleIdsFromLines(lines);

  let consNo = firstLineValue(lines, /Con(?:s(?:ignment)?)?\s*No\s*:?\s*([A-Z0-9]+)/i);
  if (!consNo) {
    const idx = lines.findIndex(line => /Con(?:s(?:ignment)?)?\s*No\s*:?\s*$/i.test(line));
    if (idx >= 0 && lines[idx + 1] && /^[A-Z0-9]{6,16}$/i.test(lines[idx + 1])) consNo = lines[idx + 1];
  }
  const phone = firstLineValue(lines, /(?:Ph|Phone)\s*:?\s*([0-9 +()-]+)/i);
  const weightRaw =
    firstLineValue(lines, /(?:Dead\s*weight|Weight)\s*([0-9.]+)\s*kg/i) ||
    firstLineValue(lines, /\b([0-9]+(?:\.[0-9]+)?)\s*kg\b/i);
  const toBlock = extractToBlock(lines);
  const fromBlock = extractFromBlock(lines);
  const dgBlock = extractDgBlock(lines);
  const postcodeLines = extractPostcodeLines(lines);
  const routing = extractRoutingDetails(lines);
  const articleCountLine = extractArticleCountLine(lines);

  let labelType = null;
  // Returns branding must be checked first: "PARCEL POST RETURNS" also contains "PARCEL POST".
  // The match stays on ONE line ([^\S\r\n] = space/tab only) and excludes "RETURN TO ..." /
  // "RETURN ADDRESS ..." so a sender block or undeliverable endorsement printed after the
  // header can never re-classify an outbound label as a returns label.
  const returnsWord = 'RETURNS?\\b(?![^\\S\\r\\n]+(?:TO|ADDRESS)\\b)';
  if (new RegExp(`\\bEXPRESS[^\\S\\r\\n]+POST[^\\S\\r\\n]+${returnsWord}`).test(upper)) {
    labelType = 'Express Post Return';
  } else if (new RegExp(`\\bPARCEL[^\\S\\r\\n]+POST[^\\S\\r\\n]+${returnsWord}`).test(upper)) {
    labelType = 'Parcel Post Return';
  } else if (/EXPRESS\s+POST/.test(upper)) labelType = 'Express Post';
  else if (/PARCEL\s+POST/.test(upper)) labelType = 'Parcel Post';
  else if (/\bM2M\b/.test(upper)) labelType = 'Metro (M2M)';
  else if (/EPARCEL/.test(upper)) labelType = 'eParcel';

  return {
    lines,
    labelType,
    articleIds: [...new Set(articleIds)],
    consignmentIds: consNo ? [consNo.toUpperCase()] : [],
    phone,
    weightKg: weightRaw || null,
    toBlock,
    fromBlock,
    dgBlock,
    postcodeLines,
    ...routing,
    articleCountLine,
    dangerousGoodsDeclarationPresent:
      dgBlock.length > 0 ||
      /Aviation\s+Security\s+and\s+Dangerous\s+Goods\s+Declaration/i.test(joined) ||
      /dangerous\s+goods/i.test(joined),
    postagePaidPresent: /Postage\s+Paid/i.test(joined),
    extractedLineCount: lines.length
  };
}

/** Pulls barcode-looking strings from visible text as diagnostic evidence only, not as barcode proof. */
export function extractTextBarcodeCandidates(extractedText) {
  const facts = extractLabelFacts(extractedText);
  return facts.articleIds;
}
