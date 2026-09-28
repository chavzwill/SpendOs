const TENANT='total-tools';
const state={system:null,snapshot:null,coverage:null,rollup:null,attention:null,leakage:null,savings:null,portfolios:{}};
const money=(value,currency='JMD')=>new Intl.NumberFormat('en-JM',{style:'currency',currency:currency||'JMD',maximumFractionDigits:0}).format(Number(value||0));
const num=value=>new Intl.NumberFormat('en-US',{maximumFractionDigits:1}).format(Number(value||0));
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const title=value=>String(value||'').replaceAll('_',' ').replace(/w/g,c=>c.toUpperCase());
const api=async(path,options={})=>{
  const res=await fetch(path,{headers:{'content-type':'application/json',...(options.headers||{})},...options});
  if(!res.ok){
    const body=await res.json().catch(()=>({}));
    if(res.status===401&&path.startsWith('/v1/')) showLogin('Your SpendOS management session has expired.');
    throw new Error(body.error||`Request failed (${res.status})`);
  }
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
  const [system,snapshot,coverage,rollup,attention,leakage,opportunities,budgets]=await Promise.all([
    api(`/v1/system/status?tenantId=${TENANT}`),
    api(`/v1/management/dashboard?tenantId=${TENANT}`),
    api(`/v1/costs/coverage?tenantId=${TENANT}`),
    api(`/v1/savings/verified-rollup?tenantId=${TENANT}`),
    api(`/v1/savings/attention?tenantId=${TENANT}`),
    api(`/v1/savings/leakage?tenantId=${TENANT}`),
    api(`/v1/savings/opportunities?tenantId=${TENANT}`),
    api(`/v1/budgets/status?tenantId=${TENANT}`)
  ]);
  const savings={opportunities,budgets};
  Object.assign(state,{system,snapshot,coverage,rollup,attention,leakage,savings,portfolios:{}});
  await loadPortfolio('vehicle');
  renderConnectionStatus();
  renderOverview();
  renderSecondaryViews();
  if(showToast) toast('SpendOS evidence refreshed');
}

function formatEvidenceTime(value){
  if(!value) return 'No evidence received';
  const iso=String(value).includes('T')?String(value):String(value).replace(' ','T')+'Z';
  const date=new Date(iso);
  return Number.isNaN(date.getTime())?'Evidence received':date.toLocaleString([],{
    month:'short',day:'numeric',hour:'numeric',minute:'2-digit'
  });
}

function renderConnectionStatus(){
  const system=state.system||{};
  const mode=system.connectionState||'waiting_for_evidence';
  const pill=document.querySelector('#system-status-pill');
  const text=document.querySelector('#system-status-text');
  const dot=document.querySelector('#connection-dot');
  const label=document.querySelector('#connection-label');
  const detail=document.querySelector('#connection-detail');
  const banner=document.querySelector('#connection-banner');
  const period=document.querySelector('#evidence-period');
  const scanButton=document.querySelector('#run-savings-btn');
  pill.classList.remove('connected','stale','waiting');
  dot.classList.remove('connected','stale','waiting');

  if(mode==='connected'){
    pill.classList.add('connected');dot.classList.add('connected');
    text.textContent='POS evidence live';
    label.textContent='POS evidence connected';
    detail.textContent=`${system.eventCount} accepted event${system.eventCount===1?'':'s'}`;
    banner.hidden=true;
  }else if(mode==='stale'){
    pill.classList.add('stale');dot.classList.add('stale');
    text.textContent='Evidence stale';
    label.textContent='POS evidence is stale';
    detail.textContent=`Last received ${formatEvidenceTime(system.lastReceivedAt)}`;
    banner.hidden=false;banner.className='connection-banner stale';
    banner.innerHTML='<strong>SpendOS is operational, but the POS evidence stream is stale.</strong> Check the POS outbox, worker schedule and connector health before relying on current totals.';
  }else{
    pill.classList.add('waiting');dot.classList.add('waiting');
    text.textContent='Awaiting POS evidence';
    label.textContent='Waiting for POS evidence';
    detail.textContent='No authenticated spend events received';
    banner.hidden=false;banner.className='connection-banner';
    banner.innerHTML='<strong>SpendOS is operational and empty by design.</strong> No POS spend evidence has been received yet. The dashboard will populate automatically when the authenticated Total Tools POS connector sends real purchasing, receipt and consumption events.';
  }
  period.textContent=system.lastReceivedAt?`Last sync · ${formatEvidenceTime(system.lastReceivedAt)}`:'Awaiting first POS event';
  scanButton.disabled=Number(system.eventCount||0)===0;
  scanButton.title=scanButton.disabled?'Savings analysis becomes available after real POS evidence arrives.':'';
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
  const rows=(state.snapshot?.suppliers||[]).slice(0,6);
  const total=Math.max(1,rows.reduce((sum,x)=>sum+Number(x.amount||0),0));
  document.querySelector('#supplier-list').innerHTML=rows.length?rows.map((r,i)=>`
    <div class="supplier-row">
      <div class="supplier-icon">S${i+1}</div>
      <div><strong>${esc(r.supplier_id)}</strong><span>${num(100*Number(r.amount||0)/total)}% of recorded supplier spend</span></div>
      <em>${money(r.amount,r.currency)}</em>
    </div>`).join(''):'<div class="empty">No supplier spend evidence has been received from the POS yet.</div>';
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
  if(!rows.length) return '<div class="empty">No supplier spend evidence has been received from the POS yet.</div>';
  const total=rows.reduce((s,x)=>s+Number(x.amount||0),0)||1;
  return `<div class="table-wrap"><table><thead><tr><th>Supplier</th><th>Recorded spend</th><th>Currency</th><th>Share</th></tr></thead><tbody>${rows.map(r=>
    `<tr><td><strong>${esc(r.supplier_id)}</strong></td><td>${money(r.amount,r.currency)}</td><td>${esc(r.currency||'—')}</td><td>${num(100*Number(r.amount||0)/total)}%</td></tr>`
  ).join('')}</tbody></table></div>`;
}

function opportunitiesFull(){
  const rows=state.savings?.opportunities||[];
  if(!rows.length) return '<div class="empty">No savings opportunities have been detected from real POS evidence yet.</div>';
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

function showLogin(message=''){
  const gate=document.querySelector('#login-gate');
  gate.hidden=false;
  document.querySelector('#login-error').textContent=message;
  setTimeout(()=>document.querySelector('#login-user')?.focus(),0);
}

function hideLogin(session){
  document.querySelector('#login-gate').hidden=true;
  document.querySelector('#login-error').textContent='';
  const logout=document.querySelector('#logout-btn');
  logout.hidden=!session?.authRequired;
}

async function bootstrap(){
  try{
    const session=await api('/ui/session');
    if(!session.authenticated) return showLogin();
    hideLogin(session);
    await refreshAll();
  }catch(error){
    showLogin(error.message);
  }
}

document.querySelector('#login-form').addEventListener('submit',async event=>{
  event.preventDefault();
  const button=event.currentTarget.querySelector('button[type="submit"]');
  const error=document.querySelector('#login-error');
  button.disabled=true;button.textContent='Signing in…';error.textContent='';
  try{
    const session=await api('/ui/login',{method:'POST',body:JSON.stringify({
      username:document.querySelector('#login-user').value,
      password:document.querySelector('#login-password').value
    })});
    document.querySelector('#login-password').value='';
    hideLogin({...session,authRequired:true});
    await refreshAll();
  }catch(err){
    error.textContent=err.message==='invalid_credentials'?'Incorrect username or password.':err.message;
  }finally{
    button.disabled=false;button.textContent='Sign in';
  }
});

document.querySelector('#logout-btn').addEventListener('click',async()=>{
  try{await api('/ui/logout',{method:'POST'});}catch{}
  showLogin();
});

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
document.querySelector('#run-savings-btn').addEventListener('click',async()=>{const btn=document.querySelector('#run-savings-btn');btn.disabled=true;const original=btn.textContent;btn.textContent='Scanning…';try{await api(`/v1/savings/run?tenantId=${TENANT}`,{method:'POST'});await refreshAll();toast('Savings scan complete');}catch(error){toast(error.message);}finally{btn.disabled=false;btn.textContent=original;}});

bootstrap();
