const {
  detectPriceDrift,
  detectSupplierAlternatives,
  detectConsumableVariance,
} = require('./opportunities');
const { persistOpportunities, listOpportunities } = require('./savings');
const { assessBudgets } = require('./budgets');

function runSavingsEngine(db, tenantId, options = {}) {
  const detected = [
    ...detectPriceDrift(db, tenantId, options.priceDrift),
    ...detectSupplierAlternatives(db, tenantId, options.supplierAlternatives),
    ...detectConsumableVariance(db, tenantId, options.consumables),
  ];
  persistOpportunities(db, detected);
  return {
    detected: detected.length,
    opportunities: listOpportunities(db, tenantId),
    budgets: assessBudgets(db, tenantId, options.asOf),
  };
}

module.exports = { runSavingsEngine };
