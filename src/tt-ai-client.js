'use strict';
const crypto=require('crypto');

function issue(code,status=503) {
  const error=new Error(code);error.code=code;error.status=status;return error;
}
function config() {
  const raw=String(process.env.SPENDOS_TT_AI_URL||'').trim();
  const pem=String(process.env.SPENDOS_TT_AI_SIGNING_PRIVATE_KEY||'').replace(/\\n/g,'\n');
  const tenantId=String(process.env.SPENDOS_TENANT_ID||'total-tools').trim();
  if(!raw||!pem)throw issue('SPENDOS_TT_AI_NOT_CONFIGURED');
  let url,key;
  try {url=new URL(raw);key=crypto.createPrivateKey(pem);} catch {throw issue('SPENDOS_TT_AI_CONFIGURATION_INVALID');}
  if(key.asymmetricKeyType!=='ed25519')throw issue('SPENDOS_TT_AI_CONFIGURATION_INVALID');
  if(url.username||url.password||url.search||url.hash||url.pathname!=='/'&&url.pathname!==''
      || !['https:','http:'].includes(url.protocol))throw issue('SPENDOS_TT_AI_CONFIGURATION_INVALID');
  const loopback=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if(url.protocol!=='https:'&&!(loopback&&process.env.NODE_ENV!=='production'))
    throw issue('SPENDOS_TT_AI_HTTPS_REQUIRED');
  return {base:url.origin,privateKey:key,tenantId};
}

async function requestSpendAdvisory({target,tenantId,fetchImpl=globalThis.fetch}={}) {
  const cfg=config();
  if(tenantId!==cfg.tenantId)throw issue('SPENDOS_TT_AI_TENANT_DENIED',403);
  const body={kind:'spend_insights',target};
  const payload=JSON.stringify(body);
  const nonce=crypto.randomUUID(),now=Math.floor(Date.now()/1000);
  const claims={
    iss:'total-tools-spendos',aud:'total-tools-ai-service',sub:'backend',
    tenant_id:cfg.tenantId,scope:'internal_spend_advice',purpose:'spend_insights',
    request_id:crypto.randomUUID(),nonce,iat:now,exp:now+45,
    body_sha256:crypto.createHash('sha256').update(payload).digest('hex'),
  };
  const input='v3.'+Buffer.from(JSON.stringify(claims)).toString('base64url');
  const token=input+'.'+crypto.sign(null,Buffer.from(input),cfg.privateKey).toString('base64url');
  let response;
  try {
    response=await fetchImpl(cfg.base+'/v1/service/advice',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(4000),
      headers:{'content-type':'application/json',accept:'application/json',
        authorization:'Bearer '+token},
      body:payload,
    });
  } catch {throw issue('SPENDOS_TT_AI_UNAVAILABLE',502);}
  if(!response.ok)throw issue('SPENDOS_TT_AI_UPSTREAM_DENIED',502);
  let result;
  try {result=await response.json();}catch {throw issue('SPENDOS_TT_AI_UPSTREAM_INVALID',502);}
  if(result?.tenant_id!==cfg.tenantId||result?.provider!=='total-tools-spendos'
      ||result?.kind!=='spend_insights'||result?.advisoryOnly!==true
      ||result?.request_id!==claims.request_id)throw issue('SPENDOS_TT_AI_UPSTREAM_INVALID',502);
  return result;
}
module.exports={requestSpendAdvisory};
