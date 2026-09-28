const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const { ingestEvent } = require('../src/ingest');
const { managementSnapshot, supplierPriceHistory } = require('../src/analytics');
const { targetCostSummary, targetPortfolio, allocationCoverage, targetTrend } = require('../src/cost-economics');

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'schema.sql'), 'utf8'));
  return db;
}

function event(version = 1, id = `evt-${version}`) {
  return {
    id,
    type: 'purchase.requested',
    occurredAt: '2026-09-24T18:00:00.000Z',
    tenantId: 'total-tools',
    source: 'total-tools-pos',
    sourceRecordId: '42',
    sourceVersion: version,
    actorId: '7',
    locationId: '2',
    departmentId: 'Operations',
    payload: {
      supplierId: '5',
      currency: 'JMD',
      items: [{ sku: 'ABC', description: 'Drill', quantity: 4, unitCost: 12000, lineTotal: 48000 }]
    }
  };
}

test('accepts first event and normalizes spend fact', () => {
  const db = freshDb();
  assert.equal(ingestEvent(db, event()).status, 'accepted');
  const snapshot = managementSnapshot(db, 'total-tools');
  assert.equal(snapshot.requested, 48000);
  assert.equal(snapshot.suppliers[0].supplier_id, '5');
});

test('duplicate replay is idempotent', () => {
  const db = freshDb();
  assert.equal(ingestEvent(db, event()).status, 'accepted');
  assert.equal(ingestEvent(db, event()).status, 'duplicate');
  const count = db.prepare('SELECT COUNT(*) c FROM spend_facts').get().c;
  assert.equal(count, 1);
});

test('older source version is rejected as stale', () => {
  const db = freshDb();
  assert.equal(ingestEvent(db, event(2, 'evt-2')).status, 'accepted');
  const result = ingestEvent(db, event(1, 'evt-1'));
  assert.equal(result.status, 'stale');
  assert.equal(result.latestVersion, 2);
});

test('different event id at same source version is a conflict', () => {
  const db = freshDb();
  assert.equal(ingestEvent(db, event(1, 'evt-a')).status, 'accepted');
  assert.equal(ingestEvent(db, event(1, 'evt-b')).status, 'conflict');
});

test('newer revision updates current supplier pricing without double-counting history', () => {
  const db = freshDb();
  ingestEvent(db, event(1, 'evt-1'));
  const v2 = event(2, 'evt-2');
  v2.payload.items[0].unitCost = 13000;
  v2.payload.items[0].lineTotal = 52000;
  assert.equal(ingestEvent(db, v2).status, 'accepted');
  const history = supplierPriceHistory(db, 'total-tools', 'ABC');
  assert.equal(history.length, 1);
  assert.equal(history[0].unit_amount, 13000);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM spend_events').get().c, 2);
});

test('latest source version replaces prior requested-spend projection', () => {
  const db = freshDb();
  const v1 = event(1, 'rev-1');
  v1.payload.items[0].lineTotal = 100;
  v1.payload.items[0].unitCost = 25;
  v1.payload.items[0].quantity = 4;
  const v2 = event(2, 'rev-2');
  v2.payload.items[0].lineTotal = 150;
  v2.payload.items[0].unitCost = 30;
  v2.payload.items[0].quantity = 5;
  ingestEvent(db, v1);
  ingestEvent(db, v2);
  const snapshot = managementSnapshot(db, 'total-tools');
  assert.equal(snapshot.requested, 150);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM spend_events').get().c, 2);
});

test('allocated purchase intent and actual consumption stay distinct by target', () => {
  const db = freshDb();
  const request = event(1, 'alloc-pr');
  request.sourceRecordId = '501';
  request.payload.items[0].allocations = [{
    targetType:'rental_asset',targetId:'77',targetLabel:'RA-77',
    amount:48000,quantity:4,percent:100,purpose:'maintenance',
    expenseCategory:'parts',valuationStatus:'declared'
  }];
  ingestEvent(db, request);

  const actual = {
    id:'alloc-consume',type:'consumable.issued',
    occurredAt:'2026-09-24T19:00:00.000Z',tenantId:'total-tools',
    source:'total-tools-pos',sourceRecordId:'900',sourceVersion:1,
    locationId:'2',departmentId:null,
    payload:{currency:'JMD',items:[{
      sku:'ABC',productName:'Bearing',quantity:2,trackedValue:18000,
      valuationStatus:'fully_valued',
      allocations:[{
        targetType:'rental_asset',targetId:'77',targetLabel:'RA-77',
        amount:18000,quantity:2,percent:100,purpose:'repair',
        expenseCategory:'parts',valuationStatus:'fully_valued'
      }]
    }]}
  };
  ingestEvent(db, actual);

  const summary = targetCostSummary(db,'total-tools','rental_asset','77');
  assert.equal(summary.requestedCost,48000);
  assert.equal(summary.actualCost,18000);
  assert.equal(summary.incompleteActualLines,0);
  assert.equal(summary.categories.length,2);
});

test('purchase receipt becomes actual target cost without replacing request intent', () => {
  const db = freshDb();
  const request = event(1, 'pr-intent');
  request.sourceRecordId='601';
  request.payload.items[0].allocations=[{targetType:'rental_asset',targetId:'88',amount:1000,quantity:10,percent:100,expenseCategory:'parts',valuationStatus:'declared'}];
  request.payload.items[0].lineTotal=1000;
  request.payload.items[0].unitCost=100;
  request.payload.items[0].quantity=10;
  ingestEvent(db,request);

  ingestEvent(db,{
    id:'receipt-1',type:'purchase.received',occurredAt:'2026-09-25T01:00:00.000Z',
    tenantId:'total-tools',source:'total-tools-pos',sourceRecordId:'701',sourceVersion:1,
    locationId:'2',payload:{supplierId:'5',currency:'JMD',items:[{
      sku:'ABC',description:'Bearing',quantity:4,unitCost:100,lineCost:400,
      allocations:[{targetType:'rental_asset',targetId:'88',amount:400,quantity:4,percent:100,expenseCategory:'parts',valuationStatus:'actual'}]
    }]}
  });
  const summary=targetCostSummary(db,'total-tools','rental_asset','88');
  assert.equal(summary.requestedCost,1000);
  assert.equal(summary.actualCost,400);
  assert.equal(summary.incompleteActualLines,0);
  assert.equal(allocationCoverage(db,'total-tools').incompleteActualLines,0);
});

test('company expenditure and internal consumption are not double-counted', () => {
  const db=freshDb();
  ingestEvent(db,{
    id:'recv-global',type:'purchase.received',occurredAt:'2026-09-25T01:00:00.000Z',
    tenantId:'total-tools',source:'total-tools-pos',sourceRecordId:'801',sourceVersion:1,
    payload:{supplierId:'5',currency:'JMD',items:[{sku:'OIL',description:'Oil',quantity:10,unitCost:100,lineCost:1000,allocations:[]}]}
  });
  ingestEvent(db,{
    id:'consume-global',type:'consumable.issued',occurredAt:'2026-09-25T02:00:00.000Z',
    tenantId:'total-tools',source:'total-tools-pos',sourceRecordId:'802',sourceVersion:1,
    payload:{currency:'JMD',items:[{sku:'OIL',productName:'Oil',quantity:4,trackedValue:400,valuationStatus:'fully_valued',
      allocations:[{targetType:'vehicle',targetId:'3',targetLabel:'Truck 3',amount:400,quantity:4,percent:100,expenseCategory:'lubricants',valuationStatus:'fully_valued'}]}]}
  });
  const snapshot=managementSnapshot(db,'total-tools');
  assert.equal(snapshot.actual,1000);
  assert.equal(snapshot.consumed,400);
});

test('target portfolio ranks actual cost without losing requested context', () => {
  const db=freshDb();
  const req=event(1,'portfolio-pr');
  req.sourceRecordId='901';
  req.payload.items[0].allocations=[{targetType:'vehicle',targetId:'3',targetLabel:'Truck 3',amount:600,quantity:6,percent:100,expenseCategory:'parts',valuationStatus:'declared'}];
  req.payload.items[0].lineTotal=600; req.payload.items[0].quantity=6; req.payload.items[0].unitCost=100;
  ingestEvent(db,req);
  ingestEvent(db,{
    id:'portfolio-consume',type:'consumable.issued',occurredAt:'2026-09-25T03:00:00.000Z',
    tenantId:'total-tools',source:'total-tools-pos',sourceRecordId:'902',sourceVersion:1,
    payload:{currency:'JMD',items:[{sku:'ABC',productName:'Part',quantity:2,trackedValue:250,valuationStatus:'fully_valued',
      allocations:[{targetType:'vehicle',targetId:'3',targetLabel:'Truck 3',amount:250,quantity:2,percent:100,expenseCategory:'parts',valuationStatus:'fully_valued'}]}]}
  });
  const portfolio=targetPortfolio(db,'total-tools','vehicle');
  assert.equal(portfolio.length,1);
  assert.equal(portfolio[0].requestedCost,600);
  assert.equal(portfolio[0].actualCost,250);
  const coverage=allocationCoverage(db,'total-tools');
  assert.equal(coverage.totalLines,2);
  assert.equal(coverage.incompleteActualLines,0);
});

test('cost-object trend compares recent actual allocations without inventing revenue', () => {
  const db=freshDb();
  for (const x of [
    {id:'old-v',rec:'v1',date:'2026-08-15T10:00:00.000Z',amount:100},
    {id:'new-v',rec:'v2',date:'2026-09-15T10:00:00.000Z',amount:150}
  ]) {
    ingestEvent(db,{
      id:x.id,type:'purchase.received',occurredAt:x.date,tenantId:'total-tools',
      source:'total-tools-pos',sourceRecordId:x.rec,sourceVersion:1,
      payload:{currency:'JMD',items:[{sku:'FUEL',description:'Fuel',quantity:1,unitCost:x.amount,lineCost:x.amount,
        allocations:[{targetType:'vehicle',targetId:'3',targetLabel:'Truck 3',amount:x.amount,quantity:1,percent:100,expenseCategory:'fuel',valuationStatus:'actual'}]}]}
    });
  }
  const rows=targetTrend(db,'total-tools','vehicle','2026-09-25T12:00:00.000Z');
  assert.equal(rows.length,1);
  assert.equal(rows[0].trailing30dCost,150);
  assert.equal(rows[0].prior30dCost,100);
  assert.equal(rows[0].costChangePct,50);
  assert.equal(rows[0].costState,'cost_rising');
});
