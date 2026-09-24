function detectPriceDrift(db, tenantId, { minPct = 5 } = {}) {
  const rows = db.prepare(`
    SELECT f.sku, f.supplier_id, f.currency, f.unit_amount, f.quantity, f.occurred_at, f.event_id
    FROM spend_facts f
    WHERE f.tenant_id=? AND f.state='requested' AND f.sku IS NOT NULL AND f.supplier_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM spend_events e
        JOIN source_versions sv
          ON sv.tenant_id=e.tenant_id AND sv.source=e.source
         AND sv.source_record_id=e.source_record_id AND sv.event_type=e.event_type
         AND sv.latest_event_id=e.id
        WHERE e.id=f.event_id
      )
    ORDER BY sku, occurred_at ASC, id ASC
  `).all(tenantId);

  const bySku = new Map();
  for (const row of rows) {
    const key = row.sku;
    if (!bySku.has(key)) bySku.set(key, []);
    bySku.get(key).push(row);
  }

  const opportunities = [];
  for (const [sku, history] of bySku) {
    if (history.length < 2) continue;
    const latest = history[history.length - 1];
    const prior = history.slice(0, -1).filter(x => x.unit_amount > 0);
    if (!prior.length) continue;
    const baseline = Math.min(...prior.map(x => Number(x.unit_amount)));
    const latestPrice = Number(latest.unit_amount);
    const driftPct = baseline > 0 ? ((latestPrice - baseline) / baseline) * 100 : 0;
    if (driftPct < minPct) continue;
    opportunities.push({
      kind: 'supplier_price_drift',
      tenantId,
      sku,
      supplierId: latest.supplier_id,
      currency: latest.currency,
      baselineUnitAmount: baseline,
      latestUnitAmount: latestPrice,
      latestQuantity: Number(latest.quantity || 0),
      driftPct,
      evidenceEventIds: [latest.event_id, ...prior.filter(x => Number(x.unit_amount) === baseline).map(x => x.event_id)].slice(0, 5),
    });
  }
  return opportunities;
}

function detectSupplierAlternatives(db, tenantId, { minPct = 3 } = {}) {
  const rows = db.prepare(`
    SELECT f.sku, f.supplier_id, f.currency, f.unit_amount, f.quantity, f.occurred_at, f.event_id
    FROM spend_facts f
    WHERE f.tenant_id=? AND f.state='requested' AND f.sku IS NOT NULL AND f.supplier_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM spend_events e
        JOIN source_versions sv
          ON sv.tenant_id=e.tenant_id AND sv.source=e.source
         AND sv.source_record_id=e.source_record_id AND sv.event_type=e.event_type
         AND sv.latest_event_id=e.id
        WHERE e.id=f.event_id
      )
    ORDER BY occurred_at DESC, id DESC
  `).all(tenantId);

  const latestPerSupplierSku = new Map();
  for (const row of rows) {
    const key = `${row.sku}::${row.supplier_id}::${row.currency || ''}`;
    if (!latestPerSupplierSku.has(key)) latestPerSupplierSku.set(key, row);
  }

  const bySku = new Map();
  for (const row of latestPerSupplierSku.values()) {
    const key = `${row.sku}::${row.currency || ''}`;
    if (!bySku.has(key)) bySku.set(key, []);
    bySku.get(key).push(row);
  }

  const opportunities = [];
  for (const [key, offers] of bySku) {
    if (offers.length < 2) continue;
    offers.sort((a,b) => Number(a.unit_amount) - Number(b.unit_amount));
    const best = offers[0];
    const worst = offers[offers.length - 1];
    if (Number(best.unit_amount) <= 0) continue;
    const savingsPct = ((Number(worst.unit_amount) - Number(best.unit_amount)) / Number(worst.unit_amount)) * 100;
    if (savingsPct < minPct) continue;
    const [sku, currency] = key.split('::');
    opportunities.push({
      kind: 'supplier_alternative',
      tenantId,
      sku,
      currency: currency || null,
      currentSupplierId: worst.supplier_id,
      alternativeSupplierId: best.supplier_id,
      currentUnitAmount: Number(worst.unit_amount),
      alternativeUnitAmount: Number(best.unit_amount),
      currentQuantity: Number(worst.quantity || 0),
      savingsPct,
      evidenceEventIds: [worst.event_id, best.event_id],
    });
  }
  return opportunities;
}

function detectConsumableVariance(db, tenantId, { tolerancePct = 20 } = {}) {
  const rows = db.prepare(`
    SELECT f.department_id, f.sku, f.quantity, f.occurred_at, f.event_id
    FROM spend_facts f
    WHERE f.tenant_id=? AND f.state='requested' AND f.department_id IS NOT NULL AND f.sku IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM spend_events e
        JOIN source_versions sv
          ON sv.tenant_id=e.tenant_id AND sv.source=e.source
         AND sv.source_record_id=e.source_record_id AND sv.event_type=e.event_type
         AND sv.latest_event_id=e.id
        WHERE e.id=f.event_id
      )
    ORDER BY occurred_at ASC, id ASC
  `).all(tenantId);
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.department_id}::${row.sku}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const opportunities = [];
  for (const [key, history] of groups) {
    if (history.length < 3) continue;
    const latest = history[history.length - 1];
    const baselineRows = history.slice(0, -1);
    const baselineQty = baselineRows.reduce((s,x)=>s+Number(x.quantity),0)/baselineRows.length;
    if (baselineQty <= 0) continue;
    const variancePct = ((Number(latest.quantity)-baselineQty)/baselineQty)*100;
    if (variancePct <= tolerancePct) continue;
    const [departmentId, sku] = key.split('::');
    opportunities.push({
      kind:'consumable_variance',
      tenantId,
      departmentId,
      sku,
      baselineQty,
      currentQty:Number(latest.quantity),
      variancePct,
      evidenceEventIds:[latest.event_id, ...baselineRows.map(x=>x.event_id).slice(-4)],
    });
  }
  return opportunities;
}

module.exports = { detectPriceDrift, detectSupplierAlternatives, detectConsumableVariance };
