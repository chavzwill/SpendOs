const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('crypto');

process.env.NODE_ENV='production';
process.env.SPENDOS_DB=':memory:';
process.env.SPENDOS_TENANT_ID='total-tools';
process.env.SPENDOS_API_KEY=crypto.randomBytes(24).toString('hex');
process.env.SPENDOS_UI_USER='finance-admin';
process.env.SPENDOS_UI_PASSWORD=crypto.randomBytes(24).toString('base64url');
process.env.SPENDOS_SESSION_SECRET=crypto.randomBytes(48).toString('hex');

const apiKey=process.env.SPENDOS_API_KEY;
const uiPassword=process.env.SPENDOS_UI_PASSWORD;
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

test('production management session is separate from POS bearer authority',async()=>{
  const unauth=await fetch(`${base}/v1/system/status?tenantId=total-tools`);
  assert.equal(unauth.status,401);

  const badLogin=await fetch(`${base}/ui/login`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({username:'finance-admin',password:'wrong'})
  });
  assert.equal(badLogin.status,401);

  const login=await fetch(`${base}/ui/login`,{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({username:'finance-admin',password:uiPassword})
  });
  assert.equal(login.status,200);
  const setCookie=login.headers.get('set-cookie');
  assert.ok(setCookie);
  const cookie=setCookie.split(';')[0];

  const status=await fetch(`${base}/v1/system/status?tenantId=total-tools`,{headers:{cookie}});
  assert.equal(status.status,200);
  assert.equal((await status.json()).connectionState,'waiting_for_evidence');

  const sessionCannotIngest=await fetch(`${base}/v1/events`,{
    method:'POST',headers:{cookie,'content-type':'application/json'},body:'{}'
  });
  assert.equal(sessionCannotIngest.status,401);

  const bearerCanReachIngest=await fetch(`${base}/v1/events`,{
    method:'POST',headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:'{}'
  });
  assert.equal(bearerCanReachIngest.status,400);
  assert.match((await bearerCanReachIngest.json()).error,/Missing required field/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM spend_events').get().c,0);
});
