const test=require('node:test');
const assert=require('node:assert/strict');

process.env.SPENDOS_DB=':memory:';
delete process.env.SPENDOS_API_KEY;
delete process.env.NODE_ENV;
process.env.SPENDOS_TENANT_ID='total-tools';

const {server,db}=require('../src/server');

let base;
test.before(async()=>{
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',()=>{
      server.off('error',reject);
      base=`http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async()=>{
  await new Promise(resolve=>server.close(resolve));
  db.close();
});

test('operational status reports waiting when no POS evidence exists',async()=>{
  const response=await fetch(`${base}/v1/system/status?tenantId=total-tools`);
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.connectionState,'waiting_for_evidence');
  assert.equal(body.eventCount,0);
  assert.equal(body.lastEvent,null);
});

test('read-only dashboard endpoints do not invent savings or budgets',async()=>{
  const before={
    opportunities:db.prepare('SELECT COUNT(*) c FROM savings_opportunities').get().c,
    budgets:db.prepare('SELECT COUNT(*) c FROM budgets').get().c
  };

  const [opportunities,budgets]=await Promise.all([
    fetch(`${base}/v1/savings/opportunities?tenantId=total-tools`).then(r=>r.json()),
    fetch(`${base}/v1/budgets/status?tenantId=total-tools`).then(r=>r.json())
  ]);

  assert.deepEqual(opportunities,[]);
  assert.deepEqual(budgets,[]);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM savings_opportunities').get().c,before.opportunities);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM budgets').get().c,before.budgets);
});
