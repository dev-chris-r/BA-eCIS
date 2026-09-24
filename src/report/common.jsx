// Generic report components shared by every carrier: section chrome, rail
// navigation, image evidence, field lines, copy buttons, and the colour-
// segmented barcode renderer.
import React, { useEffect, useRef, useState } from 'react';
import { RuleReport, StatusIcon } from './reportView.jsx';
import { FORMAT_KIND, isDataMatrixBarcode, isLinearBarcode, isQrBarcode } from '../scanner/barcodeTypes.js';
import { isStarTrackAtlValue, isStarTrackFreightItemValue, isStarTrackRoutingValue } from '../scanner/labelImages.js';
import { ARTICLE_FIELD_SPECS, fieldMetaText, fieldSpecsFor } from './barcodeFieldSpecs.js';
import { standardForValidation } from './standards.js';
import { barcodeDisplayName } from './auditInfo.js';
import { leadingFnc1Info, rawContentOf, rawDisplaySegments } from './readerData.js';
import { barcodeSegments } from './segments.js';

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** Caption for a barcode evidence image: names the symbol and its detected page location
 *  (box x,y width×height in pixels), or notes that only a fallback crop was available. */
export function imageBoxCaption(images = {}, kind = FORMAT_KIND.datamatrix) {
  if (kind === FORMAT_KIND.qr) {
    const box = images.qrBarcodeBox;
    const label = 'Detected QR barcode location for this label';
    if (!box) return 'QR fallback crop used for scanning/assessment';
    return `${label} · box ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}px`;
  }
  if (kind === 'startrack-routing') {
    const box = images.routingBarcodeBox;
    const label = 'Detected StarTrack routing barcode location for this label';
    if (!box) return `${label} · fallback crop only`;
    return `${label} · box ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}px`;
  }
  if (kind === 'startrack-atl') {
    const box = images.atlBarcodeBox;
    const label = 'Detected StarTrack ATL barcode location for this label';
    if (!box) return `${label} · fallback crop only`;
    return `${label} · box ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}px`;
  }
  if (kind === 'startrack-freight') {
    const box = images.freightBarcodeBox;
    const label = 'Detected StarTrack freight item barcode location for this label';
    if (!box) return `${label} · fallback crop only`;
    return `${label} · box ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}px`;
  }
  const box = kind === FORMAT_KIND.datamatrix ? images.dataMatrixBox : images.linearBarcodeBox;
  const label =
    kind === FORMAT_KIND.datamatrix
      ? 'Detected DataMatrix location for this label'
      : 'Detected linear barcode location for this label';
  if (!box) return `${label} · fallback crop only`;
  return `${label} · box ${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}×${Math.round(box.height)}px`;
}

export function formatDurationMs(ms) {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function SectionTitle({ id, children }) {
  return (
    <h2 id={id}>
      <a className="section-link" href={`#${id}`}>
        {children}
      </a>
    </h2>
  );
}

export function StandardLine({ children }) {
  return (
    <p className="standard-line">
      <strong>Specification standard / example:</strong> {children}
    </p>
  );
}

/** Worst-first status rollup for a section: fail > review (warning/manual) > pass > neutral. */
function sectionTone(items = []) {
  if (items.some(v => v.status === 'fail')) return 'fail';
  if (items.some(v => v.status === 'manual_review' || v.status === 'warning')) return 'review';
  if (items.some(v => v.status === 'pass')) return 'pass';
  return 'neutral';
}

/** Clean sections hide their parse fact-cards and spec reference text; both surface only
 *  when the section carries a warning or failure the reviewer needs the context for. */
export function sectionHasIssues(items) {
  const tone = sectionTone(items);
  return tone === 'fail' || tone === 'review';
}

export function SectionStatus({ items }) {
  const tone = sectionTone(items);
  return <span className={`section-status section-status-${tone}`}>{tone === 'neutral' ? 'no checks' : tone}</span>;
}

/** The selected mode already renders in the report header, so this section stays hidden
 *  unless a mode check needs attention (wrong toggle) — then it surfaces with the rule rows
 *  the review bookmarks link to. */
export function AuditModeSection({ items }) {
  if (!items?.length || items.every(v => v.status === 'pass')) return null;
  return (
    <section className="card audit-section mode-section" id="audit-mode-section">
      <div className="section-heading">
        <SectionTitle id="audit-mode-section-title">Selected audit mode</SectionTitle>
        <SectionStatus items={items} />
      </div>
      <ValidationTable items={items} />
    </section>
  );
}

/** Decoded linear barcodes that fill none of the label's required roles — for StarTrack, not
 *  routing/ATL/freight and not an SSCC (the AI 00, 18-digit consignment code); for eParcel, not
 *  an AI 01 article code or an SSCC (AI = GS1 Application Identifier, the numeric prefix that
 *  names a field; "]C1" is the symbology-identifier prefix some decoders keep on GS1-128 values).
 *  Only returned once more barcodes decoded than the audit mode expects, as evidence only. */
function additionalBarcodeCandidates(audit) {
  const all = audit?.detectedBarcodes || [];
  if (!all.length) return [];
  const expectedBarcodeCount = audit?.carrier === 'startrack' ? 3 : 2;
  if (all.length <= expectedBarcodeCount) return [];
  return all.filter(b => {
    const raw = String(b.rawValue || '');
    if (!raw) return false;
    if (isQrBarcode(b) || isDataMatrixBarcode(b)) return false;
    const compact = raw.replace(/\s+/g, '');
    if (audit?.carrier === 'startrack') {
      return (
        isLinearBarcode(b) &&
        !isStarTrackRoutingValue(raw) &&
        !isStarTrackAtlValue(raw) &&
        !isStarTrackFreightItemValue(raw) &&
        !/^(\]C1)?\(?00\)?\d{18}$/.test(compact)
      );
    }
    return (
      isLinearBarcode(b) &&
      !isDataMatrixBarcode(b) &&
      !/^(\]C1)?\(?01\)?/.test(compact) &&
      !/^(\]C1)?\(?00\)?\d{18}$/.test(compact)
    );
  });
}

export function AdditionalBarcodesSection({ audit }) {
  const extras = additionalBarcodeCandidates(audit);
  if (!extras.length) return null;
  return (
    <section className="card audit-section additional-barcodes-section" id="additional-barcodes-section">
      <div className="section-heading">
        <SectionTitle id="additional-barcodes-section-title">Additional detected barcodes</SectionTitle>
        <span className="section-status section-status-neutral">not assessed</span>
      </div>
      <p className="muted small">
        These decoded barcodes do not match a required eParcel or StarTrack specification role for the selected audit
        mode. They are retained as evidence only and are not used to satisfy required barcode checks.
      </p>
      <ul className="barcode-list decoded-list">
        {extras.map((b, idx) => (
          <li key={`${b.rawValue}-${idx}`}>
            <div className="barcode-meta">
              <strong>{barcodeDisplayName(b)}</strong> page {b.pageNumber || ''}
            </div>
            <div className="segmented-code-row">
              <RawCode barcode={b} />
              <RawCopyButtons barcode={b} />
            </div>
            <div className="muted small">
              {b.pageBoundingBox
                ? 'Barcode location was decoded on this label.'
                : 'Barcode decoded; exact location not mapped.'}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ValidationTable({ items }) {
  if (!items || !items.length) return <p className="muted small">No validation checks in this section.</p>;
  return <RuleReport items={items} standardFor={standardForValidation} />;
}

/** Vertical section navigation + review bookmarks for the left rail. The rail is a sidebar
 *  (nothing sticky covers the content), so plain anchor jumps with a small scroll margin
 *  land correctly. The "Needs review" list is the only rail block that scrolls: brand,
 *  verdict, file tabs and section nav stay fixed while a long bookmark list scrolls inside
 *  its own box. */
export function RailNav({ audit, sections }) {
  const REVIEW_SEVERITY = { fail: 0, warning: 1, manual_review: 2 };
  const reviewItems = (audit?.validations || [])
    .filter(v => v.status in REVIEW_SEVERITY)
    .sort((a, b) => REVIEW_SEVERITY[a.status] - REVIEW_SEVERITY[b.status]);
  const nav =
    audit?.carrier === 'startrack'
      ? [
          ['full-label-image', 'Full label image', sections.label],
          ['datamatrix-section', 'StarTrack QR', sections.datamatrix],
          ['routing-section', 'Routing barcode', sections.routing],
          ['atl-section', 'ATL barcode', sections.atl],
          ['freight-section', 'Freight item barcode', sections.freight],
          ['service-article-section', 'Product and article data', sections.service],
          ['text-content-section', 'Visible label text', [...sections.text, ...sections.other]]
        ]
      : [
          ['full-label-image', 'Full label image', sections.label],
          ['datamatrix-section', 'GS1 DataMatrix', sections.datamatrix],
          ['linear-section', 'GS1-128 Linear', sections.linear],
          ['service-article-section', 'Article and barcode data', sections.service],
          ['text-content-section', 'Visible label text', [...sections.text, ...sections.other]]
        ];
  return (
    <>
      <nav className="rail-nav" aria-label="Report sections">
        {nav.map(([id, label, items]) => {
          const tone = sectionTone(items);
          // The dot is colour-only; screen readers get the status as text (WCAG 1.4.1).
          const toneText =
            tone === 'fail' ? 'has failures' : tone === 'review' ? 'needs review' : tone === 'pass' ? 'passed' : '';
          return (
            <a key={id} href={`#${id}`} className={`rail-nav-item rail-${tone}`}>
              <span className="nav-dot" aria-hidden="true" />
              <span className="rail-nav-label">{label}</span>
              {toneText && <span className="sr-only">, {toneText}</span>}
            </a>
          );
        })}
      </nav>
      {reviewItems.length > 0 && (
        <div className="review-list">
          <span className="review-list-title" id="review-bookmarks">
            Needs review <span className="review-count">({reviewItems.length})</span>
          </span>
          <ul className="review-links">
            {reviewItems.map(v => (
              <li key={v.id}>
                <a
                  href={`#rule-${v.id}`}
                  className={`review-link review-link-${v.status === 'fail' ? 'fail' : 'review'}`}
                >
                  <StatusIcon status={v.status} />
                  <span className="review-link-title">{v.title}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/** Focus management for aria-modal dialogs: moves focus in on open, keeps Tab inside,
 *  and returns focus to the opening control on close (WCAG 2.4.3). */
export function useDialogFocus(active) {
  const dialogRef = useRef(null);
  useEffect(() => {
    if (!active) return undefined;
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    const opener = document.activeElement;
    const selector =
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';
    const focusables = () => [...dialog.querySelectorAll(selector)];
    (focusables()[0] || dialog).focus();
    const onKeyDown = event => {
      if (event.key !== 'Tab') return;
      const list = focusables();
      if (!list.length) {
        event.preventDefault();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', onKeyDown);
    return () => {
      dialog.removeEventListener('keydown', onKeyDown);
      if (opener && typeof opener.focus === 'function') opener.focus();
    };
  }, [active]);
  return dialogRef;
}

/** Full-screen overlay for a zoomed label image. Escape or a backdrop click closes it; clicks
 *  on the image stage are stopped so clicking the image itself does not dismiss. */
export function ImageZoomModal({ image, onClose }) {
  const dialogRef = useDialogFocus(Boolean(image));
  useEffect(() => {
    if (!image) return undefined;
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [image, onClose]);

  if (!image) return null;
  return (
    <div
      className="image-zoom-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={image.alt || 'Full label image'}
      onClick={onClose}
      ref={dialogRef}
      tabIndex={-1}
    >
      <button className="image-zoom-close" type="button" onClick={onClose} aria-label="Close full screen label image">
        Close
      </button>
      <div className="image-zoom-stage" onClick={event => event.stopPropagation()}>
        <img src={image.src} alt={image.alt || 'Full label image'} />
      </div>
    </div>
  );
}

/** Whole-label evidence: the annotated preview (click to zoom) beside the key facts read off
 *  the label, plus this section's validation rows. */
export function FullLabelImageSection({ audit, items, onZoomLabel }) {
  const facts = audit?.labelFacts || {};
  const images = audit?.labelImages || {};
  return (
    <section className="card audit-section" id="full-label-image">
      <div className="section-heading">
        <SectionTitle id="full-label-image-title">Full label image</SectionTitle>
        <SectionStatus items={items} />
      </div>
      <div className="two-col label-layout-grid">
        <div>
          {images.labelPreview ? (
            <button
              className="label-preview-button"
              type="button"
              onClick={() => onZoomLabel?.({ src: images.labelPreview, alt: 'Full label preview' })}
              aria-label="Open full screen label image"
            >
              <img className="label-preview-large" src={images.labelPreview} alt="Full label preview" />
            </button>
          ) : (
            <p className="muted">No label preview captured.</p>
          )}
          {images.labelPreview && (
            <p className="small muted preview-legend">
              Barcode outlines: <span className="legend-dot legend-valid" /> decoded &amp; valid{' · '}
              <span className="legend-dot legend-invalid" /> decoded but invalid{' · '}
              <span className="legend-dot legend-missing" /> expected, not decoded
            </p>
          )}
        </div>
        <div>
          <h3>Visible label facts</h3>
          <div className="fact-cards">
            <div>
              <span>article_id</span>
              <strong>{(facts.articleIds || []).join(', ') || 'Not extracted'}</strong>
            </div>
            <div>
              <span>consignment_id</span>
              <strong>{(facts.consignmentIds || []).join(', ') || 'Not extracted'}</strong>
            </div>
            <div>
              <span>weight</span>
              <strong>{facts.weightKg ? `${facts.weightKg}kg` : 'Not extracted'}</strong>
            </div>
            <div>
              <span>{audit?.carrier === 'startrack' ? 'label_code' : 'label_type'}</span>
              <strong>
                {audit?.carrier === 'startrack' ? facts.labelCode || 'StarTrack' : facts.labelType || 'Not extracted'}
              </strong>
            </div>
          </div>
          <ValidationTable items={items} />
        </div>
      </div>
    </section>
  );
}
const QUALITY_ADVICE = {
  sharpness:
    'Blurry input limits barcode decode and OCR accuracy. Rescan flat at 300 DPI, or hold the camera steady and closer.',
  resolution: 'Low input resolution limits what the audit can read. Rescan or export at 300 DPI or higher.',
  contrast: 'Faded print or a washed-out scan. Reprint the label or rescan with normal brightness settings.',
  ocr: 'The OCR engine had low confidence in the visible text; text-based checks may be incomplete.'
};

function QualityChip({ label, value, rating, advice }) {
  const cls = rating ? `q-${rating}` : 'q-info';
  const title = rating === 'poor' || rating === 'fair' ? advice : undefined;
  return (
    <span className={`q-chip ${cls}`} title={title}>
      <span className="q-chip-k">{label}</span> {value}
    </span>
  );
}

/**
 * Input-quality gauge shown at the top of each label's results: sharpness,
 * effective resolution (true DPI when the document declares physical size,
 * otherwise pixels per module — the narrowest bar unit of a barcode — measured
 * off the decoded symbol), tonal contrast and OCR confidence, each rated
 * good/fair/poor. Poor input is the most common cause of weak audit results,
 * so it is called out before the findings.
 */
export function InputQualityGauge({ fileInfo }) {
  const q = fileInfo?.quality;
  if (!q) return null;
  const ocr = fileInfo?.ocr;
  const sharpnessWord = { good: 'crisp', fair: 'soft', poor: 'blurry' };
  const chips = [];
  if (q.sharpness) {
    chips.push({
      label: 'Sharpness',
      value: sharpnessWord[q.sharpness.rating] || '—',
      rating: q.sharpness.rating,
      advice: QUALITY_ADVICE.sharpness
    });
  }
  if (q.resolution) {
    chips.push({
      label: 'Resolution',
      value: q.resolution.kind === 'dpi' ? `~${q.resolution.value} DPI` : `${q.resolution.value} px/module`,
      rating: q.resolution.rating,
      advice: QUALITY_ADVICE.resolution
    });
  }
  if (q.contrast) {
    chips.push({
      label: 'Contrast',
      value: q.contrast.rating === 'good' ? 'full' : q.contrast.rating === 'fair' ? 'reduced' : 'faded',
      rating: q.contrast.rating,
      advice: QUALITY_ADVICE.contrast
    });
  }
  if (Number.isFinite(ocr?.confidence)) {
    const rating = ocr.confidence >= 80 ? 'good' : ocr.confidence >= 60 ? 'fair' : 'poor';
    chips.push({ label: 'OCR confidence', value: `${ocr.confidence}%`, rating, advice: QUALITY_ADVICE.ocr });
  }
  if (!chips.length && !q.deskewDegrees) return null;
  return (
    <div className="input-quality-gauge" aria-label="Input quality assessment">
      <span className={`iq-overall q-${q.overall || 'info'}`}>Input quality</span>
      {chips.map(chip => (
        <QualityChip key={chip.label} {...chip} />
      ))}
      {q.deskewDegrees ? (
        <span className="q-chip q-info" title="The scan was tilted; it was automatically straightened before auditing.">
          auto-straightened {Math.abs(q.deskewDegrees)}°
        </span>
      ) : null}
      {q.contrastApplied ? (
        <span className="q-chip q-info" title="A faded scan was contrast-normalized before auditing.">
          contrast lifted
        </span>
      ) : null}
    </div>
  );
}

/** Small pass / review / fail key shown above a field breakdown. */
export function StatusKeyLegend() {
  return (
    <div className="status-key-legend">
      <span>
        <StatusIcon status="pass" /> pass
      </span>
      <span>
        <StatusIcon status="manual_review" /> review
      </span>
      <span>
        <StatusIcon status="fail" /> fail
      </span>
    </div>
  );
}

/** One expandable field line shared by every barcode breakdown: optional colour swatch +
 *  name + spec + raw value + status icon; char positions and reference detail live in the
 *  drawer so the line itself stays readable. */
export function FieldLine({ name, spec, value, status, detail, swatchClass }) {
  // Shown untrimmed, so fixed-width padding stays part of the raw value; all-space is "blank".
  const text = String(value ?? '');
  return (
    <details className="qr-line">
      <summary>
        <span className="qr-chev" aria-hidden="true">
          ▸
        </span>
        <span className="qr-name">
          {swatchClass ? <span className={`seg-swatch ${swatchClass}`} aria-hidden="true" /> : null}
          {name}
        </span>
        <span className="qr-spec">{spec}</span>
        <span className="qr-val">{text.trim() ? <code>{text}</code> : <span className="muted small">blank</span>}</span>
        {status ? <StatusIcon status={status} /> : <span className="qr-noico muted small">—</span>}
      </summary>
      <div className="qr-drawer">
        <code>{detail}</code>
      </div>
    </details>
  );
}
// Number of distinct seg-cN colour classes in the stylesheet; segment colours repeat modulo this.
export const SEG_PALETTE = 8;

/** Small copy-to-clipboard icon button for barcode data strings (issue #15). Shows a clipboard
 *  glyph, swapping to a check mark for a moment after a successful copy. */
export function CopyButton({ value, label = 'Copy barcode value', text }) {
  const [copied, setCopied] = useState(false);
  // Copy verbatim: fixed-width payloads (StarTrack QR) carry significant leading/
  // trailing padding, so only the "is there anything to copy" check may trim.
  const payload = String(value ?? '');
  if (!payload.trim()) return null;
  const doCopy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(payload);
      } else {
        const ta = document.createElement('textarea');
        ta.value = payload;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (blocked context); leave the value selectable manually */
    }
  };
  const tip = copied ? 'Copied' : label;
  return (
    <button
      type="button"
      className={`copy-btn${text ? ' copy-btn-labeled' : ''}${copied ? ' copied' : ''}`}
      onClick={doCopy}
      aria-label={tip}
      title={tip}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
          <path
            d="M20 6 9 17l-5-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
          <rect x="9" y="9" width="11" height="11" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
          <path d="M5 15V5a2 2 0 0 1 2-2h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      )}
      {text && <span className="copy-btn-text">{copied ? 'Copied' : text}</span>}
    </button>
  );
}

/** A barcode's captured raw content, byte-true: control characters render as visible markers
 *  (ASCII 29 as FNC1 only in a GS1 symbol). The leading FNC1 shows as its symbology identifier
 *  (]d2, ]C1), the way the spec writes a scan, and only when that identifier proves it. */
export function RawCode({ barcode, className = '' }) {
  const { raw } = rawContentOf(barcode);
  const fnc1 = leadingFnc1Info(barcode?.symbologyIdentifier);
  const segments = rawDisplaySegments(raw, { gs1: fnc1.status === 'first' });
  return (
    <code className={`raw-code raw-code-block ${className}`.trim()}>
      {fnc1.status === 'first' ? (
        <span className="ctrl-char ctrl-char-lead" title="FNC1 in first position">
          {fnc1.code}
        </span>
      ) : null}
      {segments.map((seg, i) =>
        seg.ctrl ? (
          <span key={i} className="ctrl-char" title={seg.title}>
            {seg.display}
          </span>
        ) : (
          <span key={i}>{seg.text}</span>
        )
      )}
    </code>
  );
}

/** Copy actions for one barcode: its raw captured value (control characters included), plus
 *  the decoder's readable text when that differs. */
export function RawCopyButtons({ barcode }) {
  const { raw } = rawContentOf(barcode);
  const readable = String(barcode?.rawValue || '');
  return (
    <>
      <CopyButton value={raw} label="Copy raw value (control characters included)" text="Copy raw" />
      {readable && readable !== raw ? (
        <CopyButton value={readable} label="Copy readable value" text="Copy readable" />
      ) : null}
    </>
  );
}

/** Renders a decoded barcode value with each data element highlighted in a distinct colour,
 *  plus a legend mapping colour -> field, so reviewers can see which character ranges map to
 *  which validated field. `segments` is an ordered [{ text, label }]; concatenated text equals
 *  the captured raw value exactly (markers have empty text). `readableValue`, when it differs,
 *  adds a second copy action for the decoder's readable text. */
export function SegmentedCode({
  segments,
  title = 'Barcode field map (colour-coded)',
  showLegend = true,
  readableValue = ''
}) {
  const segs = (segments || []).filter(s => s && ((s.text != null && String(s.text).length > 0) || s.display));
  if (!segs.length) return null;
  const fullValue = segs.map(s => String(s.text)).join('');
  const showReadable = Boolean(readableValue) && readableValue !== fullValue;
  return (
    <div className={title ? 'decoded-panel segmented-panel' : 'segmented-inline'}>
      {title ? <h3>{title}</h3> : null}
      <div className="segmented-code-row">
        <code className="segmented-code">
          {segs.map((s, i) => (
            <span
              key={i}
              className={s.display ? 'seg seg-sep' : `seg seg-c${i % SEG_PALETTE}`}
              title={s.title ?? s.label}
            >
              {s.display ?? String(s.text)}
            </span>
          ))}
        </code>
        <CopyButton
          value={fullValue}
          label="Copy raw value (control characters included)"
          text={showReadable ? 'Copy raw' : undefined}
        />
        {showReadable ? <CopyButton value={readableValue} label="Copy readable value" text="Copy readable" /> : null}
      </div>
      {showLegend ? (
        <ul className="segmented-legend">
          {segs.map((s, i) => (
            <li key={i}>
              <span className={`seg-swatch seg-c${i % SEG_PALETTE}`} aria-hidden="true" />
              <span className="segmented-legend-label">{s.label}</span>
              <code className="segmented-legend-val">{s.display ?? (String(s.text).trim() || '(blank)')}</code>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** QR-style per-field breakdown for a colour-segmented barcode value: one expandable line
 *  per field with its specification and status check, colour-matched to the raw string above
 *  (same segment order, so seg-cN indexes line up). */
export function SegmentedFields({ segments, kind }) {
  const segs = (segments || []).filter(s => s && (String(s.text).length > 0 || s.display));
  if (!segs.length) return null;
  const specs = fieldSpecsFor(kind, segs);
  if (!segs.some(s => specs[s.label])) return null;
  const joined = segs.map(s => String(s.text)).join('');
  const artLabels = Object.keys(ARTICLE_FIELD_SPECS);
  const ctx = {
    joined,
    article: segs
      .filter(s => artLabels.includes(s.label))
      .map(s => String(s.text))
      .join('')
  };
  const lens = segs.map(s => String(s.text).length);
  const starts = lens.map((_, i) => 1 + lens.slice(0, i).reduce((a, b) => a + b, 0));
  return (
    <div className="qr-lines">
      <StatusKeyLegend />
      <div className="qr-lines-head">
        <span />
        <span>Field</span>
        <span>Specification</span>
        <span>Raw value</span>
        <span />
      </div>
      {segs.map((s, i) => {
        const text = String(s.text);
        const start = starts[i];
        const def = specs[s.label];
        // Markers (FNC1 start, symbology identifier) are judged on the identifier, not data.
        const checked = s.ident ?? text;
        const detail = [
          s.ident ? 'symbology identifier, not part of the data' : `position ${start}, length ${text.length}`,
          fieldMetaText(def),
          def?.detail ? def.detail(checked, ctx) : ''
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <FieldLine
            key={`${i}-${s.label}`}
            swatchClass={s.display ? 'seg-sep' : `seg-c${i % SEG_PALETTE}`}
            name={s.label}
            spec={def?.spec || '—'}
            value={s.ident ? s.display : text.length ? (s.display ?? text) : ''}
            status={def?.check ? def.check(checked, ctx) : null}
            detail={detail}
          />
        );
      })}
    </div>
  );
}

/** Renders each decoded barcode value colour-coded by its field format/lengths, with the
 *  QR-style per-field breakdown beneath it when the kind has field specifications (the
 *  breakdown then replaces the plain colour legend). `showLegend` forces the legend on/off
 *  for kinds whose field table renders elsewhere (StarTrack QR). */
export function DecodedBarcodes({ barcodes, kind, label, emptyText, showLegend }) {
  if (!barcodes || !barcodes.length) return <p className="muted">{emptyText}</p>;
  return (
    <ul className="barcode-list decoded-list">
      {barcodes.map(b => {
        const segments = barcodeSegments(b, kind).filter(s => s && (String(s.text).length > 0 || s.display));
        const hasFieldRows = segments.some(s => fieldSpecsFor(kind, segments)[s.label]);
        return (
          <li key={`${b.pageNumber || 0}-${b.rawValue}`}>
            <div className="barcode-meta">
              <strong>{label}</strong> {b.pageNumber ? `page ${b.pageNumber}` : ''}
            </div>
            <SegmentedCode
              segments={segments}
              title={null}
              showLegend={showLegend ?? !hasFieldRows}
              readableValue={b.rawValue}
            />
            {hasFieldRows ? <SegmentedFields segments={segments} kind={kind} /> : null}
            <div className="muted small">
              {b.pageBoundingBox
                ? 'Barcode location verified on this label.'
                : 'Barcode decoded; exact location not mapped.'}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Plain-language description of where a label's audit text came from, so a
 * reviewer can tell selectable PDF text, successful OCR, and a failed/empty OCR
 * run apart instead of seeing only "No raw text extracted".
 */
function describeTextSource(fileInfo) {
  const sources = fileInfo?.textSources || [];
  const ocr = fileInfo?.ocr || null;
  const hasPdf = sources.includes('pdf-text-layer');
  const hasOcr = sources.includes('ocr');
  if (hasPdf && hasOcr) return 'Text source: selectable PDF text layer plus OCR of the rendered page.';
  if (hasPdf) return 'Text source: selectable PDF text layer (image OCR was not required).';
  if (hasOcr)
    return `Text source: OCR of the label image${ocr?.charCount ? ` — ${ocr.charCount} characters read` : ''}.`;
  if (!ocr) return 'Text source: none — no selectable text was found and OCR did not run.';
  if (ocr.status === 'failed')
    return `OCR could not run on this image (engine error: ${ocr.detail || 'unknown'}). See the scan log below for details.`;
  if (ocr.status === 'empty') return 'OCR ran on the label image but found no readable text.';
  if (ocr.status === 'low')
    return `OCR found only ${ocr.charCount} character${ocr.charCount === 1 ? '' : 's'} — below the usefulness threshold, so it was treated as no text.`;
  if (ocr.status === 'skipped') return 'OCR was skipped because the selectable PDF text layer was sufficient.';
  return 'Text source: none.';
}

/** Visible-text evidence: the TO / FROM / DG (dangerous goods) declaration blocks and the raw
 *  extracted text, each with its expected form, plus the text-based validation rows. */
export function TextContentSection({ audit, items, otherItems }) {
  const facts = audit?.labelFacts || {};
  return (
    <section className="card audit-section" id="text-content-section">
      <div className="section-heading">
        <SectionTitle id="text-content-section-title">Visible label text</SectionTitle>
        <SectionStatus items={[...items, ...otherItems]} />
      </div>
      <div className="facts facts-compact text-block-grid">
        <div>
          <strong>TO block</strong>
          <pre>{(facts.toBlock || []).join('\n') || 'Not extracted'}</pre>
          <StandardLine>Address should end with uppercase suburb/state/postcode, e.g. CHULLORA NSW 2190.</StandardLine>
        </div>
        <div>
          <strong>FROM/SENDER block</strong>
          <pre>{(facts.fromBlock || []).join('\n') || 'Not extracted'}</pre>
          <StandardLine>
            Sender address should remain separate from the DG declaration, e.g. RICHMOND VIC 3121.
          </StandardLine>
        </div>
        <div>
          <strong>DG declaration</strong>
          <pre>
            {(facts.dgBlock || []).join('\n') || (facts.dangerousGoodsDeclarationPresent ? 'Present' : 'Not extracted')}
          </pre>
          <StandardLine>
            Aviation Security and Dangerous Goods Declaration should appear as its own declaration section.
          </StandardLine>
        </div>
        <div>
          <strong>Raw extracted text</strong>
          <pre>{audit.extractedText || 'No raw text extracted.'}</pre>
          <p className="small muted">{describeTextSource(audit?.fileInfo)}</p>
        </div>
      </div>
      <ValidationTable items={items} />
      {otherItems?.length > 0 && (
        <>
          <h3>Other checks</h3>
          <ValidationTable items={otherItems} />
        </>
      )}
    </section>
  );
}
