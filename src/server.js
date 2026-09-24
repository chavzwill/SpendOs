const http = require('http');
const { openStore } = require('./store');
const { ingestEvent } = require('./ingest');
const { managementSnapshot, supplierPriceHistory } = require('./analytics');

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

  send(res, 404, { error: 'not_found' });
});

if (require.main === module) {
  server.listen(port, '127.0.0.1', () => {
    console.log(`SpendOS listening on http://127.0.0.1:${port}`);
  });
}

module.exports = { server, db };
