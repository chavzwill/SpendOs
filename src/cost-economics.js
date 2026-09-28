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
    COUNT(CASE WHEN a.state='actual' AND a.valuation_status NOT IN ('fully_valued','actual') THEN 1 END) incomplete_actual_lines
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

function targetPortfolio(db, tenantId, targetType) {
  const latest=latestAllocationClause('a');
  const rows=db.prepare(`SELECT
    a.target_id,a.target_label,a.currency,
    SUM(CASE WHEN a.state='requested' THEN a.amount ELSE 0 END) requested_cost,
    SUM(CASE WHEN a.state='actual' THEN a.amount ELSE 0 END) actual_cost,
    COUNT(CASE WHEN a.state='actual' AND a.valuation_status NOT IN ('fully_valued','actual') THEN 1 END) incomplete_actual_lines,
    COUNT(*) line_count,
    MAX(a.occurred_at) last_activity
    FROM allocation_facts a
    WHERE a.tenant_id=? AND a.target_type=? AND ${latest}
    GROUP BY a.target_id,a.target_label,a.currency
    ORDER BY actual_cost DESC,requested_cost DESC`).all(tenantId,targetType);
  return rows.map(r=>({
    targetId:r.target_id,
    targetLabel:r.target_label,
    currency:r.currency,
    requestedCost:Number(r.requested_cost||0),
    actualCost:Number(r.actual_cost||0),
    incompleteActualLines:Number(r.incomplete_actual_lines||0),
    lineCount:Number(r.line_count||0),
    lastActivity:r.last_activity
  }));
}

function allocationCoverage(db, tenantId) {
  const latest=latestAllocationClause('a');
  const totals=db.prepare(`SELECT
    COUNT(*) total_lines,
    SUM(CASE WHEN a.target_type='general_overhead' THEN 1 ELSE 0 END) overhead_lines,
    SUM(CASE WHEN a.state='actual' AND a.valuation_status NOT IN ('fully_valued','actual') THEN 1 ELSE 0 END) incomplete_actual_lines,
    SUM(CASE WHEN a.state='actual' THEN a.amount ELSE 0 END) actual_allocated_value
    FROM allocation_facts a WHERE a.tenant_id=? AND ${latest}`).get(tenantId);
  return {
    totalLines:Number(totals.total_lines||0),
    overheadLines:Number(totals.overhead_lines||0),
    incompleteActualLines:Number(totals.incomplete_actual_lines||0),
    actualAllocatedValue:Number(totals.actual_allocated_value||0)
  };
}

module.exports.targetPortfolio=targetPortfolio;
module.exports.allocationCoverage=allocationCoverage;

function targetTrend(db, tenantId, targetType, asOf = new Date().toISOString()) {
  const latest=latestAllocationClause('a');
  const asOfDate=new Date(asOf);
  const t30=new Date(asOfDate.getTime()-30*86400000).toISOString();
  const t60=new Date(asOfDate.getTime()-60*86400000).toISOString();
  const rows=db.prepare(`SELECT
    a.target_id,MAX(a.target_label) target_label,a.currency,
    SUM(CASE WHEN a.state='actual' THEN a.amount ELSE 0 END) actual_cost,
    SUM(CASE WHEN a.state='requested' THEN a.amount ELSE 0 END) requested_cost,
    SUM(CASE WHEN a.state='actual' AND a.occurred_at>=? THEN a.amount ELSE 0 END) trailing_30d_cost,
    SUM(CASE WHEN a.state='actual' AND a.occurred_at>=? AND a.occurred_at<? THEN a.amount ELSE 0 END) prior_30d_cost,
    COUNT(CASE WHEN a.state='actual' AND a.valuation_status!='fully_valued' AND a.valuation_status!='actual' THEN 1 END) incomplete_actual_lines,
    MAX(a.occurred_at) last_activity
    FROM allocation_facts a
    WHERE a.tenant_id=? AND a.target_type=? AND ${latest}
    GROUP BY a.target_id,a.currency
    ORDER BY actual_cost DESC`).all(t30,t60,t30,tenantId,targetType);
  return rows.map(r=>{
    const trailing=Number(r.trailing_30d_cost||0),prior=Number(r.prior_30d_cost||0);
    const changePct=prior>0?Number((((trailing-prior)/prior)*100).toFixed(2)):(trailing>0?null:0);
    const state=Number(r.incomplete_actual_lines||0)>0?'evidence_gap':
      (changePct!=null&&changePct>=25?'cost_rising':changePct!=null&&changePct<=-15?'cost_improving':'stable');
    return {
      targetId:r.target_id,targetLabel:r.target_label,currency:r.currency,
      actualCost:Number(r.actual_cost||0),requestedCost:Number(r.requested_cost||0),
      trailing30dCost:trailing,prior30dCost:prior,costChangePct:changePct,costState:state,
      incompleteActualLines:Number(r.incomplete_actual_lines||0),lastActivity:r.last_activity
    };
  });
}

module.exports.targetTrend=targetTrend;
