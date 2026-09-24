const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { ingestEvent } = require('../src/ingest');
const { runSavingsEngine } = require('../src/engine');
const { upsertBudget } = require('../src/budgets');

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
