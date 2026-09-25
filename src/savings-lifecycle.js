function getOpportunity(db, tenantId, id) {
  return db.prepare(`SELECT * FROM savings_opportunities WHERE tenant_id=? AND id=?`).get(tenantId, id);
}

function latestAction(db, opportunityId) {
  return db.prepare(`SELECT * FROM savings_opportunity_actions
    WHERE opportunity_id=? ORDER BY effective_at DESC,id DESC LIMIT 1`).get(opportunityId);
}

function recordAction(db, tenantId, opportunityId, action) {
  const opportunity=getOpportunity(db,tenantId,opportunityId);
  if(!opportunity) throw new Error('Opportunity not found');
  const actionType=String(action.actionType||'').trim();
  const actionNote=String(action.actionNote||'').trim();
  if(!actionType) throw new Error('Action type is required');
  if(!actionNote) throw new Error('Action note is required');
  const effectiveAt=action.effectiveAt||new Date().toISOString();
  db.prepare(`INSERT INTO savings_opportunity_actions
    (opportunity_id,tenant_id,action_type,action_note,actor_id,effective_at)
    VALUES (?,?,?,?,?,?)`).run(opportunityId,tenantId,actionType,actionNote,action.actorId||null,effectiveAt);
  db.prepare(`UPDATE savings_opportunities SET status='actioned' WHERE id=?`).run(opportunityId);
  return latestAction(db,opportunityId);
}

function weightedActuals(db, tenantId, sku, after, before) {
  return db.prepare(`SELECT supplier_id,
    SUM(quantity) quantity,
    SUM(amount) amount,
    CASE WHEN SUM(quantity)>0 THEN SUM(amount)/SUM(quantity) ELSE 0 END weighted_unit_amount,
    MIN(occurred_at) first_seen,
    MAX(occurred_at) last_seen,
    GROUP_CONCAT(DISTINCT event_id) event_ids
    FROM spend_facts
    WHERE tenant_id=? AND state='actual' AND sku=? AND occurred_at>=? AND occurred_at<=?
    GROUP BY supplier_id
    ORDER BY last_seen DESC`).all(tenantId,sku,after,before);
}

function appendVerification(db, opportunity, status, verifiedSavings, evidence, start, end) {
  db.prepare(`INSERT INTO savings_verifications
    (opportunity_id,tenant_id,verification_status,verified_savings,evidence_json,period_start,period_end)
    VALUES (?,?,?,?,?,?,?)`).run(
      opportunity.id,opportunity.tenant_id,status,Number(verifiedSavings||0),
      JSON.stringify(evidence||{}),start||null,end||null
    );
  if(status==='verified') {
    db.prepare(`UPDATE savings_opportunities
      SET status='verified',verified_savings=? WHERE id=?`).run(Number(verifiedSavings||0),opportunity.id);
  } else if(status==='not_verified') {
    db.prepare(`UPDATE savings_opportunities
      SET status='actioned',verified_savings=0 WHERE id=?`).run(opportunity.id);
  }
}

function verifySupplierOpportunity(db, opportunity, details, action, periodEnd) {
  const actuals=weightedActuals(db,opportunity.tenant_id,details.sku,action.effective_at,periodEnd);
  if(!actuals.length) {
    return {status:'insufficient_evidence',verifiedSavings:0,evidence:{reason:'No actual received-cost evidence after the action.',sku:details.sku}};
  }
  let referenceUnit=null;
  if(opportunity.kind==='supplier_alternative') referenceUnit=Number(details.currentUnitAmount||0);
  if(opportunity.kind==='supplier_price_drift') referenceUnit=Number(details.latestUnitAmount||0);
  if(!(referenceUnit>0)) {
    return {status:'insufficient_evidence',verifiedSavings:0,evidence:{reason:'No defensible pre-action unit-cost baseline.',sku:details.sku}};
  }

  const quantity=actuals.reduce((s,x)=>s+Number(x.quantity||0),0);
  const amount=actuals.reduce((s,x)=>s+Number(x.amount||0),0);
  const actualUnit=quantity>0?amount/quantity:0;
  const savings=Math.max(0,(referenceUnit-actualUnit)*quantity);
  const status=savings>0?'verified':'not_verified';
  return {
    status,verifiedSavings:Number(savings.toFixed(2)),
    evidence:{
      sku:details.sku,referenceUnitAmount:referenceUnit,
      postActionQuantity:Number(quantity.toFixed(4)),
      postActionAmount:Number(amount.toFixed(2)),
      postActionWeightedUnitAmount:Number(actualUnit.toFixed(4)),
      supplierBreakdown:actuals
    }
  };
}

function verifyOpportunity(db, tenantId, opportunityId, options={}) {
  const opportunity=getOpportunity(db,tenantId,opportunityId);
  if(!opportunity) throw new Error('Opportunity not found');
  const action=latestAction(db,opportunityId);
  if(!action) throw new Error('Opportunity must have a recorded action before verification');
  const details=JSON.parse(opportunity.details_json||'{}');
  let result;
  const periodEnd=options.periodEnd||new Date().toISOString();
  if(['supplier_alternative','supplier_price_drift'].includes(opportunity.kind)) {
    result=verifySupplierOpportunity(db,opportunity,details,action,periodEnd);
  } else {
    result={status:'insufficient_evidence',verifiedSavings:0,evidence:{
      reason:'This opportunity type does not yet have a defensible automated verification method.'
    }};
  }
  appendVerification(db,opportunity,result.status,result.verifiedSavings,result.evidence,action.effective_at,periodEnd);
  return {...result,opportunityId,actionEffectiveAt:action.effective_at,periodEnd};
}

function opportunityLifecycle(db, tenantId, opportunityId) {
  const opportunity=getOpportunity(db,tenantId,opportunityId);
  if(!opportunity) throw new Error('Opportunity not found');
  const actions=db.prepare(`SELECT * FROM savings_opportunity_actions
    WHERE opportunity_id=? ORDER BY effective_at,id`).all(opportunityId);
  const verifications=db.prepare(`SELECT * FROM savings_verifications
    WHERE opportunity_id=? ORDER BY created_at,id`).all(opportunityId);
  return {...opportunity,actions,verifications};
}

module.exports={recordAction,verifyOpportunity,opportunityLifecycle};
