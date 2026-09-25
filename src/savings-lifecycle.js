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
    department_id,
    MIN(occurred_at) first_seen,
    MAX(occurred_at) last_seen,
    GROUP_CONCAT(DISTINCT f.event_id) event_ids
    FROM spend_facts f LEFT JOIN savings_verification_evidence_claims c ON c.tenant_id=f.tenant_id AND c.event_id=f.event_id AND COALESCE(c.sku,'')=COALESCE(f.sku,'')
    WHERE f.tenant_id=? AND f.state='actual' AND f.sku=? AND f.occurred_at>=? AND f.occurred_at<=? AND c.id IS NULL
    GROUP BY f.supplier_id,f.department_id
    ORDER BY last_seen DESC`).all(tenantId,sku,after,before);
}

function receiptEvidenceRows(db, tenantId, sku, actuals) {
  const ids=[...new Set(actuals.flatMap(x=>String(x.event_ids||'').split(',').filter(Boolean)))];
  const rows=[];
  const stmt=db.prepare(`SELECT event_id,supplier_id,department_id,SUM(quantity) quantity,SUM(amount) amount,MAX(occurred_at) occurred_at
    FROM spend_facts WHERE tenant_id=? AND state='actual' AND sku=? AND event_id=?
    GROUP BY event_id,supplier_id,department_id`);
  for(const id of ids) {
    for(const row of stmt.all(tenantId,sku,id)) rows.push(row);
  }
  return rows;
}

function appendVerification(db, opportunity, status, verifiedSavings, evidence, start, end) {
  const inserted=db.prepare(`INSERT INTO savings_verifications
    (opportunity_id,tenant_id,verification_status,verified_savings,evidence_json,period_start,period_end)
    VALUES (?,?,?,?,?,?,?)`).run(
      opportunity.id,opportunity.tenant_id,status,Number(verifiedSavings||0),
      JSON.stringify(evidence||{}),start||null,end||null
    );
  evidence._verificationId=Number(inserted.lastInsertRowid||0);
  if(status==='verified') {
    db.prepare(`UPDATE savings_opportunities
      SET status='verified',verified_savings=verified_savings+? WHERE id=?`).run(Number(verifiedSavings||0),opportunity.id);
  } else if(status==='not_verified' && Number(opportunity.verified_savings||0)<=0) {
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

  const receiptEvents=receiptEvidenceRows(db,opportunity.tenant_id,details.sku,actuals);
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
      receiptEventCount:receiptEvents.length,
      receiptEvents,
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
  if(result.status==='verified') claimVerificationEvidence(db,result.evidence._verificationId,opportunity,result.verifiedSavings,result.evidence);
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

function claimVerificationEvidence(db, verificationId, opportunity, verifiedSavings, evidence) {
  const rows=Array.isArray(evidence?.receiptEvents)?evidence.receiptEvents:[];
  const totalQty=rows.reduce((s,x)=>s+Number(x.quantity||0),0);
  const stmt=db.prepare(`INSERT INTO savings_verification_evidence_claims
    (tenant_id,verification_id,opportunity_id,event_id,sku,claimed_savings)
    VALUES (?,?,?,?,?,?)`);
  for(const row of rows) {
    const share=totalQty>0?Number(verifiedSavings||0)*(Number(row.quantity||0)/totalQty):0;
    stmt.run(opportunity.tenant_id,verificationId,opportunity.id,row.event_id,evidence.sku||null,Number(share.toFixed(2)));
  }
}

function verifiedSavingsRollup(db, tenantId) {
  const claims=db.prepare(`SELECT c.event_id,c.sku,c.claimed_savings,o.kind,o.currency,v.period_end,v.created_at
    FROM savings_verification_evidence_claims c
    JOIN savings_opportunities o ON o.id=c.opportunity_id
    JOIN savings_verifications v ON v.id=c.verification_id
    WHERE c.tenant_id=?`).all(tenantId);
  const factStmt=db.prepare(`SELECT supplier_id,department_id
    FROM spend_facts WHERE tenant_id=? AND event_id=? AND sku=? LIMIT 1`);
  const groups={currency:new Map(),supplier:new Map(),category:new Map(),department:new Map(),period:new Map()};
  const add=(map,key,currency,amount)=>{
    const id=String(key||'unattributed')+'::'+String(currency||'UNKNOWN');
    map.set(id,(map.get(id)||0)+Number(amount||0));
  };
  for(const claim of claims) {
    const fact=factStmt.get(tenantId,claim.event_id,claim.sku)||{};
    const currency=claim.currency||'UNKNOWN';
    const period=String(claim.period_end||claim.created_at||'').slice(0,7)||'unknown';
    add(groups.currency,currency,currency,claim.claimed_savings);
    add(groups.supplier,fact.supplier_id,currency,claim.claimed_savings);
    add(groups.category,claim.kind,currency,claim.claimed_savings);
    add(groups.department,fact.department_id,currency,claim.claimed_savings);
    add(groups.period,period,currency,claim.claimed_savings);
  }
  const rows=map=>[...map.entries()].map(([id,amount])=>{
    const split=id.lastIndexOf('::');
    return {dimension:id.slice(0,split),currency:id.slice(split+2),verifiedSavings:Number(amount.toFixed(2))};
  }).sort((a,b)=>b.verifiedSavings-a.verifiedSavings);
  return {
    totalsByCurrency:rows(groups.currency),
    bySupplier:rows(groups.supplier),
    byCategory:rows(groups.category),
    byDepartment:rows(groups.department),
    byPeriod:rows(groups.period),
    claimedEvidenceCount:claims.length
  };
}
module.exports.verifiedSavingsRollup=verifiedSavingsRollup;
