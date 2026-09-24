// Optional merchant profile on the upload screen: the values Australia Post / StarTrack
// issued to the merchant under audit, plus StarTrack's Location Master File. With them
// entered, ownership and depot checks become real pass/fail results. Presentational
// only - App owns the state, persistence and re-audit (src/main.jsx).
import React from 'react';
import { MERCHANT_PROFILE_FIELDS, normalizeMerchantProfile } from './carriers/shared/merchantProfile.js';

/** One-line summary for the collapsed panel, e.g. "2 MLIDs, 1 despatch ID, LMF loaded". */
function profileSummary(profile, lmf) {
  const p = normalizeMerchantProfile(profile);
  const count = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : '');
  const ssccRanges = p.eparcelSsccParcelPost.length + p.eparcelSsccExpressPost.length + p.startrackSscc.length;
  const parts = [
    count(p.mlids.length, 'MLID', 'MLIDs'),
    count(p.despatchIds.length, 'despatch ID', 'despatch IDs'),
    count(p.startrackAccounts.length, 'account', 'accounts'),
    count(ssccRanges, 'SSCC range', 'SSCC ranges'),
    lmf ? 'Location Master File loaded' : ''
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Not set. Ownership checks are skipped.';
}

export function MerchantProfilePanel({
  profile,
  onChange,
  lmf,
  lmfError,
  onLoadLmf,
  onRemoveLmf,
  onClear,
  onRecheck,
  canRecheck,
  disabled
}) {
  const invalidSscc = normalizeMerchantProfile(profile).invalidSsccEntries;
  return (
    <details className="profile-panel">
      <summary>
        <span className="profile-title">Merchant profile</span>
        <span className="profile-state">{profileSummary(profile, lmf)}</span>
      </summary>
      <p className="muted small profile-intro">
        Optional. Enter the values issued to this merchant and the audit checks the label uses them, not just that they
        look right. Saved on this computer only.
      </p>
      <div className="profile-grid">
        {MERCHANT_PROFILE_FIELDS.map(field => (
          <label key={field.key} className="profile-field">
            <span className="field-label">{field.label}</span>
            <textarea
              rows={2}
              value={profile[field.key] || ''}
              placeholder={field.placeholder}
              disabled={disabled}
              onChange={e => onChange({ ...profile, [field.key]: e.target.value })}
            />
          </label>
        ))}
      </div>
      {invalidSscc.length > 0 && (
        <p className="profile-warning" role="alert">
          These SSCC entries aren&apos;t a digit prefix or a start-end range, so they&apos;re ignored:{' '}
          {invalidSscc.join(', ')}
        </p>
      )}
      <div className="profile-lmf">
        <span className="field-label">StarTrack Location Master File</span>
        {lmf ? (
          <p className="profile-lmf-loaded">
            <strong>{lmf.fileName}</strong>: {lmf.parsed.recordCount.toLocaleString()} locations
            {lmf.parsed.malformed ? `, ${lmf.parsed.malformed} unreadable lines skipped` : ''}
            {lmf.persisted === false ? '. Too large to keep for next time, so load it again after a restart' : ''}.
            <button type="button" className="profile-link-btn" onClick={onRemoveLmf} disabled={disabled}>
              Remove
            </button>
          </p>
        ) : (
          <label className="profile-lmf-upload">
            <input
              type="file"
              accept=".dat,.txt,text/plain"
              disabled={disabled}
              onChange={e => {
                onLoadLmf(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            Load LOCATIONS.DAT
          </label>
        )}
        {lmfError && (
          <p className="profile-warning" role="alert">
            {lmfError}
          </p>
        )}
        <p className="muted small">
          Use the file StarTrack issued for this merchant&apos;s despatch site. It checks delivery locations, routing
          depots, ports and the QR destination depot.
        </p>
      </div>
      <div className="profile-actions">
        <button type="button" className="profile-link-btn" onClick={onClear} disabled={disabled}>
          Clear profile
        </button>
        {canRecheck && (
          <button type="button" className="profile-recheck-btn" onClick={onRecheck} disabled={disabled}>
            Re-check the current report
          </button>
        )}
      </div>
    </details>
  );
}
