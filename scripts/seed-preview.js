const fs=require('fs');
const path=require('path');
const {openStore}=require('../src/store');
const {ingestEvent}=require('../src/ingest');
const {runSavingsEngine}=require('../src/engine');
const {recordAction,verifyOpportunity}=require('../src/savings-lifecycle');
const {upsertSavingsTarget}=require('../src/savings-targets');
const {refreshLeakageCases}=require('../src/savings-leakage-cases');
const {upsertBudget}=require('../src/budgets');

const tenantId='total-tools';
const dbPath=process.env.SPENDOS_DB||path.join(process.cwd(),'spendos-preview.db');
if(!/(preview|demo)/i.test(path.basename(dbPath))) throw new Error('Preview seeding is restricted to a preview/demo database filename.');
for(const file of [dbPath,`${dbPath}-wal`,`${dbPath}-shm`]) if(fs.existsSync(file)) fs.unlinkSync(file);
const db=openStore(dbPath);
let seq=0;

function event(type,date,{supplierId=null,departmentId=null,locationId='Main Branch',items=[]}={}){
  seq+=1;
  return {id:`preview-${seq}`,type,occurredAt:date,tenantId,source:'total-tools-pos-preview',
    sourceRecordId:String(seq),sourceVersion:1,actorId:'preview',locationId,departmentId,
    payload:{supplierId,currency:'JMD',items}};
}
function alloc(targetType,targetId,targetLabel,amount,quantity,expenseCategory,purpose='Operating cost',valuationStatus='actual'){
  return {targetType,targetId,targetLabel,amount,quantity,percent:100,purpose,expenseCategory,valuationStatus};
}
function requested(date,supplierId,departmentId,sku,description,quantity,unitCost,allocations=[]){
  return event('purchase.requested',date,{supplierId,departmentId,items:[{sku,description,quantity,unitCost,lineTotal:quantity*unitCost,allocations}]});
}
function received(date,supplierId,departmentId,sku,description,quantity,unitCost,allocations=[]){
  return event('purchase.received',date,{supplierId,departmentId,items:[{sku,description,quantity,unitCost,lineCost:quantity*unitCost,allocations}]});
}

const events=[
  requested('2026-08-02T10:00:00.000Z','Island Equipment Co','Service','HYD-OIL-20L','Hydraulic oil 20L',10,18500),
  requested('2026-09-05T10:00:00.000Z','Island Equipment Co','Service','HYD-OIL-20L','Hydraulic oil 20L',12,21500),
  requested('2026-09-06T10:00:00.000Z','Caribbean Industrial','Rental','GEN-FILTER-44','Generator service filter',15,9800),
  requested('2026-09-07T10:00:00.000Z','Kingston Tool Supply','Rental','GEN-FILTER-44','Generator service filter',15,7900),
  requested('2026-08-15T10:00:00.000Z','Kingston Tool Supply','Service','SHOP-RAG','Workshop cleaning rags',20,900),
  requested('2026-09-01T10:00:00.000Z','Kingston Tool Supply','Service','SHOP-RAG','Workshop cleaning rags',22,900),
  requested('2026-09-20T10:00:00.000Z','Kingston Tool Supply','Service','SHOP-RAG','Workshop cleaning rags',48,900),
  requested('2026-09-08T09:00:00.000Z','Caribbean Industrial','Fleet','BRAKE-KIT-12','Truck brake service kit',1,225000,
    [alloc('vehicle','TRK-12','Isuzu Delivery Truck 12',225000,1,'maintenance_parts','Brake service','declared')]),
  received('2026-09-09T14:00:00.000Z','Caribbean Industrial','Fleet','BRAKE-KIT-12','Truck brake service kit',1,185000,
    [alloc('vehicle','TRK-12','Isuzu Delivery Truck 12',185000,1,'maintenance_parts','Brake service')]),
  requested('2026-09-10T09:00:00.000Z','Island Equipment Co','Rental','BREAKER-SVC-H65','Breaker service package',1,365000,
    [alloc('rental_asset','H65-04','CAT H65 Breaker #04',365000,1,'maintenance_service','Major service','declared')]),
  received('2026-09-11T14:00:00.000Z','Island Equipment Co','Rental','BREAKER-SVC-H65','Breaker service package',1,320000,
    [alloc('rental_asset','H65-04','CAT H65 Breaker #04',320000,1,'maintenance_service','Major service')]),
  received('2026-09-12T11:00:00.000Z','BuildRight Supplies','Facilities','ROOF-SEAL','Roof sealing materials',1,440000,
    [alloc('building','MAIN-01','Main Branch',440000,1,'facility_maintenance','Roof repair')]),
  received('2026-09-13T11:00:00.000Z','Power Systems JA','Operations','GEN-SVC-01','Generator service & parts',1,285000,
    [alloc('equipment','GEN-01','Standby Generator 01',285000,1,'maintenance_service','Quarterly service')]),
  received('2026-09-16T11:00:00.000Z','Kingston Tool Supply','Service','SHOP-SUPPLIES','Workshop consumables',1,164000,
    [alloc('department','Service','Service Department',164000,1,'consumables','Workshop operations')]),
  received('2026-09-17T11:00:00.000Z','FuelPro Jamaica','Fleet','DIESEL-BULK','Fleet diesel',1,238000,
    [alloc('vehicle','TRK-07','Hino Delivery Truck 07',238000,1,'fuel','Fleet operations')])
];
for(const e of events) ingestEvent(db,e);

upsertBudget(db,{tenantId,scopeType:'department',scopeId:'Service',currency:'JMD',
  periodStart:'2026-09-01T00:00:00.000Z',periodEnd:'2026-09-30T23:59:59.999Z',amount:500000});
upsertBudget(db,{tenantId,scopeType:'location',scopeId:'Main Branch',currency:'JMD',
  periodStart:'2026-09-01T00:00:00.000Z',periodEnd:'2026-09-30T23:59:59.999Z',amount:2400000});

let scan=runSavingsEngine(db,tenantId,{asOf:'2026-09-28T12:00:00.000Z'});
const supplierAlt=scan.opportunities.find(x=>x.kind==='supplier_alternative'&&JSON.parse(x.details_json).sku==='GEN-FILTER-44');
if(supplierAlt){
  recordAction(db,tenantId,supplierAlt.id,{actionType:'switch_supplier',actionNote:'Move generator filters to lower-cost approved supplier',actorId:'Procurement Lead',effectiveAt:'2026-09-10T00:00:00.000Z'});
  ingestEvent(db,received('2026-09-15T10:00:00.000Z','Kingston Tool Supply','Rental','GEN-FILTER-44','Generator service filter',10,7600,
    [alloc('rental_asset','GEN-08','Rental Generator GEN-08',76000,10,'maintenance_parts','Scheduled service')]));
  ingestEvent(db,received('2026-09-18T10:00:00.000Z','Caribbean Industrial','Rental','GEN-FILTER-44','Generator service filter',2,9700,
    [alloc('rental_asset','GEN-11','Rental Generator GEN-11',19400,2,'maintenance_parts','Urgent service')]));
  verifyOpportunity(db,tenantId,supplierAlt.id,{periodEnd:'2026-09-25T23:59:59.999Z'});
}
upsertSavingsTarget(db,tenantId,{scopeType:'company',scopeId:'all',currency:'JMD',
  periodStart:'2026-09-01T00:00:00.000Z',periodEnd:'2026-09-30T23:59:59.999Z',
  targetAmount:120000,ownerId:'Finance Manager',note:'September verified savings target'});
runSavingsEngine(db,tenantId,{asOf:'2026-09-28T12:00:00.000Z'});
refreshLeakageCases(db,tenantId);
console.log(`Preview database seeded: ${dbPath}`);
db.close();
