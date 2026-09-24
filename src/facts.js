function factsFromEvent(event) {
  if (event.type !== 'purchase.requested') return [];
  const payload = event.payload || {};
  return (payload.items || []).map(item => ({
    eventId: event.id,
    tenantId: event.tenantId,
    state: 'requested',
    supplierId: payload.supplierId || null,
    locationId: event.locationId || null,
    departmentId: event.departmentId || null,
    sku: item.sku || null,
    description: item.description || null,
    quantity: Number(item.quantity || 0),
    unitAmount: Number(item.unitCost || 0),
    amount: Number(item.lineTotal ?? (Number(item.quantity || 0) * Number(item.unitCost || 0))),
    currency: payload.currency || null,
    occurredAt: event.occurredAt,
  }));
}

function insertFacts(db, facts) {
  const stmt = db.prepare(`INSERT INTO spend_facts
    (event_id,tenant_id,state,supplier_id,location_id,department_id,sku,description,quantity,unit_amount,amount,currency,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const fact of facts) {
    stmt.run(fact.eventId,fact.tenantId,fact.state,fact.supplierId,fact.locationId,
      fact.departmentId,fact.sku,fact.description,fact.quantity,fact.unitAmount,
      fact.amount,fact.currency,fact.occurredAt);
  }
}

module.exports = { factsFromEvent, insertFacts };
