const test=require('node:test');
const assert=require('node:assert/strict');
const {selectSingleCurrencyCostTrend}=require('../src/tt-ai-cost-selection');

const sample={targetId:'GEN-12',currency:'JMD',trailing30dCost:12500,
  prior30dCost:10000,incompleteActualLines:1};
test('single exact target and currency is safe to send',()=>{
  const result=selectSingleCurrencyCostTrend([sample],sample.targetId);
  assert.equal(result.state,'resolved');
  assert.equal(result.row.currency,'JMD');
  assert.equal(result.row.incompleteActualLines,1);
});
test('multiple currency rows for same asset require finance review',()=>{
  const result=selectSingleCurrencyCostTrend([
    sample,{...sample,currency:'USD',trailing30dCost:100},
  ],'GEN-12');
  assert.equal(result.state,'multi_currency_review_required');
});
test('different asset identifiers do not contaminate the requested asset',()=>{
  const result=selectSingleCurrencyCostTrend([
    {...sample,targetId:'GEN-13'},sample,
  ],'GEN-12');
  assert.equal(result.state,'resolved');
  assert.equal(result.row.targetId,'GEN-12');
});
test('no historical evidence is unknown, not a zero spending fact',()=>{
  assert.equal(selectSingleCurrencyCostTrend([sample],'missing').state,'not_found');
});
test('nonfinite/negative costs and incomplete counts are rejected',()=>{
  for(const changed of [
    {trailing30dCost:NaN},{prior30dCost:-1},
    {incompleteActualLines:-1},{incompleteActualLines:1.5}
  ]){
    assert.equal(selectSingleCurrencyCostTrend([{...sample,...changed}],'GEN-12').state,
      'invalid_valuation');
  }
});
test('unrecognized currency cannot become a savings recommendation',()=>{
  assert.equal(selectSingleCurrencyCostTrend([{...sample,currency:'MULTI'}],'GEN-12').state,
    'invalid_currency');
});
