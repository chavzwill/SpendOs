const { savingsLeakageAnalysis } = require('./savings-leakage');

function appendCaseEvent(db, caseId, eventType, actorId, note, evidence) {
  db.prepare(`INSERT INTO savings_leakage_case_events
    (case_id,event_type,actor_id,note,evidence_json)
    VALUES (?,?,?,?,?)`).run(caseId,eventType,actorId||null,note||null,evidence?JSON.stringify(evidence):null);
}

function refreshLeakageCases(db, tenantId) {
  const leakage=savingsLeakageAnalysis(db,tenantId);
  const seen=[];
  for(const item of leakage.items) {
    const key=[tenantId,item.opportunityId,item.kind];
    const existing=db.prepare(`SELECT * FROM savings_leakage_cases
      WHERE tenant_id=? AND opportunity_id=? AND leakage_kind=?`).get(...key);
    if(existing) {
      let prior={};try{prior=JSON.parse(existing.detection_evidence_json||'{}');}catch{}
      const priorIds=new Set(prior.evidenceEventIds||[]);
      const currentIds=item.evidenceEventIds||[];
      const unseenIds=currentIds.filter(id=>!priorIds.has(id));
      const cutoff=existing.action_effective_at||existing.resolved_at||existing.last_seen_at;
      const evidenceAfterCorrectiveAction=unseenIds.filter(id=>{
        const row=db.prepare('SELECT 1 ok FROM spend_facts WHERE tenant_id=? AND event_id=? AND occurred_at>? LIMIT 1').get(tenantId,id,cutoff);
        return !!row;
      });
      const shouldReopen=existing.status==='verified_resolved'&&evidenceAfterCorrectiveAction.length>0;
      db.prepare(`UPDATE savings_leakage_cases SET
        sku=?,priority=?,detection_evidence_json=?,last_seen_at=CURRENT_TIMESTAMP,
        status=CASE WHEN ? THEN 'identified' ELSE status END,
        resolved_at=CASE WHEN ? THEN NULL ELSE resolved_at END
        WHERE id=?`).run(item.sku,item.priority||'high',JSON.stringify(item),shouldReopen?1:0,shouldReopen?1:0,existing.id);
      if(shouldReopen) appendCaseEvent(db,existing.id,'reopened_by_evidence',null,'New leakage evidence appeared after verified resolution.',{...item,newEvidenceIds:evidenceAfterCorrectiveAction});
      seen.push(existing.id);
    } else {
      const info=db.prepare(`INSERT INTO savings_leakage_cases
        (tenant_id,opportunity_id,leakage_kind,sku,priority,detection_evidence_json)
        VALUES (?,?,?,?,?,?)`).run(tenantId,item.opportunityId,item.kind,item.sku,item.priority||'high',JSON.stringify(item));
      const id=Number(info.lastInsertRowid);
      appendCaseEvent(db,id,'identified',null,item.reason||'Leakage identified from actual receipt evidence.',item);
      seen.push(id);
    }
  }
  return listLeakageCases(db,tenantId);
}

function listLeakageCases(db, tenantId) {
  return db.prepare(`SELECT * FROM savings_leakage_cases
    WHERE tenant_id=? ORDER BY
      CASE priority WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
      CASE status WHEN 'identified' THEN 0 WHEN 'reviewing' THEN 1 WHEN 'actioned' THEN 2 ELSE 3 END,
      last_seen_at DESC,id DESC`).all(tenantId);
}

function getLeakageCase(db, tenantId, caseId) {
  const row=db.prepare('SELECT * FROM savings_leakage_cases WHERE tenant_id=? AND id=?').get(tenantId,caseId);
  if(!row) throw new Error('Leakage case not found');
  return row;
}

function updateLeakageCase(db, tenantId, caseId, input={}) {
  const row=getLeakageCase(db,tenantId,caseId);
  const status=String(input.status||row.status).trim();
  if(!['identified','reviewing','actioned','dismissed'].includes(status)) throw new Error('Unsupported leakage case status');
  const ownerId=input.ownerId===undefined?row.owner_id:(input.ownerId||null);
  const dueAt=input.dueAt===undefined?row.due_at:(input.dueAt||null);
  const correctiveAction=input.correctiveAction===undefined?row.corrective_action:String(input.correctiveAction||'').trim()||null;
  const correctiveNote=input.correctiveNote===undefined?row.corrective_note:String(input.correctiveNote||'').trim()||null;
  let effective=row.action_effective_at;
  if(status==='actioned') {
    if(!correctiveAction) throw new Error('Corrective action is required before marking leakage actioned');
    if(!correctiveNote) throw new Error('Corrective action note is required');
    effective=input.actionEffectiveAt||row.action_effective_at||new Date().toISOString();
  }
  if(status==='dismissed'&&!String(input.correctiveNote||correctiveNote||'').trim()) throw new Error('Dismissal note is required');
  db.prepare(`UPDATE savings_leakage_cases SET status=?,owner_id=?,due_at=?,corrective_action=?,corrective_note=?,action_effective_at=? WHERE id=?`).run(
    status,ownerId,dueAt,correctiveAction,correctiveNote,effective,caseId
  );
  appendCaseEvent(db,caseId,status,input.actorId||null,correctiveNote||null,{ownerId,dueAt,correctiveAction,actionEffectiveAt:effective});
  return getLeakageCase(db,tenantId,caseId);
}

function postActionReceipts(db, tenantId, sku, after) {
  return db.prepare(`SELECT event_id,supplier_id,occurred_at,SUM(quantity) quantity,SUM(amount) amount
    FROM spend_facts
    WHERE tenant_id=? AND state='actual' AND sku=? AND occurred_at>?
    GROUP BY event_id,supplier_id,occurred_at
    ORDER BY occurred_at,event_id`).all(tenantId,sku,after);
}

function verifyLeakageClosure(db, tenantId, caseId, actorId) {
  const row=getLeakageCase(db,tenantId,caseId);
  if(row.status!=='actioned') throw new Error('Leakage case must be actioned before closure verification');
  if(!row.action_effective_at) throw new Error('Leakage corrective action has no effective date');
  let detection={};try{detection=JSON.parse(row.detection_evidence_json||'{}');}catch{}
  const receipts=postActionReceipts(db,tenantId,row.sku,row.action_effective_at);
  if(!receipts.length) {
    const evidence={status:'insufficient_evidence',reason:'No actual receipt evidence exists after the corrective action.',receiptEventIds:[]};
    appendCaseEvent(db,caseId,'closure_check_insufficient',actorId,null,evidence);
    return evidence;
  }

  let resolved=false,evidence={};
  if(row.leakage_kind==='supplier_switch_not_sticking') {
    const oldSupplier=String(detection.oldSupplierId||'');
    const violating=receipts.filter(x=>String(x.supplier_id||'')===oldSupplier);
    resolved=violating.length===0;
    evidence={
      status:resolved?'verified_resolved':'leakage_persists',
      oldSupplierId:oldSupplier,
      receiptEventIds:receipts.map(x=>x.event_id),
      violatingReceiptEventIds:violating.map(x=>x.event_id),
      reason:resolved?'Post-remediation actual receipts no longer came from the prior supplier.':'Post-remediation actual receipts still include the prior supplier.'
    };
  } else if(row.leakage_kind==='verified_savings_leakage_returned') {
    const reference=Number(detection.referenceUnitAmount||0);
    const qty=receipts.reduce((s,x)=>s+Number(x.quantity||0),0);
    const amount=receipts.reduce((s,x)=>s+Number(x.amount||0),0);
    const unit=qty>0?amount/qty:0;
    resolved=qty>0&&reference>0&&unit<reference;
    evidence={
      status:resolved?'verified_resolved':'leakage_persists',
      referenceUnitAmount:reference,
      postRemediationWeightedUnitAmount:Number(unit.toFixed(4)),
      postRemediationQuantity:Number(qty.toFixed(4)),
      receiptEventIds:receipts.map(x=>x.event_id),
      reason:resolved?'Post-remediation actual receipt cost is below the pre-action reference.':'Post-remediation actual receipt cost remains at or above the pre-action reference.'
    };
  } else {
    throw new Error('Unsupported leakage kind for automated closure verification');
  }

  db.prepare(`UPDATE savings_leakage_cases SET closure_evidence_json=?,status=?,resolved_at=CASE WHEN ?='verified_resolved' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?`).run(
    JSON.stringify(evidence),evidence.status,evidence.status,caseId
  );
  appendCaseEvent(db,caseId,evidence.status,actorId,evidence.reason,evidence);
  return evidence;
}

function leakageCaseDetail(db, tenantId, caseId) {
  const row=getLeakageCase(db,tenantId,caseId);
  const events=db.prepare('SELECT * FROM savings_leakage_case_events WHERE case_id=? ORDER BY id').all(caseId);
  return {...row,events};
}

module.exports={refreshLeakageCases,listLeakageCases,updateLeakageCase,verifyLeakageClosure,leakageCaseDetail};
