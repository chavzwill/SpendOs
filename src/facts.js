function factsFromEvent(event) {
  const payload = event.payload || {};
  if (event.type === 'purchase.requested') {
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
  if (event.type === 'consumable.issued' || event.type === 'purchase.received') {
    return (payload.items || []).map(item => ({
      eventId: event.id,
      tenantId: event.tenantId,
      state: event.type === 'purchase.received' ? 'actual' : 'consumed',
      supplierId: event.type === 'purchase.received' ? (payload.supplierId || null) : null,
      locationId: event.locationId || null,
      departmentId: event.departmentId || null,
      sku: item.sku || null,
      description: item.productName || item.description || null,
      quantity: Number(item.quantity || 0),
      unitAmount: event.type === 'purchase.received' ? Number(item.unitCost || 0) : (Number(item.quantity || 0) > 0 ? Number(item.trackedValue || 0) / Number(item.quantity || 1) : 0),
      amount: event.type === 'purchase.received' ? Number(item.lineCost || 0) : Number(item.trackedValue || 0),
      currency: payload.currency || null,
      occurredAt: event.occurredAt,
    }));
  }
  return [];
}

function allocationFactsFromEvent(event) {
  const payload = event.payload || {};
  const state = (event.type === 'consumable.issued' || event.type === 'purchase.received') ? 'actual' :
    event.type === 'purchase.requested' ? 'requested' : null;
  if (!state) return [];
  const facts = [];
  for (const item of payload.items || []) {
    for (const allocation of item.allocations || []) {
      facts.push({
        eventId:event.id,tenantId:event.tenantId,state,
        targetType:allocation.targetType,targetId:allocation.targetId || null,
        targetLabel:allocation.targetLabel || null,sku:item.sku || null,
        description:item.description || item.productName || null,
        quantity:allocation.quantity == null ? null : Number(allocation.quantity),
        amount:Number(allocation.amount || 0),currency:payload.currency || null,
        purpose:allocation.purpose || null,expenseCategory:allocation.expenseCategory || null,
        valuationStatus:allocation.valuationStatus || (state === 'actual' ? item.valuationStatus || 'unvalued' : 'declared'),
        occurredAt:event.occurredAt
      });
    }
  }
  return facts;
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

function insertAllocationFacts(db, facts) {
  const stmt = db.prepare(`INSERT INTO allocation_facts
    (event_id,tenant_id,state,target_type,target_id,target_label,sku,description,quantity,amount,currency,purpose,expense_category,valuation_status,occurred_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const fact of facts) {
    stmt.run(fact.eventId,fact.tenantId,fact.state,fact.targetType,fact.targetId,
      fact.targetLabel,fact.sku,fact.description,fact.quantity,fact.amount,fact.currency,
      fact.purpose,fact.expenseCategory,fact.valuationStatus,fact.occurredAt);
  }
}

module.exports = { factsFromEvent, allocationFactsFromEvent, insertFacts, insertAllocationFacts };
