// Scan kind names are shared by crop planning, decoder routing, and report grouping.
export const FORMAT_KIND = {
  linear: 'linear',
  datamatrix: 'datamatrix',
  qr: 'qr',
  mixed: 'mixed'
};

// Location-evidence quality, strongest first: a box decoded straight off the
// untransformed crop, a box mapped back through a known variant transform, and
// no page box at all. Evidence crops and dedupe both prefer higher quality.
export const LOCATION_QUALITY = {
  decoded: 'decoded-symbol-bounding-box',
  mapped: 'variant-mapped-bounding-box',
  none: 'decoded-no-page-box'
};

/** Orders LOCATION_QUALITY values numerically so callers can compare evidence strength. */
export function locationQualityRank(quality) {
  if (quality === LOCATION_QUALITY.decoded) return 2;
  if (quality === LOCATION_QUALITY.mapped) return 1;
  return 0;
}

/** Picks the barcode whose page box carries the strongest location evidence. */
export function bestLocatedBarcode(barcodes = []) {
  let best = null;
  let bestRank = -1;
  for (const b of barcodes) {
    const rank = locationQualityRank(b?.locationQuality);
    if (rank > bestRank) {
      best = b;
      bestRank = rank;
    }
  }
  return best;
}

// ISO/IEC 15424 symbology identifiers that mean "FNC1 encoded in the first position", i.e. a
// GS1 symbol: ]C1 GS1-128, ]d2/]d5 GS1 DataMatrix, ]Q3/]Q4 GS1 QR Code, ]e0 GS1 DataBar.
export const GS1_FIRST_IDENTIFIERS = new Set([']C1', ']d2', ']d5', ']Q3', ']Q4', ']e0']);

/** True only when the scan's symbology identifier proves FNC1 in the first position. */
export function hasFnc1First(symbologyIdentifier) {
  return GS1_FIRST_IDENTIFIERS.has(String(symbologyIdentifier || ''));
}

/**
 * True when a decoded barcode entry is a DataMatrix symbol. The reported format decides;
 * only a read whose decoder omitted the format falls back to GS1 AIs (Application
 * Identifiers, the numeric prefixes that name a field) 420/8008 in the payload. Sniffing a
 * known format would misfile any Code 128 whose digits happen to contain "8008".
 */
export function isDataMatrixBarcode(barcode) {
  const fmt = String(barcode?.format || barcode?.symbology || '').toLowerCase();
  if (fmt && fmt !== 'unknown') return fmt.includes('data');
  const raw = String(barcode?.rawValue || '');
  return raw.includes('(420)') || raw.includes('(8008)') || raw.includes('8008') || raw.includes('|420');
}

/** True when a decoded barcode entry is a QR symbol. */
export function isQrBarcode(barcode) {
  const fmt = String(barcode?.format || barcode?.symbology || '').toLowerCase();
  return fmt.includes('qr') || barcode?.kind === FORMAT_KIND.qr;
}

/** True when a decoded barcode entry is a linear (Code 128 family) symbol. */
export function isLinearBarcode(barcode) {
  const fmt = String(barcode?.format || barcode?.symbology || '').toLowerCase();
  if (isQrBarcode(barcode) || isDataMatrixBarcode(barcode)) return false;
  return (
    fmt.includes('128') || fmt.includes('code_128') || fmt.includes('code 128') || barcode?.kind === FORMAT_KIND.linear
  );
}
