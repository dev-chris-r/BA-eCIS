// Printed-report module: the Print / Save-as-PDF export renders THIS dedicated
// document, not the on-screen UI (print.css hides the entire app when printing).
// Layout: page 1 = header, verdict, quality gauge and the full label image with
// any overall findings; then one page per barcode - evidence crop on the left,
// the colourised raw value on the right, and a field table beneath (field,
// obligation, length, value, status), reusing the exact same segment and
// field-spec data the on-screen breakdown validates with.
import React from 'react';
import { getAuditSections } from './sections.jsx';
import { InputQualityGauge, SegmentedCode, SEG_PALETTE } from './common.jsx';
import { StatusIcon } from './reportView.jsx';
import { barcodeSegments } from './segments.js';
import { ARTICLE_FIELD_SPECS, fieldSpecsFor } from './barcodeFieldSpecs.js';
import { isDataMatrixBarcode, isLinearBarcode, isQrBarcode } from '../scanner/barcodeTypes.js';
import { isStarTrackAtlValue, isStarTrackFreightItemValue, isStarTrackRoutingValue } from '../scanner/labelImages.js';
import './print.css';

/**
 * Triggers the browser print flow with a clean document title. The title is
 * what the browser uses as the saved PDF's default filename (and as its header
 * text where the user has browser headers enabled), so it names the audit
 * rather than the app. Restored after printing.
 */
export function printAuditReport(articleNumber) {
  const previousTitle = document.title;
  const stamp = new Date().toISOString().slice(0, 10);
  // The article number is decoded from an uploaded label (untrusted); keep only
  // filename-safe characters so it cannot smuggle control/bidi codepoints into
  // the saved PDF's name.
  const safeArticle = String(articleNumber || '')
    .replace(/[^\w\- .]/g, '')
    .slice(0, 60);
  document.title = ['Barcode audit report', safeArticle, stamp].filter(Boolean).join(' - ');
  const restore = () => {
    document.title = previousTitle;
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}

const isIssue = v => v.status === 'fail' || v.status === 'warning' || v.status === 'manual_review';

/** Worst status across a section's checks: any fail => FAIL, any warning/review => REVIEW, else PASS. */
function sectionTone(items = []) {
  if (items.some(v => v.status === 'fail')) return 'fail';
  if (items.some(isIssue)) return 'review';
  return 'pass';
}

const TONE_LABEL = { pass: 'PASS', review: 'REVIEW', fail: 'FAIL' };

/** The barcode roles this label family prints, with their evidence images and segment kinds. */
function barcodeGroups(audit) {
  const images = audit?.labelImages || {};
  const detected = audit?.detectedBarcodes || [];
  const linearOnly = b => isLinearBarcode(b) && !isQrBarcode(b) && !isDataMatrixBarcode(b);
  if (audit?.carrier === 'startrack') {
    return [
      {
        key: 'datamatrix',
        title: 'StarTrack 2D QR Barcode',
        kind: 'qr',
        crop: images.qrBarcodeCrop,
        barcodes: detected.filter(isQrBarcode)
      },
      {
        key: 'routing',
        title: 'StarTrack Routing Barcode',
        kind: 'routing',
        crop: images.routingBarcodeCrop,
        barcodes: detected.filter(b => linearOnly(b) && isStarTrackRoutingValue(b.rawValue))
      },
      {
        key: 'atl',
        title: 'StarTrack ATL Barcode',
        kind: 'atl',
        crop: images.atlBarcodeCrop,
        barcodes: detected.filter(b => linearOnly(b) && isStarTrackAtlValue(b.rawValue))
      },
      {
        key: 'freight',
        title: 'StarTrack Freight Item Barcode',
        kind: 'freight',
        crop: images.freightBarcodeCrop,
        barcodes: detected.filter(b => linearOnly(b) && isStarTrackFreightItemValue(b.rawValue))
      }
    ];
  }
  const linearKind = audit?.selectedAuditMode?.labelFormat === 'sscc' ? 'eparcel-linear-sscc' : 'eparcel-linear';
  return [
    {
      key: 'datamatrix',
      title: 'GS1 DataMatrix Barcode',
      kind: 'datamatrix',
      crop: images.dataMatrixFocusedCrop || images.dataMatrixCrop,
      barcodes: detected.filter(isDataMatrixBarcode)
    },
    {
      key: 'linear',
      title: 'GS1-128 Linear Barcode',
      kind: linearKind,
      crop: images.linearBarcodeCrop || images.rightLinearBarcodeCrop,
      barcodes: detected.filter(linearOnly)
    }
  ];
}

/**
 * Field-table rows for one decoded value: the same segments and field specs the
 * on-screen breakdown uses (same colour order, checks and obligations). Returns
 * null when the kind has no field specifications (e.g. the fixed-width
 * StarTrack QR payload) - the caller then falls back to a plain segment table.
 */
function fieldRows(segments, kind) {
  const segs = segments.filter(s => s && (String(s.text).length > 0 || s.display));
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
  return segs.map((s, i) => {
    const text = String(s.text);
    const def = specs[s.label];
    // Markers (FNC1 start, symbology identifier) are judged on the identifier, not data.
    const checked = s.ident ?? text;
    return {
      swatch: s.display ? 'seg-sep' : `seg-c${i % SEG_PALETTE}`,
      name: s.label,
      obligation: def?.obligation ? def.obligation[0].toUpperCase() + def.obligation.slice(1) : '',
      length: text.length,
      value: s.ident ? s.display : text.length ? (s.display ?? text) : '',
      status: def?.check ? def.check(checked, ctx) : null
    };
  });
}

/** One line per warning/fail/manual-review finding; renders nothing when the section is clean. */
function IssueLines({ items }) {
  const issues = items.filter(isIssue);
  if (!issues.length) return null;
  return (
    <div className="pr-issues">
      {issues.map((v, i) => (
        <p key={`${v.id}-${i}`}>
          <StatusIcon status={v.status} />
          <code>{v.rule?.id || v.id}</code> <strong>{v.title}</strong>
          {v.message ? <> — {v.message}</> : null}
        </p>
      ))}
    </div>
  );
}

/**
 * One printed page per barcode role: evidence crop and colourised raw value side by
 * side, field table beneath. Only the first decode of the role is detailed; kinds
 * with no field specs fall back to a plain segment table (no obligation/status).
 */
function PrintBarcodeSection({ group, items }) {
  const barcode = group.barcodes[0] || null;
  const segments = barcode ? barcodeSegments(barcode, group.kind) : [];
  const rows = barcode ? fieldRows(segments, group.kind) : null;
  const passCount = items.filter(v => v.status === 'pass').length;
  return (
    <section className="pr-barcode">
      <div className="pr-sec-head">
        <h2>{group.title}</h2>
        <span className={`pr-status print-verdict-${sectionTone(items)}`}>{TONE_LABEL[sectionTone(items)]}</span>
      </div>
      {barcode ? (
        <>
          <div className="pr-side">
            {group.crop ? (
              <figure className="pr-crop">
                <img src={group.crop} alt={`${group.title} evidence crop`} />
              </figure>
            ) : null}
            <div className="pr-raw">
              <SegmentedCode segments={segments} title={null} showLegend={false} />
            </div>
          </div>
          <table className="pr-table">
            <thead>
              <tr>
                <th aria-label="colour" />
                <th>Field</th>
                <th>Obligation</th>
                <th>Len</th>
                <th>Value</th>
                <th aria-label="status" />
              </tr>
            </thead>
            <tbody>
              {(
                rows ||
                segments
                  .filter(s => s && (String(s.text).length > 0 || s.display))
                  .map((s, i) => ({
                    swatch: s.display ? 'seg-sep' : `seg-c${i % SEG_PALETTE}`,
                    name: s.label,
                    obligation: '',
                    length: String(s.text).length,
                    value: s.display ?? String(s.text),
                    status: null
                  }))
              ).map((r, i) => (
                <tr key={`${r.name}-${i}`}>
                  <td>
                    <span className={`seg-swatch ${r.swatch}`} aria-hidden="true" />
                  </td>
                  <td>{r.name}</td>
                  <td>{r.obligation}</td>
                  <td>{r.length}</td>
                  <td>
                    <code>{r.value || 'blank'}</code>
                  </td>
                  <td>{r.status ? <StatusIcon status={r.status} /> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : (
        <p className="pr-missing">No {group.title} was decoded from this label.</p>
      )}
      <IssueLines items={items} />
      <p className="pr-summary">
        {passCount} of {items.length} checks passed in this section.
      </p>
    </section>
  );
}

/**
 * The printed report's page-1 header: branding line, article number, verdict,
 * audit metadata, the input-quality gauge and the scope disclaimer.
 */
function PrintReportHead({ appTitle, header, audit, specLine }) {
  const summary = audit?.summary || {};
  const verdict = String(summary.overallStatus || 'REVIEW').toUpperCase();
  const tone = verdict === 'PASS' ? 'pass' : verdict === 'FAIL' ? 'fail' : 'review';
  return (
    <header className="print-report-head">
      <div className="print-head-brand">
        <strong>{appTitle}</strong>
        <span>Barcode audit report</span>
      </div>
      <div className="print-head-main">
        <span className="print-head-article">{header.articleNumber}</span>
        <span className={`print-head-verdict print-verdict-${tone}`}>{verdict}</span>
      </div>
      <dl className="print-head-meta">
        <div>
          <dt>Result</dt>
          <dd>
            {summary.passed ?? 0} passed · {summary.manualReview ?? 0} review · {summary.failed ?? 0} failed
          </dd>
        </div>
        <div>
          <dt>Product</dt>
          <dd>{header.productCode ? `${header.productCode} — ${header.productName}` : header.product}</dd>
        </div>
        <div>
          <dt>Service</dt>
          <dd>
            {header.serviceCode || 'not parsed'}
            {header.serviceName ? ` — ${header.serviceName}` : ''}
          </dd>
        </div>
        <div>
          <dt>Rule set</dt>
          <dd>{audit?.ruleSet?.name || 'carrier defaults'}</dd>
        </div>
        <div>
          <dt>File</dt>
          <dd>{header.displayFile || header.filename}</dd>
        </div>
        <div>
          <dt>Printed</dt>
          <dd>{new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })}</dd>
        </div>
      </dl>
      <InputQualityGauge fileInfo={audit?.fileInfo} />
      <p className="print-head-disclaimer">Automated digital check against {specLine}.</p>
    </header>
  );
}

/** The print document renders (hidden) inside the live app, so a defect in it
 *  must degrade to "no printed report" - never break the on-screen report. */
class PrintErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error) {
    console.warn('Printed report unavailable:', error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * The complete printed document. Rendered (hidden) alongside the screen report;
 * print.css swaps the two when printing.
 */
export function PrintReport(props) {
  return (
    <PrintErrorBoundary>
      <PrintReportBody {...props} />
    </PrintErrorBoundary>
  );
}

/** Assembles the document: page-1 head and overview, then a section per barcode role.
 *  Roles with nothing decoded AND no findings are omitted rather than printed empty. */
function PrintReportBody({ appTitle, header, audit, specLine }) {
  const sections = getAuditSections(audit);
  const groups = barcodeGroups(audit).filter(g => g.barcodes.length || (sections[g.key] || []).some(isIssue));
  const overviewItems = [
    ...(sections.mode || []),
    ...(sections.label || []),
    ...(sections.service || []),
    ...(sections.other || [])
  ];
  const labelPreview = audit?.labelImages?.labelPreview;
  return (
    <div className="print-only print-report">
      <PrintReportHead appTitle={appTitle} header={header} audit={audit} specLine={specLine} />
      <section className="pr-overview">
        {labelPreview ? (
          <img className="pr-label-img" src={labelPreview} alt="Full label with barcode outlines" />
        ) : null}
        <IssueLines items={overviewItems} />
      </section>
      {groups.map(group => (
        <PrintBarcodeSection key={group.key} group={group} items={sections[group.key] || []} />
      ))}
    </div>
  );
}
