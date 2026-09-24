// StarTrack-specific report sections: QR field table, routing, ATL, freight
// item, product/article data, and the product reference matrix.
import React from 'react';
import { FORMAT_KIND } from '../../scanner/barcodeTypes.js';
import {
  DecodedBarcodes,
  FieldLine,
  SEG_PALETTE,
  SectionStatus,
  SectionTitle,
  SegmentedCode,
  StandardLine,
  StatusKeyLegend,
  ValidationTable,
  imageBoxCaption,
  sectionHasIssues
} from '../../report/common.jsx';
import {
  decodedBarcodeList,
  starTrackAtlBarcodeList,
  starTrackFreightBarcodeList,
  starTrackRoutingBarcodeList
} from '../../report/auditInfo.js';
import { QR_FIELD_SOURCE, fieldMetaText } from '../../report/barcodeFieldSpecs.js';
import { leadingFnc1Info, rawContentOf, rawDisplaySegments } from '../../report/readerData.js';
import { barcodeSegments, rawSegments } from '../../report/segments.js';
import { STARTRACK_QR_FIELDS } from './formats/qr.js';
import { STARTRACK_PRODUCT_CODE_MAP } from './referenceData.js';

const QR_OBLIGATION_LABEL = { M: 'Mandatory', COND: 'Conditional', O: 'Optional' };

/** A captured barcode value as plain text, exactly as scanned, with control characters shown
 *  as markers (ASCII 29 as FNC1 only in a GS1 symbol). */
function rawText(barcode) {
  const { raw } = rawContentOf(barcode);
  const gs1 = leadingFnc1Info(barcode?.symbologyIdentifier).status === 'first';
  return rawDisplaySegments(raw, { gs1 })
    .map(s => (s.ctrl ? s.display : s.text))
    .join('');
}

/** An SSCC parse as a barcode-like object, so it displays from its captured bytes. */
const ssccBarcode = s => ({ rawBytes: s.rawBytes, rawValue: s.raw, symbologyIdentifier: s.symbologyIdentifier });

/** One expandable QR field line: the StarTrack QR spec fields carry their own rule ids,
 *  obligations and fixed char positions. */
function QrFieldLine({ field, value, status, swatchClass }) {
  const obligation = QR_OBLIGATION_LABEL[field.obligation] || field.obligation;
  return (
    <FieldLine
      name={field.label}
      spec={field.obligation === 'M' ? field.criteria : `${obligation}. ${field.criteria}`}
      value={value}
      status={status}
      swatchClass={swatchClass}
      detail={`${field.rule ? `${field.rule} · ` : ''}field ${field.num} · position ${field.pos}, length ${field.len} · ${obligation} · ${fieldMetaText(QR_FIELD_SOURCE)}`}
    />
  );
}

/** Status of the per-field rule (ST-QR-Fnn) for a QR field, matching exact or forEach-suffixed ids. */
function qrFieldStatus(items, ruleId) {
  if (!ruleId) return null;
  const rows = items || [];
  const exact = rows.find(it => String(it.id || '') === ruleId);
  if (exact) return exact.status;
  const prefixed = rows.find(it => String(it.id || '').startsWith(`${ruleId}_`));
  return prefixed ? prefixed.status : null;
}
/** QR section: crop image, raw payload colour-coded by field, and per-field parse rows. */
export function StarTrackQrSection({ audit, items }) {
  const images = audit?.labelImages || {};
  const qrBarcodes = decodedBarcodeList(audit, 'qr');
  const qrs = audit?.startrack?.qrParses || [];
  return (
    <section className="card audit-section startrack-section" id="datamatrix-section">
      <div className="section-heading">
        <SectionTitle id="datamatrix-section-title">StarTrack 2D QR Barcode</SectionTitle>
        <SectionStatus items={items} />
      </div>
      <div className="two-col">
        <div>
          {images.qrBarcodeCrop ? (
            <figure className="category-crop">
              <img src={images.qrBarcodeCrop} alt="StarTrack QR barcode crop" />
              <figcaption>{imageBoxCaption(images, FORMAT_KIND.qr)}</figcaption>
            </figure>
          ) : (
            <p className="muted">No QR barcode crop captured.</p>
          )}
        </div>
        <div>
          {sectionHasIssues(items) && (
            <StandardLine>
              StarTrack QR fields are fixed width and include receiver suburb/postcode, connote, freight item number,
              product code, quantity, weight, despatch date, unit type, destination depot, DG indicator and movement
              type.
            </StandardLine>
          )}
          <div className="decoded-panel">
            <h3>Raw decoded QR string (colour-coded by field)</h3>
            <DecodedBarcodes
              barcodes={qrBarcodes}
              kind="qr"
              label="QR"
              emptyText="No StarTrack QR value decoded from the uploaded file."
              showLegend={qrs.length === 0}
            />
          </div>
          {qrs.length > 0 &&
            qrs.map(qr => {
              // Colour-match each parsed field row to its segment in the raw string above:
              // both derive from rawSegments(raw, 'qr'), so the filtered segment order fixes
              // the seg-cN palette index for a given "<num>. <label>" field.
              const segLabels = rawSegments(qr.raw, 'qr')
                .filter(s => String(s.text).length > 0)
                .map(s => s.label);
              return (
                <div key={qr.raw} className="decoded-panel qr-fields-panel">
                  <h3>Parsed QR payload fields</h3>
                  <p className="muted small">
                    Product {qr.productCode || '—'}
                    {qr.productName ? ` — ${qr.productName}` : ''} · payload {qr.length} chars
                  </p>
                  <div className="qr-lines">
                    <StatusKeyLegend />
                    <div className="qr-lines-head">
                      <span />
                      <span>Field</span>
                      <span>Specification</span>
                      <span>Raw value</span>
                      <span />
                    </div>
                    {STARTRACK_QR_FIELDS.map(f => {
                      const segIndex = segLabels.indexOf(`${f.num}. ${f.label}`);
                      return (
                        <QrFieldLine
                          key={f.key}
                          field={f}
                          // The exact fixed-width slice, padding included (the parsed field is trimmed).
                          value={String(qr.raw || '').slice(f.pos - 1, f.pos - 1 + f.len)}
                          status={qrFieldStatus(items, f.rule)}
                          swatchClass={segIndex >= 0 ? `seg-c${segIndex % SEG_PALETTE}` : null}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          <ValidationTable items={items} />
        </div>
      </div>
    </section>
  );
}
/** Routing barcode section: crop, decoded values, and parsed label-code/postcode/depot cards. */
export function StarTrackRoutingSection({ audit, items }) {
  const images = audit?.labelImages || {};
  const routingBarcodes = starTrackRoutingBarcodeList(audit);
  const routes = audit?.startrack?.routingParses || [];
  return (
    <section className="card audit-section startrack-section" id="routing-section">
      <div className="section-heading">
        <SectionTitle id="routing-section-title">StarTrack Routing Barcode</SectionTitle>
        <SectionStatus items={items} />
      </div>
      <div className="two-col">
        <div>
          {images.routingBarcodeCrop ? (
            <figure className="category-crop wide">
              <img src={images.routingBarcodeCrop} alt="StarTrack routing barcode crop" />
              <figcaption>{imageBoxCaption(images, 'startrack-routing')}</figcaption>
            </figure>
          ) : (
            <p className="muted">No routing barcode crop captured.</p>
          )}
        </div>
        <div>
          <h3>Decoded routing barcode values (colour-coded by field)</h3>
          <DecodedBarcodes
            barcodes={routingBarcodes}
            kind="routing"
            label="Routing barcode"
            emptyText="No StarTrack routing barcode value decoded."
          />
          {routes.length > 0 && (
            <p className="muted small routing-review-note">
              Depot and port codes require manual validation: they are assigned from the StarTrack Location Master File,
              which this audit cannot query digitally.
            </p>
          )}
          {sectionHasIssues(items) && routes.length > 0 && (
            <div className="fact-cards fact-cards-wide">
              {routes.map(route => (
                <React.Fragment key={route.raw}>
                  <div>
                    <span>Label code</span>
                    <strong>{route.labelCode}</strong>
                  </div>
                  <div>
                    <span>Postcode</span>
                    <strong>{route.postcode}</strong>
                  </div>
                  <div>
                    <span>Depot / port</span>
                    <strong>{route.depotOrPort || 'Not applicable'}</strong>
                  </div>
                  <div>
                    <span>Format</span>
                    <strong>{route.formatDescription}</strong>
                  </div>
                </React.Fragment>
              ))}
            </div>
          )}
          {sectionHasIssues(items) && (
            <StandardLine>
              StarTrack routing barcode is required separately from the freight item and ATL barcodes. Standard format
              is SSS9999DD/DDD: Premium and Fixed Price Premium labels commonly use a three-character depot/port suffix,
              while Express labels may use a two-character suffix. AU domestic SSCC labels may use GS1 421/403 routing.
            </StandardLine>
          )}
          <ValidationTable items={items} />
        </div>
      </div>
    </section>
  );
}

/** ATL (Authority To Leave) barcode section: crop, decoded values, and counter details. */
export function StarTrackAtlSection({ audit, items }) {
  const images = audit?.labelImages || {};
  const atlBarcodes = starTrackAtlBarcodeList(audit);
  const atlParses = audit?.startrack?.atlParses || [];
  return (
    <section className="card audit-section startrack-section" id="atl-section">
      <div className="section-heading">
        <SectionTitle id="atl-section-title">StarTrack ATL Barcode</SectionTitle>
        <SectionStatus items={items} />
      </div>
      <div className="two-col">
        <div>
          {images.atlBarcodeCrop ? (
            <figure className="category-crop wide">
              <img src={images.atlBarcodeCrop} alt="StarTrack ATL barcode crop" />
              <figcaption>{imageBoxCaption(images, 'startrack-atl')}</figcaption>
            </figure>
          ) : (
            <p className="muted">No ATL barcode crop captured.</p>
          )}
        </div>
        <div>
          <h3>Decoded ATL barcode values (colour-coded by field)</h3>
          <DecodedBarcodes
            barcodes={atlBarcodes}
            kind="atl"
            label="ATL barcode"
            emptyText="No StarTrack ATL barcode value decoded."
          />
          {sectionHasIssues(items) && atlParses.length > 0 && (
            <div className="fact-cards fact-cards-wide">
              {atlParses.map(atl => (
                <React.Fragment key={atl.atlNumber}>
                  <div>
                    <span>ATL number</span>
                    <strong>{atl.atlNumber}</strong>
                  </div>
                  <div>
                    <span>Counter</span>
                    <strong>{atl.counter}</strong>
                  </div>
                  <div>
                    <span>Format</span>
                    <strong>C999999999</strong>
                  </div>
                  <div>
                    <span>Orientation</span>
                    <strong>Picket Fence</strong>
                  </div>
                </React.Fragment>
              ))}
            </div>
          )}
          {sectionHasIssues(items) && (
            <StandardLine>
              StarTrack ATL barcode content is C999999999. C is always the character C and the nine-digit sequential
              counter starts at 000000001. Preferred orientation is Picket Fence, minimum bar height 10mm, minimum
              barcode length 28mm, left/right quiet zone 5mm, and resolution 6 dots per mm.
            </StandardLine>
          )}
          <ValidationTable items={items} />
        </div>
      </div>
    </section>
  );
}

/** Freight item barcode section, covering both the 20-char Code 128 and SSCC forms. */
export function StarTrackFreightItemSection({ audit, items }) {
  const images = audit?.labelImages || {};
  const freightBarcodes = starTrackFreightBarcodeList(audit);
  const freightParses = audit?.startrack?.freightParses || [];
  const ssccs = audit?.startrack?.ssccParses || [];
  return (
    <section className="card audit-section startrack-section" id="freight-section">
      <div className="section-heading">
        <SectionTitle id="freight-section-title">StarTrack Freight Item Barcode</SectionTitle>
        <SectionStatus items={items} />
      </div>
      <div className="two-col">
        <div>
          {images.freightBarcodeCrop ? (
            <figure className="category-crop wide">
              <img src={images.freightBarcodeCrop} alt="StarTrack freight item barcode crop" />
              <figcaption>{imageBoxCaption(images, 'startrack-freight')}</figcaption>
            </figure>
          ) : (
            <p className="muted">No freight item barcode crop captured.</p>
          )}
        </div>
        <div>
          <h3>Decoded freight item barcode values (colour-coded by field)</h3>
          <DecodedBarcodes
            barcodes={freightBarcodes}
            kind="freight"
            label="Freight item barcode"
            emptyText="No StarTrack freight item / SSCC barcode value decoded."
          />
          {sectionHasIssues(items) && freightParses.length > 0 && (
            <div className="fact-cards fact-cards-wide">
              {freightParses.map(f => (
                <React.Fragment key={f.freightItemId}>
                  <div>
                    <span>article_id</span>
                    <strong>{f.freightItemId}</strong>
                  </div>
                  <div>
                    <span>consignment_id</span>
                    <strong>{f.connoteNumber}</strong>
                  </div>
                  <div>
                    <span>product_code</span>
                    <strong>
                      {f.productCode} — {f.productName}
                    </strong>
                  </div>
                  <div>
                    <span>item_sequence</span>
                    <strong>{f.itemNumber}</strong>
                  </div>
                </React.Fragment>
              ))}
            </div>
          )}
          {sectionHasIssues(items) && ssccs.length > 0 && (
            <details className="reference-details sscc-details">
              <summary>SSCC details ({ssccs.length})</summary>
              <div className="fact-cards fact-cards-wide">
                {ssccs.map(s => (
                  <React.Fragment key={s.sscc}>
                    <div>
                      <span>SSCC</span>
                      <strong>{rawText(ssccBarcode(s))}</strong>
                    </div>
                    <div>
                      <span>Extension digit</span>
                      <strong>{s.extensionDigit}</strong>
                    </div>
                    <div>
                      <span>Check digit</span>
                      <strong>{s.checkDigit}</strong>
                    </div>
                    <div>
                      <span>Expected check digit</span>
                      <strong>{s.expectedCheckDigit}</strong>
                    </div>
                  </React.Fragment>
                ))}
              </div>
              {ssccs.map(s => (
                <SegmentedCode
                  key={`seg-${s.sscc}`}
                  segments={barcodeSegments(ssccBarcode(s), 'sscc')}
                  title="SSCC field map (colour-coded)"
                  readableValue={s.raw}
                />
              ))}
            </details>
          )}
          {sectionHasIssues(items) && (
            <StandardLine>
              StarTrack freight item barcode is mandatory and is separate from the routing barcode. It is either
              20-character Code128 XXXZ99999999AAA99999 or GS1 AI 00 SSCC.
            </StandardLine>
          )}
          <ValidationTable items={items} />
        </div>
      </div>
    </section>
  );
}
/** Cross-barcode summary: products, freight/SSCC ids, routing codes, plus the reference matrix. */
export function StarTrackProductArticleSection({ audit, items }) {
  const st = audit?.startrack || {};
  const products = [
    ...new Set(
      [...(st.freightParses || []).map(f => f.productCode), ...(st.qrParses || []).map(q => q.productCode)].filter(
        Boolean
      )
    )
  ];
  // The routing barcodes exactly as scanned (the GS1 421 form keeps its captured FNC1).
  const routingValues = [...new Set(starTrackRoutingBarcodeList(audit).map(rawText))];
  const ssccOnly = Boolean(st.ssccOnly);
  return (
    <section className="card audit-section startrack-section" id="service-article-section">
      <div className="section-heading">
        <SectionTitle id="service-article-section-title">StarTrack Product, Routing and Article Data</SectionTitle>
        <SectionStatus items={items} />
      </div>
      {ssccOnly && (
        <div className="info-panel sscc-panel">
          <strong>StarTrack SSCC label detected.</strong>
          <p>
            Product code is not embedded in the SSCC article identifier. Product context is assessed from the QR
            payload, routing barcode or manifest data when available.
          </p>
        </div>
      )}
      <div className="fact-cards fact-cards-wide">
        <div>
          <span>Freight item barcode(s)</span>
          <strong>{(st.freightParses || []).map(f => f.raw).join(', ') || 'Not decoded'}</strong>
        </div>
        <div>
          <span>SSCC value(s)</span>
          <strong>{(st.ssccParses || []).map(s => rawText(ssccBarcode(s))).join(', ') || 'Not decoded'}</strong>
        </div>
        <div>
          <span>Product code(s)</span>
          <strong>
            {products.length
              ? products.map(p => `${p} — ${STARTRACK_PRODUCT_CODE_MAP[p]?.name || 'Unknown'}`).join(', ')
              : ssccOnly
                ? 'Not encoded in SSCC'
                : 'Not parsed'}
          </strong>
        </div>
        <div>
          <span>Routing code(s)</span>
          <strong>{routingValues.length ? routingValues.join(', ') : 'Not decoded'}</strong>
        </div>
      </div>
      <StandardLine>
        Supported StarTrack products include EXP, PRM, FPP, ARL, FPA, RET, RE2, APT and TSE. Product-to-label-code
        relationships include EXP→EXP, PRM/FPP→PRM and ARL/FPA→ARL.
      </StandardLine>
      <ValidationTable items={items} />
      <div className="matrix-block">
        <h3 className="matrix-block-title">StarTrack product and label-code reference</h3>
        <StarTrackProductMatrix audit={audit} />
      </div>
    </section>
  );
}

/** Reference table of all StarTrack products, highlighting rows matching decoded product/label codes. */
function StarTrackProductMatrix({ audit }) {
  const selectedProducts = new Set(
    [
      ...(audit?.startrack?.freightParses || []).map(f => f.productCode),
      ...(audit?.startrack?.qrParses || []).map(q => q.productCode)
    ].filter(Boolean)
  );
  const selectedLabelCodes = new Set(
    [...(audit?.startrack?.routingParses || []).map(r => r.labelCode), audit?.labelFacts?.labelCode].filter(Boolean)
  );
  return (
    <div className="table-wrap">
      <table className="compact-table startrack-matrix">
        <thead>
          <tr>
            <th>Product Code</th>
            <th>Product Name</th>
            <th>Group</th>
            <th>Label Code</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(STARTRACK_PRODUCT_CODE_MAP).map(([code, meta]) => {
            return (
              <tr
                key={code}
                className={
                  selectedProducts.has(code) || selectedLabelCodes.has(meta.labelCode) ? 'row-pass selected' : ''
                }
              >
                <td>
                  <strong>{code}</strong>
                  {selectedProducts.has(code) && <span className="pill">selected</span>}
                </td>
                <td>{meta.name}</td>
                <td>{meta.group}</td>
                <td>
                  <strong>{meta.labelCode}</strong>
                  {selectedLabelCodes.has(meta.labelCode) && <span className="pill">selected</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
