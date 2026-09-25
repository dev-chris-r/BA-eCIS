// Label preview images and per-barcode evidence crops for the report UI.
import { STARTRACK_LABEL_CODE_MAP, parseEparcelBarcode } from '../auditEngine.js';
import {
  FORMAT_KIND,
  bestLocatedBarcode,
  hasFnc1First,
  isDataMatrixBarcode,
  isLinearBarcode,
  isQrBarcode
} from './barcodeTypes.js';
import {
  BARCODE_BOX_MARGIN_PX,
  PREVIEW_BARCODE_BOX_MARGIN_PX,
  clampBox,
  expandBox,
  cropCanvas,
  canvasToDataUrl
} from './canvasUtils.js';

// Fractional label regions where each StarTrack barcode belongs; drawn on the preview
// as dashed candidate boxes when the matching barcode has not been decoded.
export const STARTRACK_PREVIEW_BOXES = {
  atl: { x: 0.56, y: 0.05, w: 0.38, h: 0.1, label: 'ATL zone' },
  routing: { x: 0.04, y: 0.4, w: 0.6, h: 0.2, label: 'Routing zone' },
  freight: { x: 0.07, y: 0.78, w: 0.86, h: 0.16, label: 'Freight zone' }
};

// Scan crops for the eParcel templates. The standard template puts the GS1-128 across the
// upper-left; the Metro template moves it to a full-width strip along the bottom edge and
// puts the (larger) GS1 DataMatrix in the top-right corner, where the standard crop looks
// at neither. All three run on every eParcel label because the product is only known once
// a barcode has decoded.
export const EPARCEL_SCAN_TARGETS = {
  standardLinear: { x: 0.04, y: 0.23, w: 0.62, h: 0.22 },
  metroLinear: { x: 0.0, y: 0.79, w: 1.0, h: 0.21 },
  metroDataMatrix: { x: 0.6, y: 0.03, w: 0.4, h: 0.3 }
};

// Fallback framing for the report's evidence images, used only when a decoded barcode
// carries no page box of its own.
const PREVIEW_CROPS = {
  dataMatrix: { x: 0.55, y: 0.02, w: 0.43, h: 0.31 },
  dataMatrixFocused: { x: 0.72, y: 0.07, w: 0.26, h: 0.22 },
  qr: { x: 0.35, y: 0.1, w: 0.6, h: 0.55 },
  rightLinear: { x: 0.68, y: 0.18, w: 0.31, h: 0.68 }
};

// Fractional scan crops for the StarTrack linear barcodes; `sweep` is a wide catch-all
// band spanning the routing and freight zones for labels that drift off-template.
export const STARTRACK_LINEAR_TARGETS = {
  atl: { x: 0.52, y: 0.02, w: 0.46, h: 0.16 },
  routing: { x: 0.03, y: 0.36, w: 0.62, h: 0.25 },
  freight: { x: 0.03, y: 0.74, w: 0.94, h: 0.2 },
  sweep: { x: 0.02, y: 0.36, w: 0.96, h: 0.58 }
};

/** Uppercases and strips spacing so decoded values compare by role reliably. */
export function normalizeBarcodeValueForRole(value) {
  // Matches the audit parsers: a leading symbology identifier (]C1) and FNC1/GS control
  // characters are decoder framing, not content, so a GS1 routing read that carries its
  // separator still classifies as a routing barcode.
  return String(value || '')
    .replace(/^\][A-Za-z0-9]{2}/, '')
    .replace(/[()\s\x00-\x1f\x7f]/g, '')
    .toUpperCase();
}

/** True when a decoded value matches the 20-character StarTrack freight item format. */
export function isStarTrackFreightItemValue(value) {
  const v = normalizeBarcodeValueForRole(value);
  return /^[A-Z0-9]{4}\d{8}[A-Z0-9]{3}\d{5}$/.test(v) || /^00\d{18}$/.test(v);
}

/** True when a decoded value matches the C999999999 ATL format. */
export function isStarTrackAtlValue(value) {
  const v = normalizeBarcodeValueForRole(value);
  return /^C\d{9}$/.test(v);
}

/** True when a decoded value matches the StarTrack routing barcode format. */
export function isStarTrackRoutingValue(value) {
  const v = normalizeBarcodeValueForRole(value);
  const route = v.match(/^([A-Z0-9]{3})\d{4}[A-Z0-9]{2,3}$/);
  const gs1Route = v.match(/^421036\d{4}403([A-Z0-9]{3})$/);
  return Boolean((route && STARTRACK_LABEL_CODE_MAP[route[1]]) || (gs1Route && STARTRACK_LABEL_CODE_MAP[gs1Route[1]]));
}

/** Returns the user-facing barcode type label used in captions and report sections. "GS1" is
 *  claimed only when the scan's symbology identifier proves FNC1 in the first position. */
export function barcodeKindLabel(b) {
  if (isDataMatrixBarcode(b)) return hasFnc1First(b?.symbologyIdentifier) ? 'GS1 DataMatrix' : 'DataMatrix';
  if (isQrBarcode(b)) return 'QR Barcode';
  if (isLinearBarcode(b)) return 'Linear Barcode';
  return b?.format || 'Barcode';
}

/** Crops the evidence image for the first decoded barcode of the given kind. */
export function cropForDecodedBarcode(canvas, barcodes, kind) {
  const list = barcodes.filter(
    b =>
      b.pageBoundingBox &&
      (kind === FORMAT_KIND.datamatrix
        ? isDataMatrixBarcode(b)
        : kind === FORMAT_KIND.qr
          ? isQrBarcode(b)
          : isLinearBarcode(b) && !isDataMatrixBarcode(b) && !isQrBarcode(b))
  );
  if (!list.length) return null;
  // Use the read with the strongest location evidence (direct page box beats one
  // mapped through a variant transform) because this crop is shown as evidence,
  // not just as a convenience image.
  const chosen = bestLocatedBarcode(list);
  const box = expandBox(chosen.pageBoundingBox, canvas.width, canvas.height, BARCODE_BOX_MARGIN_PX);
  if (!box) return null;
  return {
    canvas: cropCanvas(canvas, box.x, box.y, box.width, box.height),
    box,
    barcode: chosen
  };
}

/** Crops the evidence image for the first decoded barcode matching a predicate. */
export function cropForDecodedBarcodeMatch(canvas, barcodes, predicate, marginPx = BARCODE_BOX_MARGIN_PX) {
  const list = (barcodes || []).filter(b => b.pageBoundingBox && predicate(b));
  if (!list.length) return null;
  const chosen = bestLocatedBarcode(list);
  const box = expandBox(chosen.pageBoundingBox, canvas.width, canvas.height, marginPx);
  if (!box) return null;
  return {
    canvas: cropCanvas(canvas, box.x, box.y, box.width, box.height),
    box,
    barcode: chosen
  };
}

/** Converts a fractional box spec into pixel coordinates on the given canvas. */
export function relativeCanvasBox(canvas, spec) {
  return clampBox(
    {
      x: Math.round(canvas.width * spec.x),
      y: Math.round(canvas.height * spec.y),
      width: Math.round(canvas.width * spec.w),
      height: Math.round(canvas.height * spec.h)
    },
    canvas.width,
    canvas.height
  );
}

/** Builds dashed candidate boxes for expected StarTrack barcode zones not yet decoded. */
export function buildStarTrackPreviewCandidateBoxes(canvas, detectedBarcodes = []) {
  const hasRouting = detectedBarcodes.some(b => isLinearBarcode(b) && isStarTrackRoutingValue(b.rawValue));
  const hasAtl = detectedBarcodes.some(b => isLinearBarcode(b) && isStarTrackAtlValue(b.rawValue));
  const hasFreight = detectedBarcodes.some(b => isLinearBarcode(b) && isStarTrackFreightItemValue(b.rawValue));
  return [
    !hasAtl
      ? { label: STARTRACK_PREVIEW_BOXES.atl.label, box: relativeCanvasBox(canvas, STARTRACK_PREVIEW_BOXES.atl) }
      : null,
    !hasRouting
      ? {
          label: STARTRACK_PREVIEW_BOXES.routing.label,
          box: relativeCanvasBox(canvas, STARTRACK_PREVIEW_BOXES.routing)
        }
      : null,
    !hasFreight
      ? {
          label: STARTRACK_PREVIEW_BOXES.freight.label,
          box: relativeCanvasBox(canvas, STARTRACK_PREVIEW_BOXES.freight)
        }
      : null
  ].filter(Boolean);
}

/** Draws one labelled barcode box onto the preview overlay context. */
export function drawPreviewBarcodeBox(ctx, scale, outputWidth, box, label, style) {
  const x = box.x * scale;
  const y = box.y * scale;
  const width = box.width * scale;
  const height = box.height * scale;
  const labelHeight = Math.max(18, 22 * scale);
  const textWidth = Math.min(outputWidth, ctx.measureText(label).width + 12);
  const labelX = Math.min(Math.max(0, x), Math.max(0, outputWidth - textWidth));
  const labelY = Math.max(0, y - Math.max(20, labelHeight));

  ctx.save();
  ctx.lineWidth = style.lineWidth;
  if (style.dash) ctx.setLineDash(style.dash);
  ctx.strokeStyle = style.stroke;
  ctx.fillStyle = style.fill;
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);
  ctx.setLineDash([]);
  ctx.fillStyle = style.labelFill;
  ctx.fillRect(labelX, labelY, textWidth, labelHeight);
  ctx.fillStyle = '#fff';
  ctx.fillText(label, labelX + 6, labelY + Math.max(13, 16 * scale));
  ctx.restore();
}

// Preview overlay status colours: green = decoded and valid for its carrier role,
// red = decoded but not a valid symbol (e.g. an unexpected/garbled linear read).
// Missing-but-expected zones use the amber/yellow candidate-box style below.
const PREVIEW_BOX_STYLE = {
  valid: { stroke: '#087a2e', fill: 'rgba(8,122,46,0.14)', labelFill: '#087a2e' },
  invalid: { stroke: '#b00020', fill: 'rgba(176,0,32,0.12)', labelFill: '#b00020' }
};

/** True when a decoded barcode reads as a valid symbol for its carrier role (drives green vs red). */
export function isDecodedBarcodeValid(barcode, labelFamily = 'eparcel') {
  // Barcode Reader mode applies no carrier roles: every successful decode outlines green.
  if (labelFamily === 'reader') return true;
  // 2D symbols carry strong error correction, so a successful decode is a valid read.
  if (isQrBarcode(barcode) || isDataMatrixBarcode(barcode)) return true;
  const value = normalizeBarcodeValueForRole(barcode.rawValue);
  if (labelFamily === 'startrack') {
    return (
      isStarTrackAtlValue(value) ||
      isStarTrackRoutingValue(value) ||
      isStarTrackFreightItemValue(value) ||
      /^00\d{18}$/.test(value)
    );
  }
  const parsed = parseEparcelBarcode(barcode.rawValue || '');
  return Boolean(parsed.articleAnalysis?.valid || parsed.article?.valid);
}

/** Renders the label preview with decoded/candidate barcode boxes burned in. */
export function canvasToDataUrlWithBarcodeBoxes(
  sourceCanvas,
  barcodes = [],
  maxWidth = 820,
  candidateBoxes = [],
  labelFamily = 'eparcel'
) {
  if (!sourceCanvas?.width || !sourceCanvas?.height) return '';
  const scale = Math.min(1, maxWidth / sourceCanvas.width);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(sourceCanvas.width * scale));
  out.height = Math.max(1, Math.round(sourceCanvas.height * scale));
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(sourceCanvas, 0, 0, out.width, out.height);

  ctx.font = `${Math.max(12, Math.round(18 * scale))}px Segoe UI, Arial, sans-serif`;
  for (const candidate of candidateBoxes) {
    drawPreviewBarcodeBox(ctx, scale, out.width, candidate.box, candidate.label, {
      stroke: '#9a5a00',
      fill: 'rgba(154,90,0,.08)',
      labelFill: '#9a5a00',
      lineWidth: Math.max(2, Math.round(3 * scale)),
      dash: [Math.max(5, 7 * scale), Math.max(4, 5 * scale)]
    });
  }

  const located = barcodes.filter(b => b.pageBoundingBox);
  for (const b of located) {
    const box = expandBox(b.pageBoundingBox, sourceCanvas.width, sourceCanvas.height, PREVIEW_BARCODE_BOX_MARGIN_PX);
    if (!box) continue;
    const style = isDecodedBarcodeValid(b, labelFamily) ? PREVIEW_BOX_STYLE.valid : PREVIEW_BOX_STYLE.invalid;
    drawPreviewBarcodeBox(ctx, scale, out.width, box, barcodeKindLabel(b), {
      ...style,
      lineWidth: Math.max(3, Math.round(4 * scale))
    });
  }
  return out.toDataURL('image/jpeg', 0.88);
}

/** Builds the full set of preview and evidence crop images for one audited label. */
export function createLabelImages(canvas, detectedBarcodes = [], labelFamily = 'eparcel') {
  const w = canvas.width;
  const h = canvas.height;
  const dmLocated = cropForDecodedBarcode(canvas, detectedBarcodes, FORMAT_KIND.datamatrix);
  const qrLocated = cropForDecodedBarcode(canvas, detectedBarcodes, FORMAT_KIND.qr);
  const linearLocated = cropForDecodedBarcode(canvas, detectedBarcodes, FORMAT_KIND.linear);
  const starTrackRoutingLocated = cropForDecodedBarcodeMatch(
    canvas,
    detectedBarcodes,
    b => isLinearBarcode(b) && !isQrBarcode(b) && !isDataMatrixBarcode(b) && isStarTrackRoutingValue(b.rawValue)
  );
  const starTrackAtlLocated = cropForDecodedBarcodeMatch(
    canvas,
    detectedBarcodes,
    b => isLinearBarcode(b) && !isQrBarcode(b) && !isDataMatrixBarcode(b) && isStarTrackAtlValue(b.rawValue)
  );
  const starTrackFreightLocated = cropForDecodedBarcodeMatch(
    canvas,
    detectedBarcodes,
    b => isLinearBarcode(b) && !isQrBarcode(b) && !isDataMatrixBarcode(b) && isStarTrackFreightItemValue(b.rawValue)
  );

  // Fixed template crops are fallback evidence only. If a barcode decoded with a real
  // page box, prefer that because label layouts can shift between products/customers.
  const st = STARTRACK_LINEAR_TARGETS;
  const crop = box => cropCanvas(canvas, w * box.x, h * box.y, w * box.w, h * box.h);
  const dmCrop = crop(PREVIEW_CROPS.dataMatrix);
  const dmFocusedCrop = crop(PREVIEW_CROPS.dataMatrixFocused);
  const qrCrop = crop(PREVIEW_CROPS.qr);
  const linearCrop = crop(st.sweep);
  const rightLinearCrop = crop(PREVIEW_CROPS.rightLinear);
  const starTrackRoutingCrop = crop(st.routing);
  const starTrackAtlCrop = crop(st.atl);
  const starTrackFreightCrop = crop(st.freight);
  const previewCandidateBoxes =
    labelFamily === 'startrack' ? buildStarTrackPreviewCandidateBoxes(canvas, detectedBarcodes) : [];

  return {
    labelPreviewPlain: canvasToDataUrl(canvas, 760),
    labelPreview: canvasToDataUrlWithBarcodeBoxes(canvas, detectedBarcodes, 820, previewCandidateBoxes, labelFamily),
    dataMatrixCrop: canvasToDataUrl(dmLocated?.canvas || dmCrop, 420),
    dataMatrixFocusedCrop: canvasToDataUrl(dmLocated?.canvas || dmFocusedCrop, 320),
    dataMatrixBox: dmLocated?.box || null,
    dataMatrixBoxSource: dmLocated?.barcode
      ? `${dmLocated.barcode.source || 'scanner'} · ${dmLocated.barcode.regionLabel || ''} · ${dmLocated.barcode.variantLabel || ''}`
      : 'fallback heuristic crop only',
    qrBarcodeCrop: canvasToDataUrl(qrLocated?.canvas || qrCrop, 420),
    qrBarcodeBox: qrLocated?.box || null,
    qrBarcodeBoxSource: qrLocated?.barcode
      ? `${qrLocated.barcode.source || 'scanner'} · ${qrLocated.barcode.regionLabel || ''} · ${qrLocated.barcode.variantLabel || ''}`
      : 'fallback heuristic crop only',
    linearBarcodeCrop: canvasToDataUrl(linearLocated?.canvas || linearCrop, 780),
    rightLinearBarcodeCrop: canvasToDataUrl(linearLocated?.canvas || rightLinearCrop, 420),
    linearBarcodeBox: linearLocated?.box || null,
    linearBarcodeBoxSource: linearLocated?.barcode
      ? `${linearLocated.barcode.source || 'scanner'} · ${linearLocated.barcode.regionLabel || ''} · ${linearLocated.barcode.variantLabel || ''}`
      : 'fallback heuristic crop only',
    routingBarcodeCrop: canvasToDataUrl(starTrackRoutingLocated?.canvas || starTrackRoutingCrop, 620),
    routingBarcodeBox: starTrackRoutingLocated?.box || null,
    routingBarcodeBoxSource: starTrackRoutingLocated?.barcode
      ? `${starTrackRoutingLocated.barcode.source || 'scanner'} · ${starTrackRoutingLocated.barcode.regionLabel || ''} · ${starTrackRoutingLocated.barcode.variantLabel || ''}`
      : 'fallback heuristic crop only',
    atlBarcodeCrop: canvasToDataUrl(starTrackAtlLocated?.canvas || starTrackAtlCrop, 620),
    atlBarcodeBox: starTrackAtlLocated?.box || null,
    atlBarcodeBoxSource: starTrackAtlLocated?.barcode
      ? `${starTrackAtlLocated.barcode.source || 'scanner'} · ${starTrackAtlLocated.barcode.regionLabel || ''} · ${starTrackAtlLocated.barcode.variantLabel || ''}`
      : 'fallback heuristic crop only',
    freightBarcodeCrop: canvasToDataUrl(starTrackFreightLocated?.canvas || starTrackFreightCrop, 780),
    freightBarcodeBox: starTrackFreightLocated?.box || null,
    freightBarcodeBoxSource: starTrackFreightLocated?.barcode
      ? `${starTrackFreightLocated.barcode.source || 'scanner'} · ${starTrackFreightLocated.barcode.regionLabel || ''} · ${starTrackFreightLocated.barcode.variantLabel || ''}`
      : 'fallback heuristic crop only'
  };
}
