function latestAction(db, opportunityId) {
  return db.prepare(`SELECT * FROM savings_opportunity_actions
    WHERE opportunity_id=? ORDER BY effective_at DESC,id DESC LIMIT 1`).get(opportunityId);
}

function latestVerification(db, opportunityId) {
  return db.prepare(`SELECT * FROM savings_verifications
    WHERE opportunity_id=? ORDER BY id DESC LIMIT 1`).get(opportunityId);
}

function actualReceipts(db, tenantId, sku, after) {
  return db.prepare(`SELECT event_id,supplier_id,department_id,occurred_at,
    SUM(quantity) quantity,SUM(amount) amount,
    CASE WHEN SUM(quantity)>0 THEN SUM(amount)/SUM(quantity) ELSE 0 END weighted_unit_amount
    FROM spend_facts
    WHERE tenant_id=? AND state='actual' AND sku=? AND occurred_at>?
    GROUP BY event_id,supplier_id,department_id,occurred_at
    ORDER BY occurred_at,event_id`).all(tenantId,sku,after);
}

function savingsLeakageAnalysis(db, tenantId) {
  const opportunities=db.prepare(`SELECT * FROM savings_opportunities
    WHERE tenant_id=? AND status IN ('actioned','verified')
    ORDER BY last_seen_at DESC,id DESC`).all(tenantId);
  const items=[];
  for(const opportunity of opportunities) {
    const action=latestAction(db,opportunity.id);
    if(!action) continue;
    let details={};try{details=JSON.parse(opportunity.details_json||'{}');}catch{}
    const sku=details.sku;
    if(!sku) continue;

    const receipts=actualReceipts(db,tenantId,sku,action.effective_at);
    if(opportunity.kind==='supplier_alternative'&&action.action_type==='switch_supplier') {
      const oldSupplier=String(details.currentSupplierId||'');
      const expectedSupplier=String(details.alternativeSupplierId||'');
      const oldRows=receipts.filter(x=>String(x.supplier_id||'')===oldSupplier);
      if(oldSupplier&&oldRows.length) {
        items.push({
          kind:'supplier_switch_not_sticking',
          priority:'high',
          opportunityId:opportunity.id,
          sku,
          actionId:action.id,
          oldSupplierId:oldSupplier,
          expectedSupplierId:expectedSupplier||null,
          receiptCount:oldRows.length,
          quantity:Number(oldRows.reduce((s,x)=>s+Number(x.quantity||0),0).toFixed(4)),
          amount:Number(oldRows.reduce((s,x)=>s+Number(x.amount||0),0).toFixed(2)),
          evidenceEventIds:oldRows.map(x=>x.event_id),
          reason:'Actual receipts after the recorded supplier-switch action still came from the prior supplier.'
        });
      }
    }

    const verification=latestVerification(db,opportunity.id);
    if(opportunity.status==='verified'&&verification?.period_end) {
      let evidence={};try{evidence=JSON.parse(verification.evidence_json||'{}');}catch{}
      const reference=Number(evidence.referenceUnitAmount||details.currentUnitAmount||details.latestUnitAmount||0);
      if(reference>0) {
        const later=actualReceipts(db,tenantId,sku,verification.period_end);
        const qty=later.reduce((s,x)=>s+Number(x.quantity||0),0);
        const amount=later.reduce((s,x)=>s+Number(x.amount||0),0);
        const unit=qty>0?amount/qty:0;
        if(qty>0&&unit>=reference) {
          items.push({
            kind:'verified_savings_leakage_returned',
            priority:'high',
            opportunityId:opportunity.id,
            sku,
            verificationId:verification.id,
            referenceUnitAmount:Number(reference.toFixed(4)),
            laterWeightedUnitAmount:Number(unit.toFixed(4)),
            laterQuantity:Number(qty.toFixed(4)),
            evidenceEventIds:later.map(x=>x.event_id),
            reason:'Later actual receipt cost returned to or above the pre-action reference after savings had previously been verified.'
          });
        }
      }
    }
  }
  const summary={
    total:items.length,
    high:items.filter(x=>x.priority==='high').length,
    supplierSwitchNotSticking:items.filter(x=>x.kind==='supplier_switch_not_sticking').length,
    savingsLeakageReturned:items.filter(x=>x.kind==='verified_savings_leakage_returned').length
  };
  return {items,summary,methodology:{
    inferredCauses:false,
    statement:'Only causes directly demonstrated by recorded actions and later actual receipt evidence are classified. Unexplained target gaps remain unexplained rather than being guessed.'
  }};
}

module.exports={savingsLeakageAnalysis};
