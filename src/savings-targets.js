function normalizeTarget(input={}) {
  const scopeType=String(input.scopeType||'company').trim();
  const scopeId=String(input.scopeId||'all').trim();
  const currency=String(input.currency||'').trim();
  const periodStart=String(input.periodStart||'').trim();
  const periodEnd=String(input.periodEnd||'').trim();
  const targetAmount=Number(input.targetAmount);
  if(!['company','supplier','category','department'].includes(scopeType)) throw new Error('Unsupported savings target scope');
  if(!scopeId) throw new Error('Scope id is required');
  if(!currency) throw new Error('Currency is required');
  if(!periodStart||!periodEnd||new Date(periodEnd)<new Date(periodStart)) throw new Error('Valid savings target period is required');
  if(!Number.isFinite(targetAmount)||targetAmount<0) throw new Error('Savings target must be a non-negative number');
  return {scopeType,scopeId,currency,periodStart,periodEnd,targetAmount,ownerId:input.ownerId||null,note:String(input.note||'').trim()||null};
}

function upsertSavingsTarget(db, tenantId, input) {
  const t=normalizeTarget(input);
  db.prepare(`INSERT INTO savings_targets(
    tenant_id,scope_type,scope_id,currency,period_start,period_end,target_amount,owner_id,note
  ) VALUES(?,?,?,?,?,?,?,?,?)
  ON CONFLICT(tenant_id,scope_type,scope_id,currency,period_start,period_end) DO UPDATE SET
    target_amount=excluded.target_amount,owner_id=excluded.owner_id,note=excluded.note,updated_at=CURRENT_TIMESTAMP`).run(
      tenantId,t.scopeType,t.scopeId,t.currency,t.periodStart,t.periodEnd,t.targetAmount,t.ownerId,t.note
    );
  return db.prepare(`SELECT * FROM savings_targets WHERE tenant_id=? AND scope_type=? AND scope_id=? AND currency=? AND period_start=? AND period_end=?`).get(
    tenantId,t.scopeType,t.scopeId,t.currency,t.periodStart,t.periodEnd
  );
}

function listSavingsTargets(db, tenantId) {
  return db.prepare(`SELECT * FROM savings_targets WHERE tenant_id=? ORDER BY period_start DESC,scope_type,scope_id,currency`).all(tenantId);
}

module.exports={upsertSavingsTarget,listSavingsTargets};

function verifiedForTarget(db, tenantId, target) {
  const rows=db.prepare(`SELECT c.claimed_savings,o.kind,o.currency,
    sf.supplier_id,
    CASE WHEN COUNT(DISTINCT COALESCE(sf.department_id,''))=1 THEN MAX(sf.department_id) ELSE NULL END department_id,
    MAX(sf.occurred_at) occurred_at
    FROM savings_verification_evidence_claims c
    JOIN savings_opportunities o ON o.id=c.opportunity_id
    JOIN spend_facts sf ON sf.tenant_id=c.tenant_id AND sf.event_id=c.event_id AND COALESCE(sf.sku,'')=COALESCE(c.sku,'')
    WHERE c.tenant_id=? AND o.currency=? AND sf.occurred_at>=? AND sf.occurred_at<=?
    GROUP BY c.id,o.kind,o.currency,sf.supplier_id`).all(
      tenantId,target.currency,target.period_start,target.period_end
    );
  return rows.reduce((sum,row)=>{
    if(target.scope_type==='company') return sum+Number(row.claimed_savings||0);
    if(target.scope_type==='supplier'&&String(row.supplier_id||'')===String(target.scope_id)) return sum+Number(row.claimed_savings||0);
    if(target.scope_type==='category'&&String(row.kind||'')===String(target.scope_id)) return sum+Number(row.claimed_savings||0);
    if(target.scope_type==='department'&&String(row.department_id||'')===String(target.scope_id)) return sum+Number(row.claimed_savings||0);
    return sum;
  },0);
}

function savingsTargetPerformance(db, tenantId) {
  return listSavingsTargets(db,tenantId).map(target=>{
    const verified=Number(verifiedForTarget(db,tenantId,target).toFixed(2));
    const goal=Number(target.target_amount||0);
    const attainmentPct=goal>0?Number((100*verified/goal).toFixed(2)):(verified>0?null:100);
    const gap=Math.max(0,Number((goal-verified).toFixed(2)));
    const status=goal===0?(verified>0?'exceeded':'met'):verified>=goal?'met':verified>0?'in_progress':'not_started';
    return {...target,verified_savings:verified,gap,attainment_pct:attainmentPct,performance_status:status};
  });
}

module.exports.savingsTargetPerformance=savingsTargetPerformance;
