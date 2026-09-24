// Rule-by-rule report view. Each validation row expands into three panes:
// the input data scraped from the label, the validation rule (plain English
// plus the executable JSON rule logic), and the outcome. Designed for the
// ECIS in-browser report; tests/rulesCatalogue.test.mjs guards the rule catalogue.
import React, { useMemo, useState } from 'react';
import { formatRuleSource } from './ruleSource.js';

const STATUS_LABELS = {
  pass: 'PASS',
  fail: 'FAIL',
  warning: 'WARNING',
  manual_review: 'MANUAL REVIEW',
  not_applicable: 'N/A',
  info: 'INFO'
};

function statusKey(status) {
  return STATUS_LABELS[status] ? status : 'not_applicable';
}

function RuleStatusBadge({ status }) {
  const key = statusKey(status);
  return <span className={`badge badge-${key}`}>{STATUS_LABELS[key]}</span>;
}

const STATUS_ICON_VARIANT = {
  pass: 'pass',
  fail: 'fail',
  warning: 'review',
  manual_review: 'review',
  not_applicable: 'neutral',
  info: 'neutral'
};

const STATUS_ICON_PATH = {
  pass: 'M8.5 12.5l2.5 2.5 4.5-5',
  fail: 'M15 9l-6 6M9 9l6 6',
  review: 'M8 12h8',
  neutral: 'M8 12h8'
};

/** Result icon used across the report: green tick (pass), amber dash (review) or red cross (fail). */
export function StatusIcon({ status }) {
  const key = statusKey(status);
  const variant = STATUS_ICON_VARIANT[key] || 'neutral';
  return (
    <svg
      className={`status-ico status-ico-${variant}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={STATUS_LABELS[key]}
    >
      <circle cx="12" cy="12" r="9" />
      <path d={STATUS_ICON_PATH[variant]} />
    </svg>
  );
}

/** Display form of any rule input value: scalars as-is, string arrays one per line, anything
 *  else pretty-printed JSON (String() fallback when it cannot be serialised). */
/** Makes captured control characters visible (ASCII 29 as ⟨GS⟩, others as hex) without
 *  touching tabs and line breaks, so raw barcode evidence reads as it was scanned. */
function showControls(text) {
  return String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ch =>
    ch === '\x1d' ? '⟨GS⟩' : `⟨0x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}⟩`
  );
}

function formatInputValue(value) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
    return showControls(String(value));
  if (Array.isArray(value) && value.every(v => typeof v === 'string')) return showControls(value.join('\n'));
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Maps a rule input path to its data provenance so every field is clearly marked
// as coming from a decoded barcode versus visible text / OCR. Barcode decode is the
// source of truth; text is only ever cross-checked against it, never a value source.
const PROVENANCE = {
  barcode: { label: 'Decoded barcode', cls: 'prov-barcode' },
  qr: { label: 'QR payload (decoded)', cls: 'prov-barcode' },
  text: { label: 'Visible text / OCR', cls: 'prov-text' },
  derived: { label: 'Derived / expected', cls: 'prov-derived' },
  meta: { label: 'Document / selection', cls: 'prov-meta' }
};

/** Classifies a rule input/evidence path (e.g. "barcodes.atl", "text.toBlock") by data source. */
export function fieldProvenance(path) {
  const p = String(path || '');
  if (/^text(\.|$)/.test(p)) return PROVENANCE.text;
  if (/^item\.fields(\.|$)/.test(p)) return PROVENANCE.qr;
  if (/^(barcodes|item|articles)(\.|$)/.test(p)) return PROVENANCE.barcode;
  if (/^derived(\.|$)/.test(p)) return PROVENANCE.derived;
  return PROVENANCE.meta;
}

/** Small pill that labels where a rule's data came from (barcode scan vs text/OCR). */
function ProvenanceBadge({ path }) {
  if (!path) return null;
  const prov = fieldProvenance(path);
  return <span className={`prov-badge ${prov.cls}`}>{prov.label}</span>;
}

/** One validation row: a collapsed head line (status icon, rule id, title, observed value)
 *  that expands into the three detail panes — input data, validation rule, outcome. */
function RuleRow({ v, standardFor }) {
  // All rows start collapsed (including fails): the head line already carries the
  // status icon, badge and observed value; the panes are opt-in detail.
  const [open, setOpen] = useState(false);
  const [showLogic, setShowLogic] = useState(false);
  const rule = v.rule || null;
  const sourceText = formatRuleSource(rule?.source);
  const description = rule?.description || (standardFor ? standardFor(v) : '') || '';
  const inputValue = formatInputValue(v.input?.value);
  const observed = v.actual || inputValue;
  // JSON shown by "View rule logic": drop empty entries so only the active constraints print.
  const logic = rule?.logic
    ? {
        id: rule.id,
        obligation: rule.obligation,
        ...Object.fromEntries(Object.entries(rule.logic).filter(([, val]) => val !== undefined && val !== null))
      }
    : null;

  return (
    <div className={`rule-row tone-${statusKey(v.status)}`} id={`rule-${v.id}`}>
      <button type="button" className="rule-row-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <StatusIcon status={v.status} />
        <code className="rule-id">{rule?.id || v.id}</code>
        <span className="rule-title">{v.title}</span>
        {isIssue(v) && (
          <span className={`badge rule-head-tag badge-${statusKey(v.status)}`}>
            {v.status === 'fail' ? 'FAIL' : v.status === 'warning' ? 'WARNING' : 'REVIEW'}
          </span>
        )}
        {observed && (
          <span className="rule-observed" title={observed}>
            {observed}
          </span>
        )}
        <span className="rule-chevron" aria-hidden="true">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {/* Rendered hidden rather than conditionally, so the print stylesheet can force
          every row's detail panes open for the exported report. */}
      <div className="rule-row-body" hidden={!open}>
        <div className="rule-panes">
          <div className="rule-pane">
            <p className="rule-pane-title">Input data</p>
            {v.input?.path && (
              <p className="rule-kv">
                <span className="rule-kv-label">Source</span>
                <code>{v.input.path}</code>
                <ProvenanceBadge path={v.input.path} />
              </p>
            )}
            {inputValue && <pre className="rule-input-value">{inputValue}</pre>}
            {(v.input?.evidence || []).map(e => (
              <div key={e.path} className="rule-kv-block">
                <span className="rule-kv-label">
                  <code>{e.path}</code>
                  <ProvenanceBadge path={e.path} />
                </span>
                <pre>{formatInputValue(e.value)}</pre>
              </div>
            ))}
            {!inputValue && !(v.input?.evidence || []).length && !v.evidence && (
              <p className="muted small">No input data was captured for this rule.</p>
            )}
            {v.evidence && (
              <details className="rule-evidence">
                <summary>Evidence</summary>
                <pre>{showControls(v.evidence)}</pre>
              </details>
            )}
          </div>
          <div className="rule-pane">
            <p className="rule-pane-title">Validation rule</p>
            {description && <p className="rule-description">{description}</p>}
            {sourceText && <p className="rule-source">{sourceText}</p>}
            {logic && (
              <button type="button" className="rule-logic-toggle" onClick={() => setShowLogic(s => !s)}>
                {showLogic ? 'Hide rule logic' : 'View rule logic'}
              </button>
            )}
            {logic && showLogic && <pre className="rule-logic">{JSON.stringify(logic, null, 2)}</pre>}
          </div>
          <div className="rule-pane">
            <p className="rule-pane-title">Outcome</p>
            {isIssue(v) ? (
              <p>
                <RuleStatusBadge status={v.status} />
              </p>
            ) : (
              <p className="rule-outcome-quiet">{v.status === 'pass' ? 'Passed' : 'Not applicable'}</p>
            )}
            {v.expected && (
              <p className="rule-kv">
                <span className="rule-kv-label">Expected</span>
                <code>{v.expected}</code>
              </p>
            )}
            {v.actual && (
              <p className="rule-kv">
                <span className="rule-kv-label">Actual</span>
                <code>{v.actual}</code>
              </p>
            )}
            <p className="rule-message">{v.message}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function isIssue(v) {
  return v.status === 'fail' || v.status === 'warning' || v.status === 'manual_review';
}

/** Rule-by-rule report: filter chips plus one expandable row per validation result.
 *  Defaults to warnings & fails only, so all-pass sections collapse to a one-line summary;
 *  the All / Passed chips expand the full rule list on demand. */
export function RuleReport({ items, standardFor }) {
  const [filter, setFilter] = useState('issues');
  const counts = useMemo(
    () => ({
      issues: items.filter(isIssue).length,
      all: items.length,
      pass: items.filter(v => v.status === 'pass').length
    }),
    [items]
  );
  const filtered = items.filter(
    v => filter === 'all' || (filter === 'issues' && isIssue(v)) || (filter === 'pass' && v.status === 'pass')
  );
  return (
    <div className="rule-report">
      <div className="rule-filters" role="group" aria-label="Filter rules by status">
        {[
          ['issues', 'Warnings & fails'],
          ['all', 'All'],
          ['pass', 'Passed']
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={`rule-filter-chip ${filter === key ? 'is-active' : ''}`}
            onClick={() => setFilter(key)}
            disabled={key !== 'all' && counts[key] === 0}
          >
            {label} ({counts[key]})
          </button>
        ))}
      </div>
      {filtered.length ? (
        filtered.map((v, idx) => <RuleRow key={`${v.id}-${idx}`} v={v} standardFor={standardFor} />)
      ) : filter === 'issues' ? (
        <p className="muted small">
          No warnings or failures in this section — {counts.pass} rule{counts.pass === 1 ? '' : 's'} passed.
        </p>
      ) : (
        <p className="muted small">No rules match this filter.</p>
      )}
    </div>
  );
}
