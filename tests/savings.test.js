const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { ingestEvent } = require('../src/ingest');
const { runSavingsEngine } = require('../src/engine');
const { upsertBudget } = require('../src/budgets');
const { recordAction, verifyOpportunity, opportunityLifecycle, verifiedSavingsRollup } = require('../src/savings-lifecycle');
const { upsertSavingsTarget, savingsTargetPerformance, savingsAccountabilityAttention } = require('../src/savings-targets');
const { savingsLeakageAnalysis } = require('../src/savings-leakage');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  return db;
}

function purchase({id, version=1, sourceRecordId=id, supplierId='S1', sku='SKU1', qty=1, unitCost=100, departmentId='Ops', locationId='L1', occurredAt}) {
  return {
    id,
    type:'purchase.requested',
    occurredAt: occurredAt || '2026-09-24T10:00:00.000Z',
    tenantId:'total-tools',
    source:'total-tools-pos',
    sourceRecordId:String(sourceRecordId),
    sourceVersion:version,
    locationId,
    departmentId,
    payload:{
      supplierId,
      currency:'JMD',
      items:[{sku,description:'Item',quantity:qty,unitCost,lineTotal:qty*unitCost}]
    }
  };
}

test('price drift creates a deduplicated opportunity', () => {
  const db=freshDb();
  ingestEvent(db,purchase({id:'e1',sourceRecordId:'1',unitCost:100,occurredAt:'2026-09-20T10:00:00.000Z'}));
  ingestEvent(db,purchase({id:'e2',sourceRecordId:'2',unitCost:125,occurredAt:'2026-09-24T10:00:00.000Z'}));
  const first=runSavingsEngine(db,'total-tools',{priceDrift:{minPct:5}});
  assert.equal(first.detected >= 1,true);
  const row=db.prepare("SELECT * FROM savings_opportunities WHERE kind='supplier_price_drift'").get();
  assert.equal(row.estimated_savings,25);
  runSavingsEngine(db,'total-tools',{priceDrift:{minPct:5}});
  const count=db.prepare("SELECT COUNT(*) c FROM savings_opportunities WHERE kind='supplier_price_drift'").get().c;
  assert.equal(count,1);
});

test('supplier alternative identifies cheaper supplier', () => {
  const db=freshDb();
  ingestEvent(db,purchase({id:'a',sourceRecordId:'10',supplierId:'S1',unitCost:140,occurredAt:'2026-09-23T10:00:00.000Z'}));
  ingestEvent(db,purchase({id:'b',sourceRecordId:'11',supplierId:'S2',unitCost:100,occurredAt:'2026-09-24T10:00:00.000Z'}));
  const result=runSavingsEngine(db,'total-tools',{supplierAlternatives:{minPct:3}});
  const alt=result.opportunities.find(x=>x.kind==='supplier_alternative');
  assert.ok(alt);
  assert.equal(alt.estimated_savings,40);
});

test('budget assessment reports exceeded department budget', () => {
  const db=freshDb();
  upsertBudget(db,{
    tenantId:'total-tools',scopeType:'department',scopeId:'Ops',currency:'JMD',
    periodStart:'2026-09-01T00:00:00.000Z',periodEnd:'2026-09-30T23:59:59.999Z',amount:500
  });
  ingestEvent(db,purchase({id:'b1',sourceRecordId:'20',qty:6,unitCost:100,departmentId:'Ops',occurredAt:'2026-09-24T10:00:00.000Z'}));
  const result=runSavingsEngine(db,'total-tools',{asOf:'2026-09-24T12:00:00.000Z'});
  assert.equal(result.budgets[0].status,'exceeded');
  assert.equal(result.budgets[0].spent,600);
});

test('consumable variance flags abnormal quantity', () => {
  const db=freshDb();
  ingestEvent(db,purchase({id:'c1',sourceRecordId:'31',qty:10,occurredAt:'2026-09-10T10:00:00.000Z'}));
  ingestEvent(db,purchase({id:'c2',sourceRecordId:'32',qty:12,occurredAt:'2026-09-17T10:00:00.000Z'}));
  ingestEvent(db,purchase({id:'c3',sourceRecordId:'33',qty:30,occurredAt:'2026-09-24T10:00:00.000Z'}));
  const result=runSavingsEngine(db,'total-tools',{consumables:{tolerancePct:20}});
  assert.ok(result.opportunities.some(x=>x.kind==='consumable_variance'));
});

function receipt({id,sourceRecordId=id,supplierId='S2',sku='SKU1',qty=1,unitCost=90,departmentId='Ops',occurredAt}) {
  return {
    id,type:'purchase.received',occurredAt,departmentId,
    tenantId:'total-tools',source:'total-tools-pos',
    sourceRecordId:String(sourceRecordId),sourceVersion:1,
    payload:{supplierId,currency:'JMD',items:[{
      sku,description:'Item',quantity:qty,unitCost,lineCost:qty*unitCost,allocations:[]
    }]}
  };
}

test('verified savings require an action and later actual receipt evidence', () => {
  const db=freshDb();
  ingestEvent(db,purchase({id:'sa',sourceRecordId:'sa',supplierId:'S1',unitCost:140,occurredAt:'2026-09-20T10:00:00.000Z'}));
  ingestEvent(db,purchase({id:'sb',sourceRecordId:'sb',supplierId:'S2',unitCost:100,occurredAt:'2026-09-21T10:00:00.000Z'}));
  const result=runSavingsEngine(db,'total-tools',{supplierAlternatives:{minPct:3}});
  const op=result.opportunities.find(x=>x.kind==='supplier_alternative');
  assert.throws(()=>verifyOpportunity(db,'total-tools',op.id),/recorded action/);
  recordAction(db,'total-tools',op.id,{actionType:'switch_supplier',actionNote:'Approved cheaper supplier',effectiveAt:'2026-09-22T00:00:00.000Z'});
  const pending=verifyOpportunity(db,'total-tools',op.id,{periodEnd:'2026-09-23T00:00:00.000Z'});
  assert.equal(pending.status,'insufficient_evidence');
});

test('supplier action verifies only realized post-action unit-cost savings', () => {
  const db=freshDb();
  ingestEvent(db,purchase({id:'va',sourceRecordId:'va',supplierId:'S1',unitCost:140,occurredAt:'2026-09-20T10:00:00.000Z'}));
  ingestEvent(db,purchase({id:'vb',sourceRecordId:'vb',supplierId:'S2',unitCost:100,occurredAt:'2026-09-21T10:00:00.000Z'}));
  const result=runSavingsEngine(db,'total-tools',{supplierAlternatives:{minPct:3}});
  const op=result.opportunities.find(x=>x.kind==='supplier_alternative');
  recordAction(db,'total-tools',op.id,{actionType:'switch_supplier',actionNote:'Use supplier S2',effectiveAt:'2026-09-22T00:00:00.000Z'});
  ingestEvent(db,receipt({id:'vr1',sourceRecordId:'vr1',supplierId:'S2',qty:5,unitCost:105,occurredAt:'2026-09-24T10:00:00.000Z'}));
  const verified=verifyOpportunity(db,'total-tools',op.id,{periodEnd:'2026-09-25T00:00:00.000Z'});
  assert.equal(verified.status,'verified');
  assert.equal(verified.verifiedSavings,175);
  const lifecycle=opportunityLifecycle(db,'total-tools',op.id);
  assert.equal(lifecycle.status,'verified');
  assert.equal(lifecycle.verified_savings,175);
  assert.equal(lifecycle.actions.length,1);
  assert.equal(lifecycle.verifications.length,1);
});

test('action is not called a saving when later actual cost does not improve', () => {
  const db=freshDb();
  ingestEvent(db,purchase({id:'na',sourceRecordId:'na',supplierId:'S1',unitCost:140,occurredAt:'2026-09-20T10:00:00.000Z'}));
  ingestEvent(db,purchase({id:'nb',sourceRecordId:'nb',supplierId:'S2',unitCost:100,occurredAt:'2026-09-21T10:00:00.000Z'}));
  const result=runSavingsEngine(db,'total-tools',{supplierAlternatives:{minPct:3}});
  const op=result.opportunities.find(x=>x.kind==='supplier_alternative');
  recordAction(db,'total-tools',op.id,{actionType:'renegotiate',actionNote:'Attempted renegotiation',effectiveAt:'2026-09-22T00:00:00.000Z'});
  ingestEvent(db,receipt({id:'nr1',sourceRecordId:'nr1',supplierId:'S1',qty:2,unitCost:145,occurredAt:'2026-09-24T10:00:00.000Z'}));
  const checked=verifyOpportunity(db,'total-tools',op.id);
  assert.equal(checked.status,'not_verified');
  assert.equal(checked.verifiedSavings,0);
  const lifecycle=opportunityLifecycle(db,'total-tools',op.id);
  assert.equal(lifecycle.status,'actioned');
  assert.equal(lifecycle.verified_savings,0);
});

test('the same receipt evidence cannot be counted twice', () => {
  const db=freshDb();
  ingestEvent(db,purchase({id:'da',sourceRecordId:'da',supplierId:'S1',unitCost:140,occurredAt:'2026-09-20T10:00:00.000Z'}));
  ingestEvent(db,purchase({id:'db',sourceRecordId:'db',supplierId:'S2',unitCost:100,occurredAt:'2026-09-21T10:00:00.000Z'}));
  const result=runSavingsEngine(db,'total-tools',{supplierAlternatives:{minPct:3}});
  const op=result.opportunities.find(x=>x.kind==='supplier_alternative');
  recordAction(db,'total-tools',op.id,{actionType:'switch_supplier',actionNote:'Use S2',effectiveAt:'2026-09-22T00:00:00.000Z'});
  ingestEvent(db,receipt({id:'dr1',sourceRecordId:'dr1',supplierId:'S2',qty:5,unitCost:105,occurredAt:'2026-09-24T10:00:00.000Z'}));
  assert.equal(verifyOpportunity(db,'total-tools',op.id,{periodEnd:'2026-09-25T00:00:00.000Z'}).verifiedSavings,175);
  const second=verifyOpportunity(db,'total-tools',op.id,{periodEnd:'2026-09-25T00:00:00.000Z'});
  assert.equal(second.status,'insufficient_evidence');
  assert.equal(opportunityLifecycle(db,'total-tools',op.id).verified_savings,175);
});



test('verified savings rollup reconciles unique claimed receipt evidence', () => {
  const db=freshDb();
  ingestEvent(db,purchase({id:'ra',sourceRecordId:'ra',supplierId:'S1',unitCost:140,departmentId:'Ops',occurredAt:'2026-09-20T10:00:00.000Z'}));
  ingestEvent(db,purchase({id:'rb',sourceRecordId:'rb',supplierId:'S2',unitCost:100,departmentId:'Ops',occurredAt:'2026-09-21T10:00:00.000Z'}));
  const result=runSavingsEngine(db,'total-tools',{supplierAlternatives:{minPct:3}});
  const op=result.opportunities.find(x=>x.kind==='supplier_alternative');
  recordAction(db,'total-tools',op.id,{actionType:'switch_supplier',actionNote:'Use S2',effectiveAt:'2026-09-22T00:00:00.000Z'});
  ingestEvent(db,receipt({id:'rr1',sourceRecordId:'rr1',supplierId:'S2',qty:5,unitCost:105,occurredAt:'2026-09-24T10:00:00.000Z'}));
  verifyOpportunity(db,'total-tools',op.id,{periodEnd:'2026-09-25T00:00:00.000Z'});
  const rollup=verifiedSavingsRollup(db,'total-tools');
  assert.equal(rollup.claimedEvidenceCount,1);
  assert.equal(rollup.totalsByCurrency[0].verifiedSavings,175);
  assert.equal(rollup.bySupplier[0].dimension,'S2');
  assert.equal(rollup.bySupplier[0].verifiedSavings,175);
  assert.equal(rollup.byCategory[0].dimension,'supplier_alternative');
  assert.equal(rollup.byPeriod[0].dimension,'2026-09');
});

test('new receipt evidence adds only incremental verified savings', () => {
  const db=freshDb();
  ingestEvent(db,purchase({id:'ia',sourceRecordId:'ia',supplierId:'S1',unitCost:140,occurredAt:'2026-09-20T10:00:00.000Z'}));
  ingestEvent(db,purchase({id:'ib',sourceRecordId:'ib',supplierId:'S2',unitCost:100,occurredAt:'2026-09-21T10:00:00.000Z'}));
  const result=runSavingsEngine(db,'total-tools',{supplierAlternatives:{minPct:3}});
  const op=result.opportunities.find(x=>x.kind==='supplier_alternative');
  recordAction(db,'total-tools',op.id,{actionType:'switch_supplier',actionNote:'Use S2',effectiveAt:'2026-09-22T00:00:00.000Z'});
  ingestEvent(db,receipt({id:'ir1',sourceRecordId:'ir1',supplierId:'S2',qty:5,unitCost:105,occurredAt:'2026-09-24T10:00:00.000Z'}));
  verifyOpportunity(db,'total-tools',op.id,{periodEnd:'2026-09-25T00:00:00.000Z'});
  ingestEvent(db,receipt({id:'ir2',sourceRecordId:'ir2',supplierId:'S2',qty:2,unitCost:100,occurredAt:'2026-09-26T10:00:00.000Z'}));
  const second=verifyOpportunity(db,'total-tools',op.id,{periodEnd:'2026-09-27T00:00:00.000Z'});
  assert.equal(second.verifiedSavings,80);
  assert.equal(opportunityLifecycle(db,'total-tools',op.id).verified_savings,255);
});

test('savings targets count only verified evidence inside the target period', () => {
  const db=freshDb();
  ingestEvent(db,purchase({id:'ta',sourceRecordId:'ta',supplierId:'S1',unitCost:140,occurredAt:'2026-09-20T10:00:00.000Z'}));
  ingestEvent(db,purchase({id:'tb',sourceRecordId:'tb',supplierId:'S2',unitCost:100,occurredAt:'2026-09-21T10:00:00.000Z'}));
  const result=runSavingsEngine(db,'total-tools',{supplierAlternatives:{minPct:3}});
  const op=result.opportunities.find(x=>x.kind==='supplier_alternative');
  recordAction(db,'total-tools',op.id,{actionType:'switch_supplier',actionNote:'Use S2',effectiveAt:'2026-09-22T00:00:00.000Z'});
  ingestEvent(db,receipt({id:'tr1',sourceRecordId:'tr1',supplierId:'S2',departmentId:'Ops',qty:5,unitCost:105,occurredAt:'2026-09-24T10:00:00.000Z'}));
  verifyOpportunity(db,'total-tools',op.id,{periodEnd:'2026-09-25T00:00:00.000Z'});

  upsertSavingsTarget(db,'total-tools',{scopeType:'company',scopeId:'all',currency:'JMD',periodStart:'2026-09-22T00:00:00.000Z',periodEnd:'2026-09-25T23:59:59.999Z',targetAmount:200,ownerId:'7'});
  upsertSavingsTarget(db,'total-tools',{scopeType:'supplier',scopeId:'S2',currency:'JMD',periodStart:'2026-09-22T00:00:00.000Z',periodEnd:'2026-09-25T23:59:59.999Z',targetAmount:175});
  upsertSavingsTarget(db,'total-tools',{scopeType:'department',scopeId:'Ops',currency:'JMD',periodStart:'2026-09-22T00:00:00.000Z',periodEnd:'2026-09-23T23:59:59.999Z',targetAmount:50});

  const performance=savingsTargetPerformance(db,'total-tools');
  const company=performance.find(x=>x.scope_type==='company');
  const supplier=performance.find(x=>x.scope_type==='supplier');
  const department=performance.find(x=>x.scope_type==='department');

  assert.equal(company.verified_savings,175);
  assert.equal(company.gap,25);
  assert.equal(company.performance_status,'in_progress');
  assert.equal(supplier.verified_savings,175);
  assert.equal(supplier.performance_status,'met');
  assert.equal(department.verified_savings,0);
  assert.equal(department.performance_status,'not_started');
});

test('savings target validation rejects invalid periods and negative goals', () => {
  const db=freshDb();
  assert.throws(()=>upsertSavingsTarget(db,'total-tools',{scopeType:'company',scopeId:'all',currency:'JMD',periodStart:'2026-10-01',periodEnd:'2026-09-01',targetAmount:100}),/Valid savings target period/);
  assert.throws(()=>upsertSavingsTarget(db,'total-tools',{scopeType:'company',scopeId:'all',currency:'JMD',periodStart:'2026-09-01',periodEnd:'2026-09-30',targetAmount:-1}),/non-negative/);
});

test('savings accountability attention flags missing owner and behind elapsed pace without forecasting', () => {
  const db=freshDb();
  upsertSavingsTarget(db,'total-tools',{scopeType:'company',scopeId:'all',currency:'JMD',periodStart:'2026-09-01T00:00:00.000Z',periodEnd:'2026-09-30T23:59:59.999Z',targetAmount:300,ownerId:null});
  const attention=savingsAccountabilityAttention(db,'total-tools','2026-09-20T12:00:00.000Z');
  assert.equal(attention.methodology.forecast,false);
  assert.ok(attention.items.some(x=>x.kind==='target_owner_missing'));
  assert.ok(attention.items.some(x=>x.kind==='target_behind_elapsed_pace'));
});

test('savings accountability attention flags ended target and aged unverified action', () => {
  const db=freshDb();
  upsertSavingsTarget(db,'total-tools',{scopeType:'company',scopeId:'all',currency:'JMD',periodStart:'2026-08-01T00:00:00.000Z',periodEnd:'2026-08-31T23:59:59.999Z',targetAmount:500,ownerId:'9'});
  ingestEvent(db,purchase({id:'aa1',sourceRecordId:'aa1',supplierId:'S1',unitCost:140,occurredAt:'2026-09-01T10:00:00.000Z'}));
  ingestEvent(db,purchase({id:'aa2',sourceRecordId:'aa2',supplierId:'S2',unitCost:100,occurredAt:'2026-09-02T10:00:00.000Z'}));
  const result=runSavingsEngine(db,'total-tools',{supplierAlternatives:{minPct:3}});
  const op=result.opportunities.find(x=>x.kind==='supplier_alternative');
  recordAction(db,'total-tools',op.id,{actionType:'switch_supplier',actionNote:'Use S2',actorId:'9',effectiveAt:'2026-09-03T00:00:00.000Z'});
  const attention=savingsAccountabilityAttention(db,'total-tools','2026-09-25T12:00:00.000Z');
  assert.ok(attention.items.some(x=>x.kind==='target_period_ended_below_goal'));
  assert.ok(attention.items.some(x=>x.kind==='action_verification_due'&&x.opportunityId===op.id));
});

test('savings leakage proves when an approved supplier switch does not stick', () => {
  const db=freshDb();
  ingestEvent(db,purchase({id:'ls1',sourceRecordId:'ls1',supplierId:'S1',unitCost:140,occurredAt:'2026-09-01T10:00:00.000Z'}));
  ingestEvent(db,purchase({id:'ls2',sourceRecordId:'ls2',supplierId:'S2',unitCost:100,occurredAt:'2026-09-02T10:00:00.000Z'}));
  const result=runSavingsEngine(db,'total-tools',{supplierAlternatives:{minPct:3}});
  const op=result.opportunities.find(x=>x.kind==='supplier_alternative');
  recordAction(db,'total-tools',op.id,{actionType:'switch_supplier',actionNote:'Move purchases to S2',effectiveAt:'2026-09-03T00:00:00.000Z'});
  ingestEvent(db,receipt({id:'lsr1',sourceRecordId:'lsr1',supplierId:'S1',qty:3,unitCost:138,occurredAt:'2026-09-10T10:00:00.000Z'}));
  const leakage=savingsLeakageAnalysis(db,'total-tools');
  const item=leakage.items.find(x=>x.kind==='supplier_switch_not_sticking');
  assert.ok(item);
  assert.equal(item.oldSupplierId,'S1');
  assert.equal(item.quantity,3);
  assert.deepEqual(item.evidenceEventIds,['lsr1']);
  assert.equal(leakage.methodology.inferredCauses,false);
});

test('savings leakage proves when later actual cost returns to the old reference', () => {
  const db=freshDb();
  ingestEvent(db,purchase({id:'lr1',sourceRecordId:'lr1',supplierId:'S1',unitCost:140,occurredAt:'2026-09-01T10:00:00.000Z'}));
  ingestEvent(db,purchase({id:'lr2',sourceRecordId:'lr2',supplierId:'S2',unitCost:100,occurredAt:'2026-09-02T10:00:00.000Z'}));
  const result=runSavingsEngine(db,'total-tools',{supplierAlternatives:{minPct:3}});
  const op=result.opportunities.find(x=>x.kind==='supplier_alternative');
  recordAction(db,'total-tools',op.id,{actionType:'switch_supplier',actionNote:'Move purchases to S2',effectiveAt:'2026-09-03T00:00:00.000Z'});
  ingestEvent(db,receipt({id:'lrv1',sourceRecordId:'lrv1',supplierId:'S2',qty:5,unitCost:105,occurredAt:'2026-09-10T10:00:00.000Z'}));
  verifyOpportunity(db,'total-tools',op.id,{periodEnd:'2026-09-12T00:00:00.000Z'});
  ingestEvent(db,receipt({id:'lrv2',sourceRecordId:'lrv2',supplierId:'S2',qty:2,unitCost:145,occurredAt:'2026-09-20T10:00:00.000Z'}));
  const leakage=savingsLeakageAnalysis(db,'total-tools');
  const item=leakage.items.find(x=>x.kind==='verified_savings_leakage_returned');
  assert.ok(item);
  assert.equal(item.referenceUnitAmount,140);
  assert.equal(item.laterWeightedUnitAmount,145);
  assert.deepEqual(item.evidenceEventIds,['lrv2']);
});
