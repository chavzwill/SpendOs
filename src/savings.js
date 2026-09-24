function opportunityKey(opportunity) {
  if (opportunity.kind === 'supplier_price_drift') {
    return `price-drift:${opportunity.sku}:${opportunity.supplierId}:${opportunity.currency || ''}`;
  }
  if (opportunity.kind === 'supplier_alternative') {
    return `supplier-alt:${opportunity.sku}:${opportunity.currentSupplierId}:${opportunity.alternativeSupplierId}:${opportunity.currency || ''}`;
  }
  if (opportunity.kind === 'consumable_variance') {
    return `consumable:${opportunity.departmentId}:${opportunity.sku}`;
  }
  return `${opportunity.kind}:${JSON.stringify(opportunity)}`;
}

function estimateSavings(opportunity) {
  if (opportunity.kind === 'supplier_price_drift') {
    return Math.max(0, opportunity.latestUnitAmount - opportunity.baselineUnitAmount) * Math.max(1, Number(opportunity.latestQuantity || 1));
  }
  if (opportunity.kind === 'supplier_alternative') {
    return Math.max(0, opportunity.currentUnitAmount - opportunity.alternativeUnitAmount) * Math.max(1, Number(opportunity.currentQuantity || 1));
  }
  return 0;
}

function persistOpportunities(db, opportunities) {
  const stmt = db.prepare(`INSERT INTO savings_opportunities
    (tenant_id,opportunity_key,kind,currency,estimated_savings,evidence_json,details_json)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,opportunity_key)
    DO UPDATE SET estimated_savings=excluded.estimated_savings,
      evidence_json=excluded.evidence_json,
      details_json=excluded.details_json,
      last_seen_at=CURRENT_TIMESTAMP`);
  for (const opportunity of opportunities) {
    stmt.run(
      opportunity.tenantId,
      opportunityKey(opportunity),
      opportunity.kind,
      opportunity.currency || null,
      estimateSavings(opportunity),
      JSON.stringify(opportunity.evidenceEventIds || []),
      JSON.stringify(opportunity)
    );
  }
}

function listOpportunities(db, tenantId) {
  return db.prepare(`SELECT id, opportunity_key, kind, status, currency,
    estimated_savings, verified_savings, evidence_json, details_json,
    first_seen_at, last_seen_at
    FROM savings_opportunities WHERE tenant_id=?
    ORDER BY estimated_savings DESC, id ASC`).all(tenantId);
}

module.exports = { opportunityKey, estimateSavings, persistOpportunities, listOpportunities };
