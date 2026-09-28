const http = require('http');
const fs = require('fs');
const path = require('path');
const { openStore } = require('./store');
const { ingestEvent } = require('./ingest');
const { managementSnapshot, supplierPriceHistory } = require('./analytics');
const { runSavingsEngine } = require('./engine');
const { upsertBudget } = require('./budgets');
const { targetCostSummary, targetPortfolio, allocationCoverage, targetTrend } = require('./cost-economics');
const { recordAction, verifyOpportunity, opportunityLifecycle, verifiedSavingsRollup } = require('./savings-lifecycle');
const { upsertSavingsTarget, savingsTargetPerformance, savingsAccountabilityAttention } = require('./savings-targets');
const { savingsLeakageAnalysis } = require('./savings-leakage');
const { refreshLeakageCases, updateLeakageCase, verifyLeakageClosure, leakageCaseDetail } = require('./savings-leakage-cases');

const port = Number(process.env.PORT || 4010);
const apiKey = process.env.SPENDOS_API_KEY || '';
if (process.env.NODE_ENV === 'production' && !apiKey) {
  throw new Error('SPENDOS_API_KEY is required when NODE_ENV=production');
}
const db = openStore();

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  if (!apiKey) return true;
  return req.headers.authorization === `Bearer ${apiKey}`;
}

function staticAsset(req, res) {
  const assets = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
    '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
  };
  const asset = assets[req.url];
  if (!asset || req.method !== 'GET') return false;
  const filename = path.join(__dirname, '..', 'public', asset[0]);
  res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store' });
  res.end(fs.readFileSync(filename));
  return true;
}

const server = http.createServer((req, res) => {
  if (staticAsset(req, res)) return;
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, service: 'spend-os' });
  }
  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });

  if (req.method === 'POST' && req.url === '/v1/events') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const event = JSON.parse(body || '{}');
        const result = ingestEvent(db, event);
        const code = result.status === 'accepted' ? 202 :
          result.status === 'duplicate' ? 200 :
          result.status === 'stale' ? 409 :
          result.status === 'conflict' ? 409 : 200;
        send(res, code, result);
      } catch (error) {
        send(res, error.statusCode || 500, { error: error.message });
      }
    });
    return;
  }

  const dashboardMatch = req.url.match(/^\/v1\/management\/dashboard\?tenantId=([^&]+)$/);
  if (req.method === 'GET' && dashboardMatch) {
    return send(res, 200, managementSnapshot(db, decodeURIComponent(dashboardMatch[1])));
  }

  const priceMatch = req.url.match(/^\/v1\/suppliers\/prices\?tenantId=([^&]+)&sku=([^&]+)$/);
  if (req.method === 'GET' && priceMatch) {
    return send(res, 200, supplierPriceHistory(
      db,
      decodeURIComponent(priceMatch[1]),
      decodeURIComponent(priceMatch[2])
    ));
  }

  const actionMatch = req.url.match(/^\/v1\/savings\/opportunities\/(\d+)\/actions\?tenantId=([^&]+)$/);
  if (req.method === 'POST' && actionMatch) {
    let body='';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const result=recordAction(db,decodeURIComponent(actionMatch[2]),Number(actionMatch[1]),JSON.parse(body||'{}'));
        send(res,201,result);
      } catch(error) { send(res,400,{error:error.message}); }
    });
    return;
  }

  const verifyMatch = req.url.match(/^\/v1\/savings\/opportunities\/(\d+)\/verify\?tenantId=([^&]+)$/);
  if (req.method === 'POST' && verifyMatch) {
    try {
      return send(res,200,verifyOpportunity(db,decodeURIComponent(verifyMatch[2]),Number(verifyMatch[1])));
    } catch(error) { return send(res,400,{error:error.message}); }
  }

  const lifecycleMatch = req.url.match(/^\/v1\/savings\/opportunities\/(\d+)\?tenantId=([^&]+)$/);
  if (req.method === 'GET' && lifecycleMatch) {
    try {
      return send(res,200,opportunityLifecycle(db,decodeURIComponent(lifecycleMatch[2]),Number(lifecycleMatch[1])));
    } catch(error) { return send(res,404,{error:error.message}); }
  }

  const leakageCaseDetailMatch = req.url.match(/^\/v1\/savings\/leakage\/cases\/(\d+)\?tenantId=([^&]+)$/);
  if (req.method === 'GET' && leakageCaseDetailMatch) {
    try{return send(res,200,leakageCaseDetail(db,decodeURIComponent(leakageCaseDetailMatch[2]),Number(leakageCaseDetailMatch[1])));}
    catch(error){return send(res,404,{error:error.message});}
  }

  const leakageCaseStateMatch = req.url.match(/^\/v1\/savings\/leakage\/cases\/(\d+)\/state\?tenantId=([^&]+)$/);
  if (req.method === 'POST' && leakageCaseStateMatch) {
    let body='';req.on('data',chunk=>{body+=chunk;});req.on('end',()=>{
      try{return send(res,200,updateLeakageCase(db,decodeURIComponent(leakageCaseStateMatch[2]),Number(leakageCaseStateMatch[1]),JSON.parse(body||'{}')));}
      catch(error){return send(res,400,{error:error.message});}
    });
    return;
  }

  const leakageCaseVerifyMatch = req.url.match(/^\/v1\/savings\/leakage\/cases\/(\d+)\/verify\?tenantId=([^&]+)$/);
  if (req.method === 'POST' && leakageCaseVerifyMatch) {
    try{return send(res,200,verifyLeakageClosure(db,decodeURIComponent(leakageCaseVerifyMatch[2]),Number(leakageCaseVerifyMatch[1]),null));}
    catch(error){return send(res,400,{error:error.message});}
  }

  const leakageCasesMatch = req.url.match(/^\/v1\/savings\/leakage\/cases\?tenantId=([^&]+)$/);
  if (req.method === 'POST' && leakageCasesMatch) {
    return send(res,200,refreshLeakageCases(db,decodeURIComponent(leakageCasesMatch[1])));
  }

  const leakageMatch = req.url.match(/^\/v1\/savings\/leakage\?tenantId=([^&]+)$/);
  if (req.method === 'GET' && leakageMatch) {
    return send(res,200,savingsLeakageAnalysis(db,decodeURIComponent(leakageMatch[1])));
  }

  const attentionMatch = req.url.match(/^\/v1\/savings\/attention\?tenantId=([^&]+)$/);
  if (req.method === 'GET' && attentionMatch) {
    return send(res,200,savingsAccountabilityAttention(db,decodeURIComponent(attentionMatch[1])));
  }

  const targetPerformanceMatch = req.url.match(/^\/v1\/savings\/targets\/performance\?tenantId=([^&]+)$/);
  if (req.method === 'GET' && targetPerformanceMatch) {
    return send(res,200,savingsTargetPerformance(db,decodeURIComponent(targetPerformanceMatch[1])));
  }

  const targetMatch = req.url.match(/^\/v1\/savings\/targets\?tenantId=([^&]+)$/);
  if (req.method === 'POST' && targetMatch) {
    let body='';
    req.on('data',chunk=>{body+=chunk;});
    req.on('end',()=>{
      try{return send(res,201,upsertSavingsTarget(db,decodeURIComponent(targetMatch[1]),JSON.parse(body||'{}')));}
      catch(error){return send(res,400,{error:error.message});}
    });
    return;
  }

  const rollupMatch = req.url.match(/^\/v1\/savings\/verified-rollup\?tenantId=([^&]+)$/);
  if (req.method === 'GET' && rollupMatch) {
    return send(res,200,verifiedSavingsRollup(db,decodeURIComponent(rollupMatch[1])));
  }

  const savingsMatch = req.url.match(/^\/v1\/savings\/run\?tenantId=([^&]+)$/);
  if (req.method === 'POST' && savingsMatch) {
    return send(res, 200, runSavingsEngine(db, decodeURIComponent(savingsMatch[1])));
  }

  const trendMatch = req.url.match(/^\/v1\/costs\/trend\?tenantId=([^&]+)&targetType=([^&]+)$/);
  if (req.method === 'GET' && trendMatch) {
    return send(res, 200, targetTrend(db, decodeURIComponent(trendMatch[1]), decodeURIComponent(trendMatch[2])));
  }

  const portfolioMatch = req.url.match(/^\/v1\/costs\/portfolio\?tenantId=([^&]+)&targetType=([^&]+)$/);
  if (req.method === 'GET' && portfolioMatch) {
    return send(res, 200, targetPortfolio(db, decodeURIComponent(portfolioMatch[1]), decodeURIComponent(portfolioMatch[2])));
  }

  const coverageMatch = req.url.match(/^\/v1\/costs\/coverage\?tenantId=([^&]+)$/);
  if (req.method === 'GET' && coverageMatch) {
    return send(res, 200, allocationCoverage(db, decodeURIComponent(coverageMatch[1])));
  }

  const costMatch = req.url.match(/^\/v1\/costs\/target\?tenantId=([^&]+)&targetType=([^&]+)&targetId=([^&]*)$/);
  if (req.method === 'GET' && costMatch) {
    return send(res, 200, targetCostSummary(
      db,
      decodeURIComponent(costMatch[1]),
      decodeURIComponent(costMatch[2]),
      decodeURIComponent(costMatch[3]) || null
    ));
  }

  if (req.method === 'POST' && req.url === '/v1/budgets') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const budget = JSON.parse(body || '{}');
        upsertBudget(db, budget);
        send(res, 201, { status: 'saved' });
      } catch (error) {
        send(res, 400, { error: error.message });
      }
    });
    return;
  }

  send(res, 404, { error: 'not_found' });
});

if (require.main === module) {
  server.listen(port, '127.0.0.1', () => {
    console.log(`SpendOS listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { server, db };
