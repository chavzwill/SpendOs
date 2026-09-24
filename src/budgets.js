function upsertBudget(db, budget) {
  db.prepare(`INSERT INTO budgets
    (tenant_id,scope_type,scope_id,currency,period_start,period_end,amount)
    VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(tenant_id,scope_type,scope_id,currency,period_start,period_end)
    DO UPDATE SET amount=excluded.amount`).run(
      budget.tenantId,budget.scopeType,budget.scopeId,budget.currency,
      budget.periodStart,budget.periodEnd,Number(budget.amount)
    );
}

function latestFactClause() {
  return `EXISTS (
    SELECT 1 FROM spend_events e
    JOIN source_versions sv
      ON sv.tenant_id=e.tenant_id
     AND sv.source=e.source
     AND sv.source_record_id=e.source_record_id
     AND sv.event_type=e.event_type
     AND sv.latest_event_id=e.id
    WHERE e.id=f.event_id
  )`;
}

function assessBudgets(db, tenantId, asOf = new Date().toISOString()) {
  const budgets = db.prepare(`SELECT * FROM budgets
    WHERE tenant_id=? AND period_start<=? AND period_end>=?`).all(tenantId,asOf,asOf);
  const results = [];
  for (const budget of budgets) {
    let sql = `SELECT COALESCE(SUM(f.amount),0) spent FROM spend_facts f
      WHERE f.tenant_id=? AND f.currency=? AND f.occurred_at>=? AND f.occurred_at<=?
        AND ${latestFactClause()}`;
    const args = [tenantId,budget.currency,budget.period_start,budget.period_end];
    if (budget.scope_type === 'department') { sql += ' AND f.department_id=?'; args.push(budget.scope_id); }
    if (budget.scope_type === 'location') { sql += ' AND f.location_id=?'; args.push(budget.scope_id); }
    if (budget.scope_type === 'supplier') { sql += ' AND f.supplier_id=?'; args.push(budget.scope_id); }
    const spent = Number(db.prepare(sql).get(...args).spent || 0);
    const remaining = Number(budget.amount) - spent;
    const utilization = Number(budget.amount) > 0 ? spent / Number(budget.amount) : 1;
    results.push({
      id: budget.id,
      scopeType: budget.scope_type,
      scopeId: budget.scope_id,
      currency: budget.currency,
      budget: Number(budget.amount),
      spent,
      remaining,
      utilization,
      status: spent > Number(budget.amount) ? 'exceeded' : utilization >= 0.9 ? 'near_limit' : 'within_budget'
    });
  }
  return results;
}

module.exports = { upsertBudget, assessBudgets };
