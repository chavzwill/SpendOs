function latestAllocationClause(alias='a') {
  return `EXISTS (
    SELECT 1 FROM spend_events e
    JOIN source_versions sv
      ON sv.tenant_id=e.tenant_id
     AND sv.source=e.source
     AND sv.source_record_id=e.source_record_id
     AND sv.event_type=e.event_type
     AND sv.latest_event_id=e.id
    WHERE e.id=${alias}.event_id
  )`;
}

function targetCostSummary(db, tenantId, targetType, targetId) {
  const latest=latestAllocationClause('a');
  const totals=db.prepare(`SELECT
    COALESCE(SUM(CASE WHEN a.state='requested' THEN a.amount ELSE 0 END),0) requested,
    COALESCE(SUM(CASE WHEN a.state='actual' THEN a.amount ELSE 0 END),0) actual,
    COUNT(CASE WHEN a.state='actual' AND a.valuation_status!='fully_valued' THEN 1 END) incomplete_actual_lines
    FROM allocation_facts a
    WHERE a.tenant_id=? AND a.target_type=? AND COALESCE(a.target_id,'')=COALESCE(?,'') AND ${latest}`)
    .get(tenantId,targetType,targetId);

  const categories=db.prepare(`SELECT
    COALESCE(a.expense_category,'uncategorized') expense_category,
    a.state,a.currency,SUM(a.amount) amount
    FROM allocation_facts a
    WHERE a.tenant_id=? AND a.target_type=? AND COALESCE(a.target_id,'')=COALESCE(?,'') AND ${latest}
    GROUP BY COALESCE(a.expense_category,'uncategorized'),a.state,a.currency
    ORDER BY amount DESC`).all(tenantId,targetType,targetId);

  const history=db.prepare(`SELECT a.*
    FROM allocation_facts a
    WHERE a.tenant_id=? AND a.target_type=? AND COALESCE(a.target_id,'')=COALESCE(?,'') AND ${latest}
    ORDER BY a.occurred_at DESC,a.id DESC LIMIT 250`).all(tenantId,targetType,targetId);

  return {
    tenantId,targetType,targetId,
    requestedCost:Number(totals.requested||0),
    actualCost:Number(totals.actual||0),
    incompleteActualLines:Number(totals.incomplete_actual_lines||0),
    categories,history
  };
}

module.exports={targetCostSummary,latestAllocationClause};
