import React, { useEffect, useMemo, useReducer, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { auditLabel } from './auditEngine.js';
import { createDetector } from './scanner/decoders.js';
import { processImageLabels, processPdfLabels, yieldToBrowser } from './scanner/pipeline.js';
import {
  AdditionalBarcodesSection,
  AuditModeSection,
  CopyButton,
  FullLabelImageSection,
  ImageZoomModal,
  InputQualityGauge,
  RailNav,
  SectionTitle,
  TextContentSection,
  formatBytes,
  formatDurationMs,
  useDialogFocus
} from './report/common.jsx';
import { ServiceArticleBreakdownSection, getAuditSections } from './report/sections.jsx';
import { PrintReport, printAuditReport } from './report/printReport.jsx';
import { ReaderReportView } from './report/readerReport.jsx';
import { buildReaderResult } from './report/readerData.js';
import { MerchantProfilePanel } from './merchantProfilePanel.jsx';
import { parseLocationMasterFile } from './carriers/startrack/formats/locationMasterFile.js';
import { DataMatrixSection, LinearBarcodeSection } from './carriers/eparcel/sections.jsx';
import {
  StarTrackAtlSection,
  StarTrackFreightItemSection,
  StarTrackQrSection,
  StarTrackRoutingSection
} from './carriers/startrack/sections.jsx';
import {
  allBarcodesCopyText,
  auditConsignmentId,
  auditDisplayHeader,
  combinedAuditSummary
} from './report/auditInfo.js';
import australiaPostLogoUrl from './assets/Australia_Post_logo_logotype.png';
import './styles.css';

const APP_TITLE = 'Australia Post - eCommerce Integration Label Auditor';
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'v?';
const ACCEPTED_LABEL_FILE_TYPES = 'application/pdf,image/png,image/jpeg,image/webp,image/bmp';
// 'reader' is the rule-free Barcode Reader mode: same render/scan pipeline, no validation.
const LABEL_FAMILY_NAMES = { eparcel: 'eParcel', startrack: 'StarTrack', reader: 'Barcode Reader' };
// 'sscc' = labels whose article ID is an SSCC (Serial Shipping Container Code, the GS1 AI 00
// 18-digit logistics-unit identifier) rather than a standard article number.
const LABEL_FORMAT_NAMES = { standard: 'Standard article format', sscc: 'SSCC article identifier' };
const MAX_FILES_PER_BATCH = 20;
const MAX_LABEL_FILE_BYTES = 50 * 1024 * 1024;
/** Returns the display name shown for a carrier-specific upload/audit path. */
function labelFamilyName(labelFamily) {
  return LABEL_FAMILY_NAMES[labelFamily] || LABEL_FAMILY_NAMES.eparcel;
}
// Cap for the on-screen scan timing log: newest lines are kept, the oldest fall off.
const MAX_SCAN_DEBUG_LINES = 220;

// The merchant profile and Location Master File are conveniences kept in this browser only.
// Storage can be unavailable or full, so every access is guarded and the app works without it.
const PROFILE_STORAGE_KEY = 'barcodeAuditer.merchantProfile.v1';
const LMF_STORAGE_KEY = 'barcodeAuditer.locationMasterFile.v1';
const MAX_LMF_BYTES = 20 * 1024 * 1024;
function loadStored(key) {
  try {
    return JSON.parse(window.localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}
function saveStored(key, value) {
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
function loadStoredLmf() {
  const stored = loadStored(LMF_STORAGE_KEY);
  if (!stored?.text) return null;
  const parsed = parseLocationMasterFile(stored.text);
  return parsed.recordCount ? { fileName: stored.fileName, parsed, persisted: true } : null;
}

const INITIAL_WORKFLOW = {
  // Locks upload controls while the local render -> scan -> audit pipeline is active.
  processing: false,
  scanDebugLines: [],
  // Short status/error text shown above the timing log and report.
  message: '',
  // 'info' for status notes, 'error' for failures (red styling + role=alert).
  messageTone: 'info',
  // Raw rendered label data is kept so payload comparison can be refreshed without
  // rescanning PDFs/images.
  scanDatas: [],
  // Completed audit objects rendered by the report UI.
  audits: [],
  // Index of the label currently selected in the tabbed report view.
  activeIndex: 0
};

/** Audit workflow state: every transition of the scan/audit lifecycle in one place. */
function workflowReducer(state, action) {
  switch (action.type) {
    case 'message':
      return { ...state, message: action.message, messageTone: action.tone || 'info' };
    case 'debug':
      return { ...state, scanDebugLines: [action.line, ...state.scanDebugLines].slice(0, MAX_SCAN_DEBUG_LINES) };
    case 'batch-start':
      return {
        ...state,
        processing: true,
        scanDebugLines: [],
        message: 'Preparing barcode scanner…',
        audits: [],
        scanDatas: [],
        activeIndex: 0
      };
    case 'append-result':
      return {
        ...state,
        audits: [...state.audits, action.audit],
        scanDatas: [...state.scanDatas, action.data],
        activeIndex: state.audits.length
      };
    case 'batch-complete':
      return { ...state, activeIndex: 0, message: '' };
    case 'processing-finished':
      return { ...state, processing: false };
    case 'set-active':
      return { ...state, activeIndex: action.index };
    case 'replace-audits':
      return { ...state, audits: action.audits, message: action.message };
    default:
      return state;
  }
}

/** Root component: audit-mode selection, upload, the scan/audit pipeline, and the report view. */
function App() {
  // No carrier or label format is pre-selected: the user must consciously choose
  // both before the upload box is revealed, so a label is never audited against a
  // defaulted (and possibly wrong) rule set.
  const [selectedCarrier, setSelectedCarrier] = useState(null);
  const [selectedLabelFormat, setSelectedLabelFormat] = useState(null);
  const [workflow, dispatch] = useReducer(workflowReducer, INITIAL_WORKFLOW);
  const [zoomImage, setZoomImage] = useState(null);
  // Report view: the upload panel moves into a dismissable overlay opened from the rail.
  // Closing it preserves the current report; a new upload replaces the report.
  const [showUploader, setShowUploader] = useState(false);
  // Optional merchant profile (raw typed text) and StarTrack Location Master File.
  const [merchantProfile, setMerchantProfile] = useState(() => loadStored(PROFILE_STORAGE_KEY) || {});
  const [locationMasterFile, setLocationMasterFile] = useState(loadStoredLmf);
  const [lmfError, setLmfError] = useState('');

  function updateMerchantProfile(next) {
    setMerchantProfile(next);
    saveStored(PROFILE_STORAGE_KEY, next);
  }

  async function loadLocationMasterFile(file) {
    if (!file) return;
    setLmfError('');
    if (file.size > MAX_LMF_BYTES) {
      setLmfError(`${file.name} is ${formatBytes(file.size)}, which is too large for a Location Master File.`);
      return;
    }
    const text = await file.text();
    const parsed = parseLocationMasterFile(text);
    if (!parsed.recordCount) {
      setLmfError(`No StarTrack locations were found in ${file.name}. Load the LOCATIONS.DAT file StarTrack issued.`);
      return;
    }
    const persisted = saveStored(LMF_STORAGE_KEY, { fileName: file.name, text });
    setLocationMasterFile({ fileName: file.name, parsed, persisted });
  }

  function removeLocationMasterFile() {
    saveStored(LMF_STORAGE_KEY, null);
    setLocationMasterFile(null);
    setLmfError('');
  }

  const { processing, scanDebugLines, message, messageTone, scanDatas, audits, activeIndex } = workflow;
  const setMessage = (text, tone = 'info') => dispatch({ type: 'message', message: text, tone });
  // The upload box stays hidden until both audit-mode choices are made. The Barcode
  // Reader applies no rule set, so it has no label-format choice to wait for.
  const auditModeReady = selectedCarrier === 'reader' ? true : Boolean(selectedCarrier && selectedLabelFormat);

  const activeAudit = audits[activeIndex] || null;
  const activeScanData = scanDatas[activeIndex] || null;
  const batchSummary = useMemo(() => combinedAuditSummary(audits), [audits]);
  // Reader results carry no validations, so the rule-section grouping does not apply.
  const sections = useMemo(
    () => (activeAudit && activeAudit.carrier !== 'reader' ? getAuditSections(activeAudit) : null),
    [activeAudit]
  );
  const hasReport = audits.length > 0;
  const isReaderBatch = audits[0]?.carrier === 'reader';
  const railCarrier = activeAudit ? activeAudit.selectedAuditMode?.carrier || activeAudit.carrier : selectedCarrier;
  // Focus management for the upload dialog (shown on first load and via "New audit").
  const uploaderDialogRef = useDialogFocus(!processing && (showUploader || !hasReport));

  useEffect(() => {
    if (!showUploader) return undefined;
    const onKey = e => {
      if (e.key === 'Escape') setShowUploader(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [showUploader]);

  /** Filters browser-selected files to the PDF/image formats the scanner can render locally. */
  function normaliseSelectedFiles(selectedFiles) {
    const rejected = [];
    const accepted = Array.from(selectedFiles || []).filter(file => {
      const name = String(file.name || '').toLowerCase();
      const type = String(file.type || '').toLowerCase();
      const supported =
        type === 'application/pdf' || type.startsWith('image/') || /\.(pdf|png|jpe?g|webp|bmp)$/.test(name);
      if (!supported) {
        rejected.push(`${file.name || 'Unnamed file'} is not a supported PDF/image label.`);
        return false;
      }
      if (file.size > MAX_LABEL_FILE_BYTES) {
        rejected.push(
          `${file.name || 'Unnamed file'} is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_LABEL_FILE_BYTES)}.`
        );
        return false;
      }
      return true;
    });
    return { accepted, rejected };
  }

  /** Starts the full audit immediately after a user drops or chooses files. */
  async function acceptSelectedFiles(selectedFiles) {
    if (!auditModeReady) {
      setMessage('Select a label type (and label format) before uploading a label.');
      return;
    }
    const { accepted, rejected } = normaliseSelectedFiles(selectedFiles);
    const selected = accepted.slice(0, MAX_FILES_PER_BATCH);
    const limitMessages = [
      ...rejected,
      ...(accepted.length > MAX_FILES_PER_BATCH
        ? [`Only the first ${MAX_FILES_PER_BATCH} supported files were accepted for this batch.`]
        : [])
    ];
    if (!selected.length) {
      setMessage(limitMessages[0] || 'No supported PDF or image files were selected.', 'error');
      return;
    }
    if (limitMessages.length) {
      setMessage(limitMessages.join(' '), 'error');
    }
    await auditSelectedFiles(selected, {
      carrier: selectedCarrier,
      labelFormat: selectedCarrier === 'reader' ? 'read' : selectedLabelFormat
    });
  }

  /** Adds a wall-clock-stamped line (with optional elapsed time) to the on-screen timing log. */
  function appendScanDebug(message, durationMs = null) {
    const now = new Date();
    const time = now.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const duration = Number.isFinite(durationMs) ? ` +${formatDurationMs(durationMs)}` : '';
    dispatch({
      type: 'debug',
      line: {
        text: `[${time}]${duration} ${message}`,
        durationMs: Number.isFinite(durationMs) ? durationMs : null
      }
    });
  }

  const scanDebugText = scanDebugLines.map(line => line.text).join('\n');

  /** Main UI pipeline: render each file/page, decode barcodes, run carrier rules, then display results. */
  async function auditSelectedFiles(files, auditMode = { carrier: 'eparcel', labelFormat: 'standard' }) {
    const labelFamily = auditMode.carrier || 'eparcel';
    const labelFormat = auditMode.labelFormat || 'standard';
    const batches = files.map(file => ({ file, labelFamily, labelFormat }));
    if (!batches.length) {
      setMessage('Choose or drop one or more PDF/image label files first.');
      return;
    }
    // A new batch replaces the report, so the "new audit" overlay's job is done here;
    // closing it without uploading keeps the existing report untouched.
    setShowUploader(false);
    dispatch({ type: 'batch-start' });
    try {
      const auditStart = performance.now();
      appendScanDebug(`Started audit batch (${batches.length} file${batches.length === 1 ? '' : 's'})`);
      const scannerStart = performance.now();
      const detector = await createDetector();
      appendScanDebug(
        detector ? 'Native BarcodeDetector ready' : 'Native BarcodeDetector unavailable; using ZXing-WASM/JS scanning',
        performance.now() - scannerStart
      );
      const nextAudits = [];
      const nextScanDatas = [];
      for (let i = 0; i < batches.length; i += 1) {
        const { file: currentFile, labelFamily, labelFormat } = batches[i];
        const carrierLabel = labelFamilyName(labelFamily);
        const formatLabel = labelFamily === 'reader' ? 'read-only' : LABEL_FORMAT_NAMES[labelFormat] || labelFormat;
        const fileDebugPrefix = `${carrierLabel} ${formatLabel} file ${i + 1}/${batches.length}: ${currentFile.name}`;
        const fileTimer = performance.now();
        const fileDebug = (message, durationMs = null) =>
          appendScanDebug(`${fileDebugPrefix} - ${message}`, durationMs);
        setMessage(`Scanning ${carrierLabel} ${formatLabel} file ${i + 1} of ${batches.length}: ${currentFile.name}`);
        const dataItems =
          currentFile.type === 'application/pdf' || currentFile.name.toLowerCase().endsWith('.pdf')
            ? await processPdfLabels(currentFile, detector, fileDebug, labelFamily)
            : await processImageLabels(currentFile, detector, fileDebug, labelFamily);
        appendScanDebug(`${fileDebugPrefix} - finished render/scan phase`, performance.now() - fileTimer);

        for (let pageIndex = 0; pageIndex < dataItems.length; pageIndex += 1) {
          const data = {
            ...dataItems[pageIndex],
            labelFamily,
            labelFormat,
            fileInfo: { ...(dataItems[pageIndex].fileInfo || {}), labelFamily, labelFormat }
          };
          const itemLabel =
            data.fileInfo?.pageLabel ||
            (data.fileInfo?.sourcePdfPage ? `page ${data.fileInfo.sourcePdfPage}` : 'image');
          setMessage(
            labelFamily === 'reader'
              ? `Listing barcodes from ${currentFile.name} — ${itemLabel}`
              : `Auditing ${currentFile.name} — ${itemLabel}`
          );
          const auditRuleStart = performance.now();
          // Barcode Reader mode runs no rules: the scan data is shaped straight into a
          // read result instead of going through a carrier audit.
          const nextAudit =
            labelFamily === 'reader'
              ? buildReaderResult(data)
              : auditLabel({
                  ...data,
                  labelFamily,
                  labelFormat,
                  merchantProfile,
                  locationMasterFile: locationMasterFile?.parsed || null
                });
          appendScanDebug(
            `${fileDebugPrefix} - ${labelFamily === 'reader' ? 'listed decoded barcodes' : 'ran audit rules'} for ${itemLabel}`,
            performance.now() - auditRuleStart
          );
          nextAudit.labelImages = data.labelImages || {};
          nextAudit.extractedText = data.extractedText || '';
          nextAudit.scanDiagnostics = data.scanDiagnostics || [];
          nextAudit.batchIndex = nextAudits.length;
          nextAudit.sourceFileIndex = i;
          nextAudit.labelFamily = labelFamily;
          nextAudit.labelFormat = labelFormat;
          nextAudit.sourcePageIndex = pageIndex;
          nextAudits.push(nextAudit);
          nextScanDatas.push(data);
          dispatch({ type: 'append-result', audit: nextAudit, data });
          await yieldToBrowser();
        }
      }
      appendScanDebug('Completed audit batch', performance.now() - auditStart);
      dispatch({ type: 'batch-complete' });
      // Deferred so React has rendered the finished report before we scroll to the verdict.
      setTimeout(() => document.getElementById('audit-result')?.scrollIntoView({ block: 'start' }), 0);
    } catch (error) {
      console.error(error);
      appendScanDebug(`Stopped with error: ${error.message || String(error)}`);
      setMessage(`Error: ${error.message || String(error)}`, 'error');
    } finally {
      dispatch({ type: 'processing-finished' });
    }
  }

  /** Re-runs the rules over the labels already scanned, so a profile or Location Master
   *  File change applies to the current report without rescanning. */
  function recheckCurrentReport() {
    if (!scanDatas.length) return;
    const next = scanDatas.map((data, i) => {
      const previous = audits[i] || {};
      if (data.labelFamily === 'reader') return previous;
      const audit = auditLabel({
        ...data,
        merchantProfile,
        locationMasterFile: locationMasterFile?.parsed || null
      });
      return {
        ...audit,
        labelImages: data.labelImages || {},
        extractedText: data.extractedText || '',
        scanDiagnostics: data.scanDiagnostics || [],
        batchIndex: previous.batchIndex,
        sourceFileIndex: previous.sourceFileIndex,
        sourcePageIndex: previous.sourcePageIndex,
        labelFamily: data.labelFamily,
        labelFormat: data.labelFormat
      };
    });
    dispatch({ type: 'replace-audits', audits: next, message: 'Report re-checked with the current merchant profile.' });
    setShowUploader(false);
  }

  // Rendered inline on the landing view and inside the "new audit" overlay on the report
  // view, so both share one upload flow and one set of audit-mode selections.
  const uploadPanel = (
    <section className="card upload-card upload-split">
      <section className="audit-mode-panel" aria-labelledby="audit-mode-title">
        <h2 id="audit-mode-title">Audit mode</h2>
        <div className="mode-control-grid">
          <div>
            <span className="field-label">Label type</span>
            <div className="segmented-control" role="group" aria-label="Label type">
              {/* The Barcode Reader lives in its own block below - only the audited
                  carriers belong in the label-type choice. */}
              {Object.entries(LABEL_FAMILY_NAMES)
                .filter(([value]) => value !== 'reader')
                .map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={selectedCarrier === value ? 'active' : ''}
                    disabled={processing}
                    onClick={() => setSelectedCarrier(value)}
                  >
                    {label}
                  </button>
                ))}
            </div>
          </div>
          {selectedCarrier !== 'reader' && (
            <div>
              <span className="field-label">Label format</span>
              <div className="segmented-control" role="group" aria-label="Label format">
                {Object.entries(LABEL_FORMAT_NAMES).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={selectedLabelFormat === value ? 'active' : ''}
                    disabled={processing}
                    onClick={() => setSelectedLabelFormat(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="reader-mode-block">
          <button
            type="button"
            className={`reader-mode-btn ${selectedCarrier === 'reader' ? 'active' : ''}`}
            disabled={processing}
            aria-pressed={selectedCarrier === 'reader'}
            onClick={() => setSelectedCarrier('reader')}
          >
            <span className="reader-mode-title">Barcode Reader</span>
            <span className="reader-mode-desc">Lists every barcode with its raw value — no validation rules</span>
          </button>
        </div>
        {selectedCarrier !== 'reader' && (
          <MerchantProfilePanel
            profile={merchantProfile}
            onChange={updateMerchantProfile}
            lmf={locationMasterFile}
            lmfError={lmfError}
            onLoadLmf={loadLocationMasterFile}
            onRemoveLmf={removeLocationMasterFile}
            onClear={() => updateMerchantProfile({})}
            onRecheck={recheckCurrentReport}
            canRecheck={audits.some(a => a.carrier !== 'reader')}
            disabled={processing}
          />
        )}
        {auditModeReady ? (
          <label
            className={`dropzone dropzone-${selectedCarrier} ${processing ? 'dropzone-disabled' : ''}`}
            onDragOver={e => {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }}
            onDrop={e => {
              e.preventDefault();
              if (!processing) acceptSelectedFiles(e.dataTransfer.files);
            }}
          >
            <input
              className="file-input-hidden"
              type="file"
              multiple
              accept={ACCEPTED_LABEL_FILE_TYPES}
              disabled={processing}
              onChange={e => {
                acceptSelectedFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <span className="dropzone-title">
              {selectedCarrier === 'reader'
                ? 'Drop labels here to read every barcode'
                : `Drop ${LABEL_FAMILY_NAMES[selectedCarrier]} ${LABEL_FORMAT_NAMES[selectedLabelFormat]} labels here`}
            </span>
            <span className="dropzone-subtitle">
              {selectedCarrier === 'reader'
                ? 'PDF, PNG, JPG, WebP or BMP — raw barcode contents only, no validation rules'
                : 'PDF, PNG, JPG, WebP or BMP'}
            </span>
          </label>
        ) : (
          <p className="dropzone-pending muted" role="status">
            {!selectedCarrier && !selectedLabelFormat
              ? 'Choose a label type and a label format — or select the Barcode Reader — to enable label upload.'
              : !selectedCarrier
                ? 'Choose a label type above (or the Barcode Reader) to enable label upload.'
                : 'Choose a label format above to enable label upload.'}
          </p>
        )}
      </section>
    </section>
  );

  return (
    <main className="app">
      {/* Document heading for assistive tech; the visual brand is the rail logo. */}
      <h1 className="sr-only">{APP_TITLE}</h1>
      {/* The app is intentionally local-only: static assets and all label data stay in the browser session. */}
      {/* The report shell is the permanent backdrop: before any audit it renders as an
          empty skeleton with the upload panel hovering over it. */}
      <section className="results report-shell">
        <aside className="rail" aria-label="Audit overview and navigation">
          {/* The rail card spans the full page length; this inner wrapper is the part that
              stays pinned to the viewport and scrolls itself if it outgrows the screen. */}
          <div className="rail-inner">
            <div className="rail-brand">
              {/* Same AP emblem, tinted StarTrack blue when the audit (or the picker) is StarTrack. */}
              <img
                className={`rail-logo ${
                  railCarrier === 'startrack'
                    ? 'rail-logo-startrack'
                    : railCarrier === 'reader'
                      ? 'rail-logo-reader'
                      : ''
                }`}
                src={australiaPostLogoUrl}
                alt="Australia Post"
              />
            </div>
            {hasReport ? (
              isReaderBatch ? (
                <div className="rail-verdict rail-verdict-reader" id="audit-result" role="status">
                  <span className="rail-verdict-label">Barcode reader</span>
                  <strong className="rail-verdict-status">READ</strong>
                  <span className="rail-verdict-counts">
                    {batchSummary.decoded} barcode{batchSummary.decoded === 1 ? '' : 's'} decoded
                    {audits.length > 1 ? ` across ${audits.length} labels` : ''} · no rules applied
                  </span>
                </div>
              ) : (
                <div
                  className={`rail-verdict summary-${batchSummary.overallStatus.toLowerCase()}`}
                  id="audit-result"
                  role="status"
                >
                  <span className="rail-verdict-label">Audit result</span>
                  <strong className={`rail-verdict-status overall-${batchSummary.overallStatus.toLowerCase()}`}>
                    {batchSummary.overallStatus}
                  </strong>
                  <span className="rail-verdict-counts">
                    {batchSummary.passed} passed · {batchSummary.manualReview} review · {batchSummary.failed} fail
                    {batchSummary.failed === 1 ? '' : 's'}
                  </span>
                </div>
              )
            ) : (
              <div className="rail-verdict rail-verdict-empty" id="audit-result" role="status">
                <span className="rail-verdict-label">Audit result</span>
                <strong className="rail-verdict-status">—</strong>
                <span className="rail-verdict-counts">Upload a label to begin</span>
              </div>
            )}
            {audits.length > 1 && (
              // Plain buttons rather than a tablist: these switch the report, they are not
              // ARIA tabs (no tab panels, no arrow-key model). aria-current marks the active one.
              <div className="rail-files" role="group" aria-label="Uploaded labels">
                <span className="rail-block-title">Labels ({audits.length})</span>
                {audits.map((item, idx) => {
                  if (item.carrier === 'reader') {
                    const count = item.detectedBarcodes?.length || 0;
                    return (
                      <button
                        key={`reader-${idx}`}
                        type="button"
                        aria-current={idx === activeIndex ? 'true' : undefined}
                        className={`rail-file rail-reader ${idx === activeIndex ? 'active' : ''}`}
                        onClick={() => dispatch({ type: 'set-active', index: idx })}
                      >
                        <span className="rail-file-head">
                          <span className="nav-dot" aria-hidden="true" />
                          <code className="rail-file-article">
                            {item.fileInfo?.pageLabel || item.fileInfo?.filename || `Label ${idx + 1}`}
                          </code>
                        </span>
                        <span className="rail-file-sub">
                          {count} barcode{count === 1 ? '' : 's'} decoded
                        </span>
                        <span className="rail-file-sub">{item.fileInfo?.filename || 'Barcode read'}</span>
                      </button>
                    );
                  }
                  const h = auditDisplayHeader(item, idx);
                  const consignment = auditConsignmentId(item);
                  const tone = String(item.summary?.overallStatus || 'review').toLowerCase();
                  return (
                    <button
                      key={`${h.articleNumber}-${idx}`}
                      type="button"
                      aria-current={idx === activeIndex ? 'true' : undefined}
                      className={`rail-file rail-${tone === 'pass' ? 'pass' : tone === 'fail' ? 'fail' : 'review'} ${idx === activeIndex ? 'active' : ''}`}
                      onClick={() => dispatch({ type: 'set-active', index: idx })}
                    >
                      <span className="rail-file-head">
                        <span className="nav-dot" aria-hidden="true" />
                        <code className="rail-file-article">{h.articleNumber}</code>
                        <span className="sr-only">
                          , {tone === 'pass' ? 'passed' : tone === 'fail' ? 'failed' : 'needs review'}
                        </span>
                      </span>
                      <span className="rail-file-sub">
                        {consignment ? `Consignment ${consignment}` : 'Consignment not detected'}
                      </span>
                      <span className="rail-file-sub">
                        {h.productCode ? `${h.productCode} — ${h.productName || h.product}` : h.product}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
            {activeAudit && sections && <RailNav audit={activeAudit} sections={sections} />}
            {!hasReport && (
              <div className="rail-skeleton" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <span />
                <span />
                <span />
              </div>
            )}
          </div>
        </aside>
        <div className="report-main">
          {processing && (
            <section className="scan-progress card" aria-live="polite">
              <div className="scan-progress-head">
                <div>
                  <strong>Scanning labels</strong>
                  <span>{message || 'Processing labels'}</span>
                </div>
              </div>
            </section>
          )}
          {!processing && message && (
            <section
              className={`message${messageTone === 'error' ? ' message--error' : ''}`}
              role={messageTone === 'error' ? 'alert' : undefined}
              aria-live={messageTone === 'error' ? undefined : 'polite'}
            >
              {message}
            </section>
          )}
          {!hasReport && !processing && (
            <div className="skeleton-report" aria-hidden="true">
              <section className="card">
                <span className="skl skl-w30" />
                <span className="skl skl-lg skl-w60" />
                <span className="skl skl-w80" />
              </section>
              <section className="card">
                <span className="skl skl-w40" />
                <span className="skl skl-w90" />
                <span className="skl skl-w80" />
                <span className="skl skl-w60" />
              </section>
              <section className="card">
                <span className="skl skl-w30" />
                <span className="skl skl-w80" />
                <span className="skl skl-w70" />
              </section>
            </div>
          )}
          {activeAudit && activeAudit.carrier === 'reader' && (
            <ReaderReportView
              result={activeAudit}
              index={activeIndex}
              onNewAudit={() => setShowUploader(true)}
              processing={processing}
              onZoomLabel={setZoomImage}
            />
          )}
          {activeAudit &&
            sections &&
            (() => {
              const h = auditDisplayHeader(activeAudit, activeIndex);
              const spec = activeAudit.ruleSet?.spec;
              const specLine = spec?.doc
                ? `${spec.doc}${spec.date ? ` (${spec.date})` : ''}`
                : activeAudit.ruleSet?.name || 'carrier defaults';
              return (
                <section className="single-audit-view" key={`${h.articleNumber}-${activeIndex}`}>
                  {/* Dedicated printed document (print-only); the screen UI never prints.
                      Layout lives in report/printReport.jsx + print.css. */}
                  <PrintReport appTitle={APP_TITLE} header={h} audit={activeAudit} specLine={specLine} />
                  <section className="card compact-card selected-label-header">
                    <button
                      type="button"
                      className="new-audit-btn"
                      onClick={() => setShowUploader(true)}
                      disabled={processing}
                      title="Start a new audit (keeps this report until a new label is uploaded)"
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
                        <path
                          d="M12 11v6M9 14h6"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                        />
                      </svg>
                      <span>New audit</span>
                    </button>
                    <span className="selected-label-eyebrow">Article number</span>
                    <div className="selected-label-number">
                      <code>{h.articleNumber}</code>
                      <CopyButton
                        value={allBarcodesCopyText(activeAudit)}
                        label="Copy every decoded barcode value, one per line"
                        text="Copy all label data"
                      />
                      <button
                        type="button"
                        className="copy-btn copy-btn-labeled print-report-btn"
                        onClick={() => printAuditReport(h.articleNumber)}
                        title="Print this label's barcode findings, or choose 'Save as PDF' in the print dialog"
                      >
                        Print / Save PDF
                      </button>
                    </div>
                    <div className="selected-label-meta">
                      <span>
                        <span className="meta-k">Mode</span>
                        <span className="meta-v">
                          {LABEL_FAMILY_NAMES[activeAudit.selectedAuditMode?.carrier || activeAudit.carrier] ||
                            activeAudit.carrier}{' '}
                          /{' '}
                          {LABEL_FORMAT_NAMES[activeAudit.selectedAuditMode?.labelFormat || activeAudit.labelFormat] ||
                            activeAudit.labelFormat ||
                            'standard'}
                        </span>
                      </span>
                      <span>
                        <span className="meta-k">Rule set</span>
                        <span className="meta-v">{activeAudit.ruleSet?.name || 'carrier defaults'}</span>
                      </span>
                      <span>
                        <span className="meta-k">Product</span>
                        <span className="meta-v">
                          {h.productCode ? `${h.productCode} — ${h.productName}` : h.product}
                        </span>
                      </span>
                      <span>
                        <span className="meta-k">
                          {activeAudit.carrier === 'startrack' ? 'Routing / service' : 'Service code'}
                        </span>
                        <span className="meta-v">
                          {h.serviceCode || 'not parsed'}
                          {h.serviceName ? ` — ${h.serviceName}` : ''}
                        </span>
                      </span>
                      <span>
                        <span className="meta-k">File</span>
                        <span className="meta-v">{h.displayFile || h.filename}</span>
                      </span>
                      {(activeAudit.merchantProfileActive || activeAudit.locationMasterFileLoaded) && (
                        <span>
                          <span className="meta-k">Checked against</span>
                          <span className="meta-v">
                            {[
                              activeAudit.merchantProfileActive ? 'merchant profile' : '',
                              activeAudit.locationMasterFileLoaded ? 'Location Master File' : ''
                            ]
                              .filter(Boolean)
                              .join(' and ')}
                          </span>
                        </span>
                      )}
                    </div>
                    {/* Input-quality gauge: poor input is the most common cause of weak
                        audit results, so it is surfaced before any findings. */}
                    <InputQualityGauge fileInfo={activeAudit.fileInfo} />
                  </section>

                  {/* Full label image always leads the report so the reviewer sees the label first. */}
                  <FullLabelImageSection audit={activeAudit} items={sections.label} onZoomLabel={setZoomImage} />
                  <AuditModeSection items={sections.mode} />
                  {activeAudit.carrier === 'startrack' ? (
                    <>
                      <StarTrackQrSection
                        audit={activeAudit}
                        items={sections.datamatrix}
                        scanData={activeScanData || activeAudit}
                      />
                      <StarTrackRoutingSection
                        audit={activeAudit}
                        items={sections.routing}
                        scanData={activeScanData || activeAudit}
                      />
                      <StarTrackAtlSection
                        audit={activeAudit}
                        items={sections.atl}
                        scanData={activeScanData || activeAudit}
                      />
                      <StarTrackFreightItemSection
                        audit={activeAudit}
                        items={sections.freight}
                        scanData={activeScanData || activeAudit}
                      />
                    </>
                  ) : (
                    <>
                      <DataMatrixSection
                        audit={activeAudit}
                        items={sections.datamatrix}
                        scanData={activeScanData || activeAudit}
                      />
                      <LinearBarcodeSection
                        audit={activeAudit}
                        items={sections.linear}
                        scanData={activeScanData || activeAudit}
                      />
                    </>
                  )}
                  <AdditionalBarcodesSection audit={activeAudit} />
                  <ServiceArticleBreakdownSection audit={activeAudit} items={sections.service} />
                  {activeAudit.invalidArticleCandidates?.length > 0 && (
                    <section className="card audit-section" id="invalid-article-candidates">
                      <SectionTitle id="invalid-article-candidates-title">Invalid article candidate(s)</SectionTitle>
                      {activeAudit.invalidArticleCandidates.map(item => (
                        <p key={item.candidate}>
                          <code>{item.candidate}</code> — {item.reason}
                        </p>
                      ))}
                    </section>
                  )}
                  <TextContentSection audit={activeAudit} items={sections.text} otherItems={sections.other} />
                </section>
              );
            })()}
        </div>
      </section>

      {!processing && (showUploader || !hasReport) && (
        <div
          className="uploader-overlay"
          role="dialog"
          aria-modal="true"
          aria-label={hasReport ? 'Start a new audit' : APP_TITLE}
          onClick={() => {
            if (hasReport) setShowUploader(false);
          }}
        >
          <div className="uploader-modal" onClick={e => e.stopPropagation()} ref={uploaderDialogRef} tabIndex={-1}>
            <div className="uploader-modal-head">
              <h2>{hasReport ? 'New audit' : APP_TITLE}</h2>
              {hasReport && (
                <button
                  type="button"
                  className="uploader-close"
                  onClick={() => setShowUploader(false)}
                  aria-label="Close and keep the current report"
                >
                  <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false">
                    <path
                      d="M6 6l12 12M18 6L6 18"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              )}
            </div>
            {hasReport && (
              <p className="muted small uploader-modal-note">
                Uploading a new label replaces the current report. Close this window to keep it.
              </p>
            )}
            {uploadPanel}
          </div>
        </div>
      )}

      {scanDebugLines.length > 0 && (
        <section className="card scan-debug-card">
          <details open={processing}>
            <summary>Debug timing log</summary>
            <label className="scan-debug-label" htmlFor="scan-debug-log">
              Full timing log
            </label>
            <textarea
              id="scan-debug-log"
              className="scan-debug-log"
              rows="8"
              readOnly
              value={scanDebugText}
              placeholder="Timing events will appear here while files are processed."
            />
          </details>
        </section>
      )}
      <ImageZoomModal image={zoomImage} onClose={() => setZoomImage(null)} />
      <footer className="app-version" aria-label={`Application version ${APP_VERSION}`}>
        {APP_TITLE} {APP_VERSION}
      </footer>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
