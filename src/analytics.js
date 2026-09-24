function managementSnapshot(db, tenantId) {
  const totals = db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN state='requested' THEN amount ELSE 0 END),0) requested,
    COALESCE(SUM(CASE WHEN state='actual' THEN amount ELSE 0 END),0) actual,
    COALESCE(SUM(CASE WHEN state='loss' THEN amount ELSE 0 END),0) loss,
    COALESCE(SUM(CASE WHEN state='recovered' THEN amount ELSE 0 END),0) recovered
    FROM spend_facts WHERE tenant_id=?`).get(tenantId);

  const suppliers = db.prepare(`SELECT supplier_id, currency, SUM(amount) amount
    FROM spend_facts WHERE tenant_id=? AND supplier_id IS NOT NULL
    GROUP BY supplier_id, currency ORDER BY amount DESC`).all(tenantId);

  const locations = db.prepare(`SELECT location_id, currency, SUM(amount) amount
    FROM spend_facts WHERE tenant_id=? AND location_id IS NOT NULL
    GROUP BY location_id, currency ORDER BY amount DESC`).all(tenantId);

  return {
    requested: Number(totals.requested || 0),
    actual: Number(totals.actual || 0),
    loss: Number(totals.loss || 0),
    recovered: Number(totals.recovered || 0),
    netLoss: Number(totals.loss || 0) - Number(totals.recovered || 0),
    suppliers,
    locations,
  };
}

function supplierPriceHistory(db, tenantId, sku) {
  return db.prepare(`SELECT supplier_id, unit_amount, currency, occurred_at, event_id
    FROM spend_facts
    WHERE tenant_id=? AND sku=? AND supplier_id IS NOT NULL
    ORDER BY occurred_at DESC, id DESC`).all(tenantId, sku);
}

module.exports = { managementSnapshot, supplierPriceHistory };
