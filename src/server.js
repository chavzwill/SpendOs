const http = require('http');
const { openStore } = require('./store');
const { ingestEvent } = require('./ingest');
const { managementSnapshot, supplierPriceHistory } = require('./analytics');
const { runSavingsEngine } = require('./engine');
const { upsertBudget } = require('./budgets');
const { targetCostSummary, targetPortfolio, allocationCoverage } = require('./cost-economics');

const port = Number(process.env.PORT || 4010);
const apiKey = process.env.SPENDOS_API_KEY || '';
const db = openStore();

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function authorized(req) {
  if (!apiKey) return true;
  return req.headers.authorization === `Bearer ${apiKey}`;
}

const server = http.createServer((req, res) => {
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

  const savingsMatch = req.url.match(/^\/v1\/savings\/run\?tenantId=([^&]+)$/);
  if (req.method === 'POST' && savingsMatch) {
    return send(res, 200, runSavingsEngine(db, decodeURIComponent(savingsMatch[1])));
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
