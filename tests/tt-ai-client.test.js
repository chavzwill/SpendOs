const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {requestSpendAdvisory}=require('../src/tt-ai-client');

const pair=crypto.generateKeyPairSync('ed25519');
const publicKey=pair.publicKey;
const backup={
  SPENDOS_TT_AI_URL:process.env.SPENDOS_TT_AI_URL,
  SPENDOS_TT_AI_SIGNING_PRIVATE_KEY:process.env.SPENDOS_TT_AI_SIGNING_PRIVATE_KEY,
  SPENDOS_TENANT_ID:process.env.SPENDOS_TENANT_ID,
  NODE_ENV:process.env.NODE_ENV,
};
const key=pair.privateKey.export({format:'pem',type:'pkcs8'});
function setup(){
  process.env.SPENDOS_TT_AI_URL='https://tt-ai.example.test';
  process.env.SPENDOS_TT_AI_SIGNING_PRIVATE_KEY=key;
  process.env.SPENDOS_TENANT_ID='total-tools';
  process.env.NODE_ENV='production';
}
function restore(){
 for(const [field,v] of Object.entries(backup)){
   if(v===undefined)delete process.env[field];else process.env[field]=v;
 }
}
const target={type:'rental_asset',id:'R1',currency:'JMD',currentPeriodCost:12500,previousPeriodCost:10000};
test('SpendOS signs tenant-scoped advisory requests using server Ed25519',async()=>{
  setup();
  try {
    let called=0;
    const result=await requestSpendAdvisory({
      tenantId:'total-tools',target,
      fetchImpl:async(uri,init)=>{
        called++;
        assert.equal(uri,'https://tt-ai.example.test/v1/service/advice');
        assert.equal(init.method,'POST');
        assert.equal(init.redirect,'error');
        assert.ok(init.authorization===undefined);
        const [version,encoded,signature]=init.headers.authorization.slice(7).split('.');
        assert.equal(version,'v3');
        assert.equal(crypto.verify(null,Buffer.from(version+'.'+encoded),publicKey,Buffer.from(signature,'base64url')),true);
        const claims=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));
        assert.equal(claims.iss,'total-tools-spendos');
        assert.equal(claims.scope,'internal_spend_advice');
        assert.equal(claims.tenant_id,'total-tools');
        assert.equal(claims.body_sha256,crypto.createHash('sha256').update(init.body).digest('hex'));
        assert.deepEqual(JSON.parse(init.body),{kind:'spend_insights',target});
        return {ok:true,json:async()=>({
          kind:'spend_insights',tenant_id:'total-tools',provider:'total-tools-spendos',
          advisoryOnly:true,request_id:claims.request_id,
          metrics:{changePercent:25},
        })};
      }
    });
    assert.equal(called,1);
    assert.equal(result.metrics.changePercent,25);
  } finally {restore();}
});
test('cross-tenant requests are rejected before any network call',async()=>{
  setup();try{
    await assert.rejects(requestSpendAdvisory({tenantId:'another-tenant',target,
      fetchImpl:()=>{throw Error('network must not run')}}),/SPENDOS_TT_AI_TENANT_DENIED/);
  }finally{restore();}
});
test('missing signing configuration and non-HTTPS production endpoints fail closed',async()=>{
  setup();
  try {
    delete process.env.SPENDOS_TT_AI_SIGNING_PRIVATE_KEY;
    await assert.rejects(requestSpendAdvisory({tenantId:'total-tools',target}),/SPENDOS_TT_AI_NOT_CONFIGURED/);
    process.env.SPENDOS_TT_AI_SIGNING_PRIVATE_KEY=key;
    process.env.SPENDOS_TT_AI_URL='http://tt-ai.example.test';
    await assert.rejects(requestSpendAdvisory({tenantId:'total-tools',target}),/SPENDOS_TT_AI_HTTPS_REQUIRED/);
  } finally {restore();}
});
test('mismatched provider or tenant reply cannot be trusted',async()=>{
  setup();
  try {
    await assert.rejects(requestSpendAdvisory({
      tenantId:'total-tools',target,
      fetchImpl:async()=>({ok:true,json:async()=>({
        kind:'spend_insights',tenant_id:'another-tenant',provider:'total-tools-smartcommerce',
        advisoryOnly:true,request_id:'fake',
      })}),
    }),/SPENDOS_TT_AI_UPSTREAM_INVALID/);
  } finally {restore();}
});
