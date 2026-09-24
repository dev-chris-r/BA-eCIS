// Barcode Reader mode report, kept deliberately minimal: the full label image with decode
// outlines, then one line per decoded barcode - its raw value with FNC1/control characters
// rendered visibly, and copy actions. Data shaping lives in readerData.js (pure, Node-tested).
import React from 'react';
import { CopyButton, InputQualityGauge, RawCode, RawCopyButtons, SectionTitle } from './common.jsx';
import { readerCopyAllText, readerSymbologyName } from './readerData.js';

/** One decoded barcode: symbology, then the raw value. The leading FNC1 marker renders only
 *  when the scan captured a GS1 symbology identifier (]C1 / ]d2 ...); ASCII 29 bytes always
 *  render as visible markers - FNC1 in a GS1 symbol, GS otherwise. */
function ReaderBarcodeCard({ barcode, ordinal }) {
  return (
    <li className="reader-barcode">
      <div className="barcode-meta reader-barcode-head">
        <strong>
          #{ordinal} · {readerSymbologyName(barcode)}
        </strong>
        {barcode.pageNumber > 1 ? <span className="muted small">page {barcode.pageNumber}</span> : null}
      </div>
      <div className="segmented-code-row">
        <RawCode barcode={barcode} className="reader-raw-code" />
        <RawCopyButtons barcode={barcode} />
      </div>
    </li>
  );
}

/** The complete Barcode Reader report for one scanned label: picture, then raw values. */
export function ReaderReportView({ result, index = 0, onNewAudit, processing = false, onZoomLabel }) {
  const barcodes = result?.detectedBarcodes || [];
  const images = result?.labelImages || {};
  const fileInfo = result?.fileInfo || {};
  const fileLine = `${fileInfo.filename || `Label ${index + 1}`}${fileInfo.pageLabel ? ` — ${fileInfo.pageLabel}` : ''}`;
  return (
    <section className="single-audit-view reader-view">
      <section className="card compact-card selected-label-header reader-header">
        <button
          type="button"
          className="new-audit-btn"
          onClick={onNewAudit}
          disabled={processing}
          title="Start a new read or audit (keeps this report until a new label is uploaded)"
        >
          <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" focusable="false">
            <path
              d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
            />
            <path d="M14 3v6h5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
            <path d="M12 11v6M9 14h6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span>New audit</span>
        </button>
        <span className="selected-label-eyebrow">Barcode reader</span>
        <div className="selected-label-number">
          <code>
            {barcodes.length} barcode{barcodes.length === 1 ? '' : 's'} decoded
          </code>
          <CopyButton
            value={readerCopyAllText(result)}
            label="Copy every decoded raw value, one per line"
            text="Copy all raw values"
          />
        </div>
        <div className="selected-label-meta">
          <span>
            <span className="meta-k">File</span>
            <span className="meta-v">{fileLine}</span>
          </span>
        </div>
        <InputQualityGauge fileInfo={fileInfo} />
      </section>

      <section className="card audit-section reader-section" id="full-label-image">
        <div className="section-heading">
          <SectionTitle id="full-label-image-title">Label</SectionTitle>
          <span className="section-status section-status-neutral">
            {barcodes.length} barcode{barcodes.length === 1 ? '' : 's'}
          </span>
        </div>
        {images.labelPreview ? (
          <>
            <button
              className="label-preview-button"
              type="button"
              onClick={() => onZoomLabel?.({ src: images.labelPreview, alt: 'Full label preview' })}
              aria-label="Open full screen label image"
            >
              <img className="label-preview-large" src={images.labelPreview} alt="Full label preview" />
            </button>
            <p className="small muted preview-legend">
              <span className="legend-dot legend-valid" /> decoded barcode
            </p>
          </>
        ) : (
          <p className="muted">No label preview captured.</p>
        )}
        {barcodes.length === 0 ? (
          <p className="muted">
            No barcodes were decoded from this label. Low resolution is the most common cause — upload the original PDF
            or a 300 DPI export.
          </p>
        ) : (
          <ul className="barcode-list decoded-list reader-barcode-list">
            {barcodes.map((b, i) => (
              <ReaderBarcodeCard
                key={`${b.pageNumber || 0}-${b.format || ''}-${b.rawValue}-${i}`}
                barcode={b}
                ordinal={i + 1}
              />
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}
