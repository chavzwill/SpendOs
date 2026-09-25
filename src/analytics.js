function latestFactWhere(alias = 'f') {
  return `EXISTS (
    SELECT 1
    FROM spend_events e
    JOIN source_versions sv
      ON sv.tenant_id=e.tenant_id
     AND sv.source=e.source
     AND sv.source_record_id=e.source_record_id
     AND sv.event_type=e.event_type
     AND sv.latest_event_id=e.id
    WHERE e.id=${alias}.event_id
  )`;
}

function managementSnapshot(db, tenantId) {
  const latest = latestFactWhere('f');
  const totals = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN f.state='requested' THEN f.amount ELSE 0 END),0) requested,
    COALESCE(SUM(CASE WHEN f.state='actual' THEN f.amount ELSE 0 END),0) actual,
    COALESCE(SUM(CASE WHEN f.state='consumed' THEN f.amount ELSE 0 END),0) consumed,
    COALESCE(SUM(CASE WHEN f.state='loss' THEN f.amount ELSE 0 END),0) loss,
    COALESCE(SUM(CASE WHEN f.state='recovered' THEN f.amount ELSE 0 END),0) recovered
    FROM spend_facts f WHERE f.tenant_id=? AND ${latest}`).get(tenantId);

  const suppliers = db.prepare(`SELECT f.supplier_id, f.currency, SUM(f.amount) amount
    FROM spend_facts f
    WHERE f.tenant_id=? AND f.supplier_id IS NOT NULL AND ${latest}
    GROUP BY f.supplier_id, f.currency ORDER BY amount DESC`).all(tenantId);

  const locations = db.prepare(`SELECT f.location_id, f.currency, SUM(f.amount) amount
    FROM spend_facts f
    WHERE f.tenant_id=? AND f.location_id IS NOT NULL AND ${latest}
    GROUP BY f.location_id, f.currency ORDER BY amount DESC`).all(tenantId);

  return {
    requested: Number(totals.requested || 0),
    actual: Number(totals.actual || 0),
    consumed: Number(totals.consumed || 0),
    loss: Number(totals.loss || 0),
    recovered: Number(totals.recovered || 0),
    netLoss: Number(totals.loss || 0) - Number(totals.recovered || 0),
    suppliers,
    locations,
  };
}

function supplierPriceHistory(db, tenantId, sku) {
  const latest = latestFactWhere('f');
  return db.prepare(`SELECT f.supplier_id, f.unit_amount, f.currency, f.occurred_at, f.event_id
    FROM spend_facts f
    WHERE f.tenant_id=? AND f.sku=? AND f.supplier_id IS NOT NULL AND ${latest}
    ORDER BY f.occurred_at DESC, f.id DESC`).all(tenantId, sku);
}

module.exports = { managementSnapshot, supplierPriceHistory, latestFactWhere };
