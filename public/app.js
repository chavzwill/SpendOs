const TENANT='total-tools';
const state={snapshot:null,coverage:null,rollup:null,attention:null,leakage:null,savings:null,portfolios:{}};
const money=(value,currency='JMD')=>new Intl.NumberFormat('en-JM',{style:'currency',currency:currency||'JMD',maximumFractionDigits:0}).format(Number(value||0));
const num=value=>new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(Number(value||0));
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const title=value=>String(value||'').replaceAll('_',' ').replace(/w/g,c=>c.toUpperCase());
const api=async(path,options={})=>{
  const res=await fetch(path,{headers:{'content-type':'application/json',...(options.headers||{})},...options});
  if(!res.ok) throw new Error((await res.json().catch(()=>({}))).error||`Request failed (${res.status})`);
  return res.json();
};
const toast=message=>{
  const el=document.querySelector('#toast'); el.textContent=message; el.classList.add('show');
  clearTimeout(window.__toast); window.__toast=setTimeout(()=>el.classList.remove('show'),2600);
};
const details=row=>{try{return JSON.parse(row.details_json||'{}')}catch{return {}}};

async function loadPortfolio(type='vehicle'){
  if(!state.portfolios[type]) state.portfolios[type]=await api(`/v1/costs/portfolio?tenantId=${TENANT}&targetType=${type}`);
  return state.portfolios[type];
}

async function refreshAll(showToast=false){
  const [snapshot,coverage,rollup,attention,leakage,savings]=await Promise.all([
    api(`/v1/management/dashboard?tenantId=${TENANT}`),
    api(`/v1/costs/coverage?tenantId=${TENANT}`),
    api(`/v1/savings/verified-rollup?tenantId=${TENANT}`),
    api(`/v1/savings/attention?tenantId=${TENANT}`),
    api(`/v1/savings/leakage?tenantId=${TENANT}`),
    api(`/v1/savings/run?tenantId=${TENANT}`,{method:'POST'})
  ]);
  Object.assign(state,{snapshot,coverage,rollup,attention,leakage,savings,portfolios:{}});
  await loadPortfolio('vehicle');
  renderOverview();
  renderSecondaryViews();
  if(showToast) toast('SpendOS evidence refreshed');
}

function renderOverview(){
  const s=state.snapshot||{}, c=state.coverage||{}, sv=state.savings||{};
  const verified=(state.rollup?.totalsByCurrency||[]).reduce((sum,x)=>sum+Number(x.verifiedSavings||0),0);
  document.querySelector('#actual-spend').textContent=money(s.actual);
  document.querySelector('#requested-spend').textContent=money(s.requested);
  document.querySelector('#allocated-spend').textContent=money(c.actualAllocatedValue);
  document.querySelector('#verified-savings').textContent=money(verified);
  document.querySelector('#net-loss').textContent=money(s.netLoss);
  document.querySelector('#opportunity-count').textContent=(sv.opportunities||[]).length;
  document.querySelector('#leakage-count').textContent=state.leakage?.summary?.total||0;
  const complete=Math.max(0,Number(c.totalLines||0)-Number(c.incompleteActualLines||0));
  const rate=c.totalLines?Math.round(100*complete/c.totalLines):0;
  document.querySelector('#coverage-rate').textContent=c.totalLines?`${rate}%`:'—';
  document.querySelector('#coverage-note').textContent=c.totalLines?`${complete} of ${c.totalLines} cost lines have usable evidence`:'No allocation evidence';
  renderAttention();
  renderSuppliers();
  renderOpportunityTable();
  renderCostBars('vehicle');
}

function renderAttention(){
  const items=state.attention?.items||[];
  const leakage=(state.leakage?.items||[]).map(x=>({...x,reason:x.reason||'Savings leakage needs review.'}));
  const all=[...leakage,...items].slice(0,5);
  document.querySelector('#attention-count').textContent=all.length;
  document.querySelector('#attention-list').innerHTML=all.length?all.map(item=>`
    <div class="attention-item">
      <span class="attention-dot ${item.priority==='high'?'high':''}"></span>
      <div><strong>${esc(title(item.kind))}</strong><p>${esc(item.reason)}</p></div>
      <small>${esc(item.priority||'review')}</small>
    </div>`).join(''):'<div class="empty">No evidence-backed attention items right now.</div>';
}

function renderSuppliers(){
  const rows=(state.snapshot?.suppliers||[]).slice(0,6), max=Math.max(1,...rows.map(x=>Number(x.amount||0)));
  document.querySelector('#supplier-list').innerHTML=rows.length?rows.map((r,i)=>`
    <div class="supplier-row">
      <div class="supplier-icon">S${i+1}</div>
      <div><strong>Supplier ${esc(r.supplier_id)}</strong><span>${Math.round(100*Number(r.amount||0)/max)}% relative concentration</span></div>
      <em>${money(r.amount,r.currency)}</em>
    </div>`).join(''):'<div class="empty">Supplier spend appears after POS evidence is received.</div>';
}

async function renderCostBars(type){
  const rows=(await loadPortfolio(type)).slice(0,6);
  const max=Math.max(1,...rows.map(x=>Number(x.actualCost||0)));
  document.querySelector('#cost-bars').innerHTML=rows.length?rows.map(r=>`
    <div class="cost-row">
      <div class="cost-label"><strong>${esc(r.targetLabel||r.targetId||'Unlabelled')}</strong><span>${esc(title(type))} · ${r.lineCount} evidence lines</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(5,100*Number(r.actualCost||0)/max)}%"></div></div>
      <div class="cost-value">${money(r.actualCost,r.currency)}</div>
    </div>`).join(''):'<div class="empty">No allocated cost evidence for this view yet.</div>';
}

function opportunityLabel(row){
  const d=details(row);
  if(row.kind==='supplier_alternative') return `${d.sku||'Item'} · supplier alternative`;
  if(row.kind==='supplier_price_drift') return `${d.sku||'Item'} · price drift`;
  if(row.kind==='consumable_variance') return `${d.sku||'Item'} · usage variance`;
  return title(row.kind);
}

function evidenceLabel(row){
  const d=details(row);
  if(row.kind==='supplier_alternative') return `Supplier ${d.currentSupplierId} → ${d.alternativeSupplierId}`;
  if(row.kind==='supplier_price_drift') return `${num(d.driftPct)}% above baseline`;
  if(row.kind==='consumable_variance') return `${num(d.variancePct)}% quantity variance`;
  return 'Recorded evidence';
}

function renderOpportunityTable(){
  const rows=(state.savings?.opportunities||[]).slice(0,8);
  document.querySelector('#opportunity-table').innerHTML=rows.length?rows.map(row=>`
    <tr>
      <td><strong>${esc(opportunityLabel(row))}</strong><div class="subcell">${esc(title(row.kind))}</div></td>
      <td>${esc(evidenceLabel(row))}</td>
      <td><strong>${money(row.estimated_savings,row.currency)}</strong><div class="subcell">estimated · verified ${money(row.verified_savings,row.currency)}</div></td>
      <td><span class="status ${esc(row.status)}">${esc(row.status)}</span></td>
      <td><button class="secondary-btn" data-evidence="${row.id}">Evidence</button></td>
    </tr>`).join(''):'<tr><td colspan="5"><div class="empty">No opportunities detected yet.</div></td></tr>';
}

function panel(titleText,eyebrow,body){
  return `<article class="panel"><div class="section-heading"><div><p class="eyebrow">${eyebrow}</p><h2>${titleText}</h2></div></div>${body}</article>`;
}

function supplierTable(){
  const rows=state.snapshot?.suppliers||[];
  return `<div class="table-wrap"><table><thead><tr><th>Supplier</th><th>Recorded spend</th><th>Currency</th><th>Share</th></tr></thead><tbody>${rows.map(r=>{
    const total=rows.reduce((s,x)=>s+Number(x.amount||0),0)||1;
    return `<tr><td><strong>Supplier ${esc(r.supplier_id)}</strong></td><td>${money(r.amount,r.currency)}</td><td>${esc(r.currency||'—')}</td><td>${num(100*Number(r.amount||0)/total)}%</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

function opportunitiesFull(){
  const rows=state.savings?.opportunities||[];
  return `<div class="table-wrap"><table><thead><tr><th>Opportunity</th><th>Evidence</th><th>Estimated</th><th>Verified</th><th>Status</th></tr></thead><tbody>${rows.map(row=>`
    <tr><td><strong>${esc(opportunityLabel(row))}</strong><div class="subcell">${esc(title(row.kind))}</div></td><td>${esc(evidenceLabel(row))}</td>
    <td>${money(row.estimated_savings,row.currency)}</td><td>${money(row.verified_savings,row.currency)}</td><td><span class="status ${esc(row.status)}">${esc(row.status)}</span></td></tr>`).join('')}</tbody></table></div>`;
}

function renderSecondaryViews(){
  const s=state.snapshot||{}, c=state.coverage||{};
  document.querySelector('#view-spending').innerHTML=
    `<div class="kpi-grid"><article class="kpi"><span>Actual spend</span><strong>${money(s.actual)}</strong><small>Received cost evidence</small></article>
    <article class="kpi"><span>Requested spend</span><strong>${money(s.requested)}</strong><small>Open/request evidence</small></article>
    <article class="kpi"><span>Internal consumption</span><strong>${money(s.consumed)}</strong><small>Not double-counted as purchases</small></article>
    <article class="kpi"><span>Allocated actual</span><strong>${money(c.actualAllocatedValue)}</strong><small>Attributed to cost objects</small></article></div>`+
    panel('Spend by supplier','SPENDING',supplierTable());

  document.querySelector('#view-assets').innerHTML=
    panel('Vehicles & equipment','COST ECONOMICS','<div id="asset-portfolio" class="detail-grid"></div>')+
    panel('Why this matters','DECISION SUPPORT','<p class="empty">SpendOS keeps requested maintenance intent separate from actual parts and service cost, so an asset can be evaluated against real cost evidence without inventing revenue.</p>');
  renderAssetCards();

  document.querySelector('#view-suppliers').innerHTML=
    panel('Supplier concentration','SUPPLIER CONTROL',supplierTable())+
    panel('Price & sourcing opportunities','SAVINGS',opportunitiesFull());

  const targetRows=state.savings?.budgets||[];
  const targetPerfPromise=api(`/v1/savings/targets/performance?tenantId=${TENANT}`).catch(()=>[]);
  targetPerfPromise.then(targets=>{
    document.querySelector('#view-budgets').innerHTML=panel('Budgets & savings targets','ACCOUNTABILITY',
      `<div class="detail-grid">${[...targetRows,...targets].slice(0,9).map(x=>{
        const goal=Number(x.budget??x.amount??x.target_amount??0), actual=Number(x.spent??x.verified_savings??0), pct=goal?Math.min(100,100*actual/goal):0;
        return `<div class="detail-card"><h3>${esc(title(x.scope_type||x.scopeType||'Budget'))} · ${esc(x.scope_id||x.scopeId||'all')}</h3>
        <div class="metric-line"><span>Goal</span><strong>${money(goal,x.currency)}</strong></div><div class="metric-line"><span>Evidence</span><strong>${money(actual,x.currency)}</strong></div>
        <div class="progress"><i style="width:${pct}%"></i></div></div>`;
      }).join('')||'<div class="empty">No budgets or savings targets configured.</div>'}</div>`);
  });

  document.querySelector('#view-savings').innerHTML=
    `<div class="kpi-grid"><article class="kpi"><span>Detected</span><strong>${(state.savings?.opportunities||[]).length}</strong><small>Current opportunities</small></article>
    <article class="kpi"><span>Verified evidence</span><strong>${state.rollup?.claimedEvidenceCount||0}</strong><small>Receipt evidence claims</small></article>
    <article class="kpi"><span>Leakage cases</span><strong>${state.leakage?.summary?.total||0}</strong><small>Post-action leakage</small></article>
    <article class="kpi"><span>Method</span><strong>Actuals</strong><small>No forecast counted as savings</small></article></div>`+
    panel('Savings opportunities','EVIDENCE ENGINE',opportunitiesFull());

  document.querySelector('#view-recoveries').innerHTML=
    panel('Supplier recoveries','POS-AUTHORITATIVE',
      `<div class="detail-grid"><div class="detail-card"><h3>Credits & shorted goods</h3><p class="empty">Identified exposure, confirmed recoverables, returns and formal credit notes stay authoritative in the POS.</p></div>
      <div class="detail-card"><h3>AP protection</h3><p class="empty">Usable confirmed credits should be checked before additional supplier cash payment.</p></div>
      <div class="detail-card"><h3>SpendOS role</h3><p class="empty">Surface patterns and attention signals without fabricating supplier receivables.</p></div></div>`);
}

async function renderAssetCards(){
  const vehicles=await loadPortfolio('vehicle');
  const rentals=await loadPortfolio('rental_asset');
  const rows=[...vehicles.map(x=>({...x,type:'Vehicle'})),...rentals.map(x=>({...x,type:'Rental asset'}))].slice(0,9);
  const host=document.querySelector('#asset-portfolio'); if(!host) return;
  host.innerHTML=rows.length?rows.map(r=>`<div class="detail-card"><h3>${esc(r.targetLabel||r.targetId)}</h3>
    <div class="metric-line"><span>Type</span><strong>${r.type}</strong></div>
    <div class="metric-line"><span>Actual cost</span><strong>${money(r.actualCost,r.currency)}</strong></div>
    <div class="metric-line"><span>Requested</span><strong>${money(r.requestedCost,r.currency)}</strong></div>
    <div class="metric-line"><span>Evidence lines</span><strong>${r.lineCount}</strong></div></div>`).join(''):'<div class="empty">No vehicle or rental cost evidence yet.</div>';
}

function showEvidence(id){
  const row=(state.savings?.opportunities||[]).find(x=>Number(x.id)===Number(id)); if(!row) return;
  const d=details(row), evidence=JSON.parse(row.evidence_json||'[]');
  const message=`${opportunityLabel(row)} · ${evidence.length} source event${evidence.length===1?'':'s'} · ${evidenceLabel(row)}`;
  toast(message);
}

function activateView(name){
  document.querySelectorAll('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
  document.querySelectorAll('.nav-item').forEach(v=>v.classList.toggle('active',v.dataset.view===name));
  const labels={overview:'Spend control center',spending:'Company spending',assets:'Assets & equipment',suppliers:'Supplier intelligence',savings:'Savings & leakage',budgets:'Budgets & targets',recoveries:'Supplier recoveries'};
  document.querySelector('#page-title').textContent=labels[name]||'SpendOS';
}

document.addEventListener('click',async e=>{
  const nav=e.target.closest('[data-view]'); if(nav) activateView(nav.dataset.view);
  const goto=e.target.closest('[data-nav]'); if(goto) activateView(goto.dataset.nav);
  const segment=e.target.closest('[data-target-type]'); if(segment){
    document.querySelectorAll('.segment').forEach(x=>x.classList.toggle('active',x===segment));
    await renderCostBars(segment.dataset.targetType);
  }
  const evidence=e.target.closest('[data-evidence]'); if(evidence) showEvidence(evidence.dataset.evidence);
});
document.querySelector('#refresh-btn').addEventListener('click',()=>refreshAll(true).catch(err=>toast(err.message)));
document.querySelector('#run-savings-btn').addEventListener('click',async()=>{state.savings=await api(`/v1/savings/run?tenantId=${TENANT}`,{method:'POST'});renderOverview();renderSecondaryViews();toast('Savings scan complete');});

refreshAll().catch(err=>{
  document.querySelector('#attention-list').innerHTML=`<div class="empty">Unable to load SpendOS: ${esc(err.message)}</div>`;
  toast('SpendOS could not load data');
});
