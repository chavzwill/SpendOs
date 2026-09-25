const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { ingestEvent } = require('../src/ingest');
const { runSavingsEngine } = require('../src/engine');
const { upsertBudget } = require('../src/budgets');
const { recordAction, verifyOpportunity, opportunityLifecycle } = require('../src/savings-lifecycle');

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

function receipt({id,sourceRecordId=id,supplierId='S2',sku='SKU1',qty=1,unitCost=90,occurredAt}) {
  return {
    id,type:'purchase.received',occurredAt,
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
