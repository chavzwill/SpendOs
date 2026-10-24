'use strict';

/**
 * Prevent a target's per-currency SpendOS cost trends from being mistaken for
 * an FX-converted/aggregated total. Never silently choose the first currency.
 */
function selectSingleCurrencyCostTrend(rows,targetId) {
  if(!Array.isArray(rows)||!targetId)return {state:'invalid'};
  const matches=rows.filter(row=>String(row?.targetId||'')===String(targetId));
  if(!matches.length)return {state:'not_found'};
  if(matches.length!==1)return {state:'multi_currency_review_required'};
  const row=matches[0];
  if(!/^[A-Za-z]{3}$/.test(String(row.currency||'')))return {state:'invalid_currency'};
  if([row.trailing30dCost,row.prior30dCost].some(n=>typeof n!=='number'||!Number.isFinite(n)||n<0))
    return {state:'invalid_valuation'};
  if(!Number.isSafeInteger(row.incompleteActualLines)||row.incompleteActualLines<0)
    return {state:'invalid_valuation'};
  return {state:'resolved',row};
}

module.exports={selectSingleCurrencyCostTrend};
