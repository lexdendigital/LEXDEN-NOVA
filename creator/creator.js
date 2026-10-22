'use strict';

function cxField(k,v){ cx.form[k] = v; }
async function cxSaveProfile(){
  if(cx.busy) return; cx.busy = true; cx.error = ''; cx.info = ''; render();
  try{
    const r = await capi('/api/creator-profile', { action:'update', username:cx.form.username, tagline:cx.form.tagline, bio:cx.form.bio });
    cx.profile = r.profile; cx.info = 'Saved.';
  }catch(e){ cx.error = creatorErrText(e); }
  cx.busy = false; render();
}
async function cxMarkRead(){
  try{ await capi('/api/creator-notifications', { action:'mark_read' }); cx.notes = null; creatorHome.data = null; cxLoad(true); }catch(e){ toast(creatorErrText(e),'error'); }
}
function cxCopyLink(){
  const u = cx.profile && cx.profile.username ? storeUrl('#seller/' + cx.profile.username) : '';
  if(!u) return;
  try{ navigator.clipboard.writeText(u); toast('Link copied', 'success'); }catch(e){ toast(u, 'info'); }
}
/* ---- Updates feed: short posts shown on your public seller page ---- */
let cu = { list:null, text:'', busy:false, err:'', loading:false };
async function cuLoad(){
  if(cu.loading) return; cu.loading = true;
  try{ const r = await authedApi('/api/creator-updates?mine=1', {}, 15000, 'Loading timed out.'); const d = await r.json(); cu.list = (d && d.ok) ? d.data.updates : []; }
  catch(e){ cu.list = []; cu.err = e.message || ''; }
  cu.loading = false; if(creatorTab==='store') render();
}
async function cuPost(){
  if(cu.busy) return; cu.busy = true; cu.err = ''; render();
  try{
    const r = await authedApi('/api/creator-updates', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'post', text: cu.text }) }, 20000, 'Posting timed out.');
    const d = await r.json();
    if(d && d.ok){ cu.text = ''; cu.list = null; } else cu.err = (d && d.error && d.error.message) || 'Could not post.';
  }catch(e){ cu.err = e.message || 'Could not reach the server.'; }
  cu.busy = false; render();
}
async function cuDelete(id){
  if(!confirm('Delete this update?')) return;
  try{ await authedApi('/api/creator-updates', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'delete', id }) }, 15000, 'Timed out.'); }catch(e){}
  cu.list = null; render();
}
function cuCardHtml(){
  if(cu.list===null && !cu.loading) cuLoad();
  const list = cu.list || [];
  return `<div class="card" style="padding:16px;margin-bottom:14px;">
    <h3 style="font-size:15px;margin-bottom:6px;">Updates</h3>
    <div class="text-2 small" style="margin-bottom:8px;">Short news for buyers, shown on your public page. Up to 3 a day, 500 characters, no links.</div>
    <textarea class="input" rows="3" maxlength="500" placeholder="e.g. New batch arrives Friday" oninput="cu.text=this.value">${escapeHtml(cu.text)}</textarea>
    ${cu.err?`<div class="small" style="color:var(--error);margin-top:6px;">⚠️ ${escapeHtml(cu.err)}</div>`:''}
    <button class="btn btn-primary btn-sm" style="margin-top:8px;" ${cu.busy?'disabled':''} onclick="cuPost()">${cu.busy?'Posting…':'Post update'}</button>
    ${list.filter(u=>u.state!=='DELETED').map(u=>`<div style="padding:8px 0;border-top:1px solid var(--border);margin-top:8px;"><div style="white-space:pre-wrap;">${escapeHtml(u.text)}</div><div class="text-2 small">${escapeHtml(new Date(u.createdAtMs).toLocaleDateString())}${u.state==='HIDDEN'?' · hidden by NOVA':''} · <a href="#" onclick="cuDelete('${escapeHtml(u.id)}');return false;">Delete</a></div></div>`).join('')}
  </div>`;
}
function creatorMoreTab(){
  if(!cx.profile && !cx.error){ cxLoad(); return '<div class="text-2 small" style="padding:20px;text-align:center;">Loading…</div>'; }
  if(cx.error && !cx.profile) return `<div class="card" style="padding:16px;"><p class="text-2 small" style="color:var(--error);">⚠️ ${escapeHtml(cx.error)}</p><button class="btn btn-outline" onclick="cx.error='';cxLoad(true);render();">Retry</button></div>`;
  const p = cx.profile, pol = cx.policies || {}, f = cx.form || {};
  const notes = (cx.notes && cx.notes.notifications) || [];
  const unread = cx.notes ? cx.notes.unreadCount : 0;
  const open = (cx.disputes||[]).filter(d=>d.status==='OPEN').length;
  const aoDt = v => { try{ return v ? new Date(v).toLocaleString() : ''; }catch(e){ return ''; } };
  return cuCardHtml() + `
  <div class="card" style="padding:16px;margin-bottom:14px;">
    <h3 style="font-size:15px;margin-bottom:8px;">Public profile</h3>
    <div class="text-2 small" style="margin-bottom:8px;">${escapeHtml(p.displayName)}${p.verified?' · verified':''}. Your name and status come from your approved application.</div>
    <div class="form-field"><label>Username (your public page link)</label><input class="input" maxlength="25" value="${escapeHtml(f.username)}" placeholder="e.g. ada_books" oninput="cxField('username',this.value)"></div>
    <div class="form-field"><label>Tagline</label><input class="input" maxlength="100" value="${escapeHtml(f.tagline)}" oninput="cxField('tagline',this.value)"></div>
    <div class="form-field"><label>About you</label><textarea class="input" rows="4" maxlength="500" oninput="cxField('bio',this.value)">${escapeHtml(f.bio)}</textarea></div>
    ${cx.error?`<div class="small" style="color:var(--error);margin-bottom:6px;">⚠️ ${escapeHtml(cx.error)}</div>`:''}${cx.info?`<div class="small" style="color:#2ee6a6;margin-bottom:6px;">✓ ${escapeHtml(cx.info)}</div>`:''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" ${cx.busy?'disabled':''} onclick="cxSaveProfile()">${cx.busy?'Saving…':'Save profile'}</button>
    ${p.username?`<button class="btn btn-outline btn-sm" onclick="navigate('#seller/${escapeHtml(p.username)}')">View my page</button><button class="btn btn-outline btn-sm" onclick="cxCopyLink()">Copy link</button>`:''}</div>
  </div>

  <div class="card" style="padding:16px;margin-bottom:14px;">
    <div style="display:flex;justify-content:space-between;align-items:center;"><h3 style="font-size:15px;">Notifications ${unread?`<span class="chip" style="font-size:10px;">${unread} new</span>`:''}</h3>${unread?`<button class="btn btn-outline btn-sm" onclick="cxMarkRead()">Mark all read</button>`:''}</div>
    ${notes.length ? notes.slice(0,30).map(n=>`<div style="padding:8px 0;border-bottom:1px solid var(--border,#2a2a2a);${n.read?'opacity:.65;':''}"><div style="font-weight:${n.read?'500':'700'};">${escapeHtml(n.title||n.type||'Notice')}</div><div class="text-2 small">${escapeHtml(String(n.message||n.detail||'').slice(0,300))}</div><div class="text-2 small" style="opacity:.6;">${escapeHtml(aoDt(n.createdAtMs))}</div></div>`).join('') : '<div class="text-2 small" style="margin-top:8px;">Nothing yet.</div>'}
  </div>

  <div class="card" style="padding:16px;margin-bottom:14px;">
    <h3 style="font-size:15px;margin-bottom:8px;">Disputes ${open?`<span class="chip" style="font-size:10px;">${open} open</span>`:''}</h3>
    ${(cx.disputes||[]).length ? cx.disputes.map(d=>disputeThreadHtml(d,'creator')).join('') : '<div class="text-2 small">No disputes. 🎉</div>'}
  </div>

  <div class="card" style="padding:16px;">
    <h3 style="font-size:15px;margin-bottom:8px;">Selling policies</h3>
    <div class="small" style="margin-bottom:8px;"><a href="../legal/creator-terms.html">Creator terms</a> · <a href="../legal/creator-payouts.html">Fees &amp; payouts</a> · <a href="../legal/refunds.html">Refunds &amp; disputes</a> <span class="text-2">(drafts pending review)</span></div>
    <div class="text-2 small" style="line-height:1.7;">
      • NOVA fee: <b>${escapeHtml(String(pol.platformFeePct))}%</b> of the item price (after item discounts, excluding delivery and tax). The rate used is saved with every sale.<br>
      • Payouts: minimum <b>${cwNaira(pol.minWithdrawalNGN)}</b>, withdrawal fee <b>${escapeHtml(String(pol.withdrawalFeePct))}%</b>, one request every <b>${escapeHtml(String(pol.withdrawalCooldownDays))}</b> days (Sundays not counted). Every payout is approved by our team.<br>
      • Physical orders: earnings stay pending until delivery is confirmed, then through the ${escapeHtml(String(pol.protectionDaysAfterDelivery==null?pol.disputeWindowDays:pol.protectionDaysAfterDelivery))}-day buyer-protection period.<br>
      • Other earnings hold: ${pol.holdDays ? `new sales are held for <b>${escapeHtml(String(pol.holdDays))} day(s)</b> before you can withdraw them.` : 'new sales are withdrawable immediately.'}<br>
      • Buyers can open a dispute within <b>${escapeHtml(String(pol.disputeWindowDays))} days</b>. The earning for that order is frozen until our team decides. If a refund is approved, that earning is reversed.<br>
      • Digital items must match their description; physical orders need tracking and are delivered within your stated processing time.<br>
      • Suspended or restricted sellers' listings are hidden from the store.
    </div>
  </div>`;
}

// Draft form state — mirrors editProfileForm's pattern above. Only
// populated once an application exists or the shopper picks a creator
// type; screenCreator() resets it from the server's copy whenever the uid
// changes, same guard resetEditProfileForm uses (shopper._uid check).
let creatorForm = null;
function resetCreatorForm(appData){
  creatorForm = {
    creatorType: (appData && appData.creatorType) || null,
    publicFields: { ...(appData && appData.publicFields) },
    privateFields: { ...(appData && appData.privateFields) },
    socialHandlesText: ((appData && appData.publicFields && appData.publicFields.socialHandles) || []).join('\n'),
    acceptTerms: !!(appData && appData.privateFields && appData.privateFields.acceptedTermsAt),
    profileImagePreview: (appData && appData.publicFields && appData.publicFields.profileImageUrl) || null,
    profileImageUploading: false,
    documents: [],
    errors: [],
    saving: false,
  };
}

function screenCreator(){
  const shopper = window.__fbShopper;
  if(!window.__fbAuthResolved){
    return `<div class="screen"><h1 class="screen-title">Become a Creator</h1><div class="text-2 small">Checking your account…</div></div>`;
  }
  if(!shopper){
    return `<div class="screen"><h1 class="screen-title">Become a Creator</h1>
      <div class="card" style="padding:18px;text-align:center;">
        <div style="font-size:15px;margin-bottom:12px;">Sign in to apply — your application is tied to your LEXDEN NOVA account.</div>
        <button class="btn btn-primary" onclick="navigate('#login')">Sign In</button>
      </div></div>`;
  }
  if(!window.__creatorAppCache && !window.__creatorAppError){
    fetchCreatorApplication().then(d=>{ resetCreatorForm(d && d.status!=='NOT_APPLIED' ? d : null); render(); });
    return `<div class="screen"><h1 class="screen-title">Become a Creator</h1><div class="text-2 small" style="padding:20px;text-align:center;">Loading…</div></div>`;
  }
  if(window.__creatorAppError){
    return `<div class="screen"><h1 class="screen-title">Become a Creator</h1>
      <div class="card" style="padding:16px;">
        <p class="text-2 small" style="color:var(--error);margin-bottom:10px;">⚠️ ${escapeHtml(window.__creatorAppError)}</p>
        <button class="btn btn-outline" onclick="fetchCreatorApplication(true).then(d=>{resetCreatorForm(d);render();})">Retry</button>
      </div></div>`;
  }
  const d = window.__creatorAppCache;
  const status = d && d.status;

  if(!status || status==='NOT_APPLIED'){
    // A type has been picked on the intro screen: show the form (previously
    // the intro was returned again, so the buttons looked dead).
    if(creatorForm && creatorForm.creatorType) return screenCreatorForm(d || {});
    return screenCreatorIntro();
  }
  if(status==='APPLICATION_DRAFT' || status==='CHANGES_REQUESTED'){
    if(!creatorForm) resetCreatorForm(d);
    return screenCreatorForm(d);
  }
  if(status==='SUBMITTED' || status==='IN_REVIEW'){
    return screenCreatorStatus('Your application is being reviewed.', 'We\'ll email you the moment there\'s an update — usually within a few days. No action needed from you right now.', '⏳');
  }
  if(status==='REJECTED'){
    return screenCreatorStatus('Your application wasn\'t approved this time.', d.rejectionReason || 'No reason was given.', '✖️', true);
  }
  if(status==='APPROVED'){
    return screenCreatorHome();
  }
  return screenCreatorIntro();
}

function screenCreatorIntro(){
  return `<div class="screen">
    <h1 class="screen-title">Become a Creator</h1>
    <div class="card" style="padding:20px;margin-bottom:16px;">
      <div style="font-size:15px;line-height:1.6;margin-bottom:16px;">Sell apps, courses, templates, eBooks, software, services — or physical goods — directly on LEXDEN NOVA. Free and paid listings both welcome; this isn't just a paid storefront, and neither is your doorway into it.</div>
    </div>
    <div class="section-head"><h2>Choose how you'll apply</h2></div>
    <div class="card" style="padding:16px;margin-bottom:10px;cursor:pointer;" onclick="pickCreatorType('personal')">
      <div style="font-weight:700;margin-bottom:4px;">Personal Creator</div>
      <div class="text-2 small">You, selling under your own name or a handle. Requires you to be 18+.</div>
    </div>
    <div class="card" style="padding:16px;cursor:pointer;" onclick="pickCreatorType('business')">
      <div style="font-weight:700;margin-bottom:4px;">Business Creator</div>
      <div class="text-2 small">A registered business or brand. Requires at least one business/identity document.</div>
    </div>
  </div>`;
}
function pickCreatorType(type){
  resetCreatorForm(null);
  creatorForm.creatorType = type;
  render();
}
function creatorScreenTitle(){
  const st = window.__creatorAppCache && window.__creatorAppCache.status;
  if(st==='APPROVED') return 'My Creator Account';
  if(st==='SUBMITTED' || st==='IN_REVIEW') return 'Creator Application';
  return 'Become a Creator';
}
function setCreatorTab(t){ creatorTab = t; render(); try{ window.scrollTo(0,0); }catch(e){} }
const cwStatusColor = s => ({PUBLISHED:'#2ee6a6',APPROVED:'#2ee6a6',SUBMITTED:'var(--warn,#d4af37)',IN_REVIEW:'var(--warn,#d4af37)',CHANGES_REQUESTED:'var(--warn,#d4af37)',PAUSED:'#999',DRAFT:'#999',REJECTED:'var(--error)',SUSPENDED:'var(--error)',ARCHIVED:'#999'}[s]||'#999');

window.__resetCreatorWorkspace = function(){ cp = { list:null, loading:false, error:'', form:null, busy:false, formError:'', info:'' }; co = { list:null, loading:false, error:'', shipFor:null, busy:false }; cm = { payout:undefined, wds:null, banks:null, loading:false, error:'', busy:false, cj:undefined, resolved:null }; creatorHome = { data:null, summary:'', loading:false, error:null, aiText:'', aiNote:'', aiBusy:false, aiError:'', question:'', checklist:null, uid:null }; window.__libraryCache = null; window.__myShipments = null; window.__myDisputes = null; cx = { profile:null, policies:null, notes:null, disputes:null, loading:false, error:'', info:'', busy:false, form:null }; ce = { data:null, loading:false, error:'' }; ci = { items:null, loading:false, error:'', busy:false, view:'items', history:null, historyFor:null, preview:null, channels:null, info:'' }; cu = { list:null, text:'', busy:false, err:'', loading:false }; cpView = 'listings'; creatorTab = 'home'; };
function creatorTabBar(){
  const t = (id,label)=>`<button class="chip ${creatorTab===id?'active':''}" style="flex:1;justify-content:center;" onclick="setCreatorTab('${id}')">${label}</button>`;
  return `<div style="display:flex;gap:6px;margin-bottom:14px;">${t('home','🏠 Home')}${t('products','📦 Products')}${t('orders','🚚 Orders')}${t('store','🏪 Store')}${t('earnings','💰 Earnings')}</div>`;
}

/* ---------------- PRODUCTS ---------------- */
const CW_TYPES = [
  ['EBOOK','eBook'],['DIGITAL_DOWNLOAD','Digital download'],['TEMPLATE','Template'],['SOFTWARE','Software'],['COURSE','Course'],
  ['SERVICE','Service'],['PHYSICAL_PRODUCT','Physical product'],['EXTERNAL_ACCESS','External access (link)'],
  ['LIVE_PROGRAM','Live program'],['SUBSCRIPTION','Subscription'],['BUNDLE','Bundle'],
];
let cp = { list:null, loading:false, error:'', form:null, busy:false, formError:'', info:'' };
async function cpLoad(force){
  if(cp.loading || (cp.list && !force)) return;
  cp.loading = true; cp.error = '';
  try{ cp.list = (await capi('/api/creator-products')).products || []; }
  catch(e){ cp.error = creatorErrText(e); }
  cp.loading = false; render();
}
function cpNew(){
  cp.form = { productId:null, status:'DRAFT', f:{ offeringType:'EBOOK', currency:'NGN', images:[], fulfillmentMode:'SELLER_STOCK', modulesText:'' } };
  cp.formError = ''; cp.info = ''; render();
}
async function cpEdit(id){
  cp.busy = true; cp.formError = ''; render();
  try{
    let data = await capi('/api/creator-products?productId='+encodeURIComponent(id));
    let latest = (data.versions||[]).find(v=>v.id===data.product.latestVersionId) || (data.versions||[]).slice(-1)[0];
    if(!latest || latest.status !== 'DRAFT'){
      if(!confirm('This listing is not editable right now. Start a new edited version? (It goes through review again before buyers see the change.)')){ cp.busy=false; render(); return; }
      await capi('/api/creator-products', { action:'create_new_version', productId:id });
      data = await capi('/api/creator-products?productId='+encodeURIComponent(id));
      latest = (data.versions||[]).find(v=>v.id===data.product.latestVersionId) || (data.versions||[]).slice(-1)[0];
    }
    const f = { ...(latest.fields||{}) };
    f.images = Array.isArray(f.images) ? f.images.slice() : [];
    f.modulesText = Array.isArray(f.modules) ? f.modules.map(m=>m.title).join('\n') : '';
    cp.form = { productId:id, status:data.product.status, f, hasFile: !!f.fileAssetId };
  }catch(e){ cp.formError = creatorErrText(e); toast(cp.formError,'error'); }
  cp.busy = false; render();
}
function cpSet(k,v){ if(cp.form) cp.form.f[k] = v; }
function cpSetNum(k,v){ if(cp.form){ const n = v===''?undefined:Number(v); cp.form.f[k] = Number.isFinite(n)?n:undefined; } }
function cpRerender(k,v){ cpSet(k,v); render(); }
function cpPayload(){
  const f = { ...cp.form.f }; const out = {};
  const keys = ['title','description','category','images','price','currency','isFree','refundPolicy','stock','weightGrams','shippingOrigin','fulfillmentMode','supplierName','processingDays','fileAssetId','externalUrl','systemRequirements','pageCount','compatibility','level','turnaround','deliverables','billingInterval'];
  for(const k of keys){ if(f[k] !== undefined && f[k] !== '' ) out[k] = f[k]; }
  if(f.isFree) { out.isFree = true; delete out.price; }
  if(f.offeringType === 'COURSE'){ out.modules = String(f.modulesText||'').split('\n').map(s=>s.trim()).filter(Boolean).map(title=>({title})); }
  if(f.offeringType !== 'PHYSICAL_PRODUCT'){ delete out.fulfillmentMode; }
  return out;
}
async function cpSave(thenSubmit){
  if(!cp.form || cp.busy) return false;
  cp.busy = true; cp.formError = ''; cp.info = ''; render();
  try{
    const body = cpPayload();
    if(!cp.form.productId){
      const r = await capi('/api/creator-products', { action:'create_draft', offeringType: cp.form.f.offeringType, ...body });
      cp.form.productId = r.productId;
    } else {
      await capi('/api/creator-products', { action:'update_draft', productId: cp.form.productId, ...body });
    }
    if(thenSubmit){
      await capi('/api/creator-products', { action:'submit', productId: cp.form.productId });
      toast('Submitted for review','success'); cp.form = null; cp.list = null; cpLoad(true);
    } else { cp.info = 'Draft saved.'; toast('Draft saved','success'); cp.list = null; cpLoad(true); }
    cp.busy = false; render(); return true;
  }catch(e){ cp.formError = creatorErrText(e); cp.busy = false; render(); return false; }
}
async function cpProductAction(id, action){
  const labels = { pause:'Pause this listing? Buyers will no longer see it.', resume:'Put this listing back on sale?', archive:'Archive this listing? This cannot be undone.' };
  if(labels[action] && !confirm(labels[action])) return;
  try{ await capi('/api/creator-products', { action, productId:id }); toast('Done','success'); cp.list = null; cpLoad(true); }
  catch(e){ toast(creatorErrText(e),'error'); }
}
async function cpAddImage(input){
  const file = input.files && input.files[0]; if(!file) return;
  if(!/^image\//.test(file.type)){ toast('Choose an image','error'); return; }
  if((cp.form.f.images||[]).length >= 8){ toast('8 images max','error'); return; }
  toast('Uploading image…','info');
  try{ const url = await cloudinaryUploadFile(file, 8); cp.form.f.images = [...(cp.form.f.images||[]), url]; render(); }
  catch(e){ toast('Image upload failed — '+(e.message||'try again'),'error'); }
  input.value = '';
}
function cpAddImageUrl(){
  const el = document.getElementById('cpImgUrl'); const u = el ? el.value.trim() : '';
  if(!/^https:\/\/\S+$/i.test(u)){ toast('Paste a full https:// image link','error'); return; }
  cp.form.f.images = [...(cp.form.f.images||[]), u].slice(0,8); render();
}
function cpRemoveImage(i){ cp.form.f.images.splice(i,1); render(); }
async function cpUploadFile(input){
  const file = input.files && input.files[0]; if(!file) return;
  if(file.size > 8*1024*1024){ toast('File too large — 8MB max for now','error'); input.value=''; return; }
  if(!cp.form.productId){ const ok = await cpSave(false); if(!ok) return; }
  toast('Uploading file…','info');
  const reader = new FileReader();
  reader.onload = async e=>{
    try{
      const base64 = String(e.target.result).split(',')[1] || '';
      const r = await capi('/api/creator-product-assets', { productId: cp.form.productId, fileBase64: base64, fileName: file.name, mimeType: file.type }, 60000);
      cp.form.f.fileAssetId = r.assetId; cp.form.fileName = file.name;
      await capi('/api/creator-products', { action:'update_draft', productId: cp.form.productId, fileAssetId: r.assetId });
      toast('File uploaded','success');
    }catch(err){ toast(creatorErrText(err),'error'); }
    render();
  };
  reader.readAsDataURL(file);
}
function cpField(label, html, hint){ return `<div class="form-field"><label>${label}</label>${html}${hint?`<div class="text-2 small" style="margin-top:3px;">${hint}</div>`:''}</div>`; }
function cpText(k, ph, type){ const v = cp.form.f[k]; return `<input type="${type||'text'}" value="${escapeHtml(v===undefined?'':v)}" placeholder="${escapeHtml(ph||'')}" oninput="${type==='number'?`cpSetNum('${k}',this.value)`:`cpSet('${k}',this.value)`}">`; }
function cpArea(k, ph, rows){ return `<textarea rows="${rows||4}" placeholder="${escapeHtml(ph||'')}" oninput="cpSet('${k}',this.value)" style="width:100%;">${escapeHtml(cp.form.f[k]||'')}</textarea>`; }
function creatorProductForm(){
  const F = cp.form, f = F.f, t = f.offeringType;
  const cats = (DB.categories||[]).filter(c=>c.id!=='all');
  const isDigitalFile = ['DIGITAL_DOWNLOAD','SOFTWARE','EBOOK','TEMPLATE','BUNDLE'].includes(t);
  const needsAccess = ['EXTERNAL_ACCESS','LIVE_PROGRAM','SUBSCRIPTION','BUNDLE','DIGITAL_DOWNLOAD','SOFTWARE','EBOOK','TEMPLATE'].includes(t);
  return `<div class="card" style="padding:16px;margin-bottom:14px;">
    <div style="display:flex;justify-content:space-between;align-items:center;"><h3 style="font-size:16px;">${F.productId?'Edit listing':'New listing'}</h3><button class="btn btn-outline btn-sm" onclick="cp.form=null;render();">Close</button></div>
    ${cpField('What are you selling?', F.productId ? `<div class="text-2 small">${escapeHtml((CW_TYPES.find(x=>x[0]===t)||[0,t])[1])} (cannot be changed)</div>` : `<select onchange="cpRerender('offeringType',this.value)">${CW_TYPES.map(([v,l])=>`<option value="${v}" ${v===t?'selected':''}>${l}</option>`).join('')}</select>`)}
    ${cpField('Title', cpText('title','Clear name of what the buyer gets'))}
    ${cpField('Description', cpArea('description','What it is, who it is for, what is included. Use short lines.',6))}
    ${cpField('Category', `<select onchange="cpSet('category',this.value)"><option value="">Choose…</option>${cats.map(c=>`<option value="${escapeHtml(c.name)}" ${String(f.category||'').toLowerCase()===String(c.name).toLowerCase()?'selected':''}>${escapeHtml(c.name)}</option>`).join('')}</select>`)}
    ${cpField('Images (first one is the cover)', `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;">${(f.images||[]).map((u,i)=>`<div style="position:relative;"><img src="${escapeHtml(u)}" style="width:64px;height:64px;object-fit:cover;border-radius:8px;"><button onclick="cpRemoveImage(${i})" style="position:absolute;top:-6px;right:-6px;border:0;border-radius:50%;width:20px;height:20px;background:var(--error);color:#fff;">×</button></div>`).join('')}</div>
      <input type="file" accept="image/*" onchange="cpAddImage(this)">
      <div style="display:flex;gap:6px;margin-top:6px;"><input id="cpImgUrl" type="url" placeholder="or paste an https:// image link" style="flex:1;"><button class="btn btn-outline btn-sm" onclick="cpAddImageUrl()">Add</button></div>`)}
    <div style="display:flex;gap:10px;align-items:flex-end;">
      <div style="flex:2;">${cpField('Price (₦ Naira)', f.isFree?'<div class="text-2 small">Free listing</div>':cpText('price','e.g. 5000','number'))}</div>
      <label style="flex:1;font-size:13px;display:flex;gap:6px;align-items:center;padding-bottom:14px;"><input type="checkbox" ${f.isFree?'checked':''} onchange="cpRerender('isFree',this.checked)"> Free</label>
    </div>
    ${cpField('Refund / return policy', cpArea('refundPolicy','e.g. Refunds within 7 days if the file is corrupted.',2))}
    ${t==='PHYSICAL_PRODUCT' ? `
      ${cpField('How will you fulfil orders?', `<select onchange="cpRerender('fulfillmentMode',this.value)"><option value="SELLER_STOCK" ${f.fulfillmentMode!=='MANUAL_SUPPLIER'?'selected':''}>I ship from my own stock</option><option value="MANUAL_SUPPLIER" ${f.fulfillmentMode==='MANUAL_SUPPLIER'?'selected':''}>I order from my supplier and ship it myself</option></select>`, 'CJ Dropshipping listings are set up through the Claude connector (see Home).')}
      ${f.fulfillmentMode==='MANUAL_SUPPLIER' ? cpField('Supplier name', cpText('supplierName','Who you order from')) : `${cpField('Stock quantity', cpText('stock','e.g. 20','number'))}${cpField('Package weight (grams)', cpText('weightGrams','e.g. 500','number'))}${cpField('Shipping from (city/country)', cpText('shippingOrigin','e.g. Lagos, Nigeria'))}`}
      ${cpField('Days you need to dispatch', cpText('processingDays','1–30','number'), 'Your shipping deadline is 48h, or longer if you set more days here.')}` : ''}
    ${t==='SOFTWARE' ? cpField('System requirements', cpText('systemRequirements','e.g. Windows 10+, 4GB RAM')) : ''}
    ${t==='EBOOK' ? cpField('Page count', cpText('pageCount','e.g. 120','number')) : ''}
    ${t==='TEMPLATE' ? cpField('Compatible with', cpText('compatibility','e.g. Figma, Notion, Word')) : ''}
    ${t==='COURSE' ? `${cpField('Skill level', `<select onchange="cpSet('level',this.value)"><option value="">Choose…</option>${['Beginner','Intermediate','Advanced','All levels'].map(l=>`<option ${f.level===l?'selected':''}>${l}</option>`).join('')}</select>`)}${cpField('Modules (one per line)', cpArea('modulesText','Module 1 title\nModule 2 title',5))}` : ''}
    ${t==='SERVICE' ? `${cpField('Turnaround time', cpText('turnaround','e.g. 3 days'))}${cpField('What do you deliver?', cpArea('deliverables','e.g. 3 logo concepts + source files',3))}` : ''}
    ${t==='SUBSCRIPTION' ? cpField('Billing interval', cpText('billingInterval','e.g. monthly')) : ''}
    ${t!=='PHYSICAL_PRODUCT' && t!=='SERVICE' && t!=='COURSE' || t==='COURSE' ? `
      <div style="border-top:1px solid var(--border);margin:10px 0;padding-top:10px;"><strong>What the buyer receives after paying</strong></div>
      ${isDigitalFile ? cpField('Upload a file (PDF, ZIP, EPUB, DOC — 8MB max)', `<input type="file" onchange="cpUploadFile(this)">${f.fileAssetId?`<div class="small" style="color:#2ee6a6;margin-top:4px;">✓ File attached${F.fileName?': '+escapeHtml(F.fileName):''}</div>`:''}`, 'Stored privately; only buyers can download it.') : ''}
      ${needsAccess || t==='COURSE' ? cpField(isDigitalFile?'…or an access / delivery link':'Access link (course site, community, meeting…)', cpText('externalUrl','https://…','url'), 'Only shown to people who bought it. We re-check that it still works.') : ''}` : ''}
    ${cp.formError ? `<div class="small" style="color:var(--error);margin:10px 0;">⚠️ ${escapeHtml(cp.formError)}</div>` : ''}
    ${cp.info ? `<div class="small" style="color:#2ee6a6;margin:10px 0;">${escapeHtml(cp.info)}</div>` : ''}
    <div style="display:flex;gap:8px;margin-top:12px;">
      <button class="btn btn-outline" style="flex:1;" ${cp.busy?'disabled':''} onclick="cpSave(false)">${cp.busy?'Working…':'Save draft'}</button>
      <button class="btn btn-primary" style="flex:1;" ${cp.busy?'disabled':''} onclick="if(confirm('Submit for review? You can\\'t edit it while it is being reviewed.'))cpSave(true)">Submit for review</button>
    </div>
  </div>`;
}
function creatorProductsTab(){
  const sub = `<div style="display:flex;gap:6px;margin-bottom:12px;"><button class="chip ${cpView==='listings'?'active':''}" style="flex:1;justify-content:center;" onclick="cpView='listings';render();">Listings</button><button class="chip ${cpView==='inventory'?'active':''}" style="flex:1;justify-content:center;" onclick="cpView='inventory';render();">Inventory</button></div>`;
  if(cpView==='inventory' && !cp.form) return sub + creatorInventoryHub();
  return (cp.form ? '' : sub) + creatorListingsTab();
}
function creatorListingsTab(){
  if(!cp.list && !cp.error){ cpLoad(); return '<div class="text-2 small" style="padding:20px;text-align:center;">Loading your listings…</div>'; }
  if(cp.error && !cp.list) return `<div class="card" style="padding:16px;"><p class="text-2 small" style="color:var(--error);">⚠️ ${escapeHtml(cp.error)}</p><button class="btn btn-outline" onclick="cp.error='';cpLoad(true);render();">Retry</button></div>`;
  if(cp.form) return creatorProductForm();
  const rows = cp.list.map(p=>{
    const snap = p.publishedSnapshot || {};
    const title = snap.title || '(untitled draft)';
    const reason = p.changeRequestReason || p.rejectionReason || p.pauseReason;
    return `<div class="card" style="padding:12px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start;"><strong>${escapeHtml(title)}</strong><span class="chip" style="font-size:10px;background:${cwStatusColor(p.status)};color:#111;">${escapeHtml(p.status)}</span></div>
      <div class="text-2 small">${escapeHtml((CW_TYPES.find(x=>x[0]===p.offeringType)||[0,p.offeringType||''])[1])}${snap.price?` · ${cwNaira(snap.price)}`:''}</div>
      ${reason?`<div class="small" style="margin-top:6px;color:var(--warn,#d4af37);">${escapeHtml(reason)}</div>`:''}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
        ${['DRAFT','CHANGES_REQUESTED','REJECTED','PUBLISHED','PAUSED'].includes(p.status)?`<button class="btn btn-outline btn-sm" onclick="cpEdit('${escapeHtml(p.id)}')">Edit</button>`:''}
        ${p.status==='PUBLISHED'?`<button class="btn btn-outline btn-sm" onclick="cpProductAction('${escapeHtml(p.id)}','pause')">Pause</button>`:''}
        ${p.status==='PAUSED'?`<button class="btn btn-primary btn-sm" onclick="cpProductAction('${escapeHtml(p.id)}','resume')">Resume</button>`:''}
        ${['PUBLISHED','PAUSED'].includes(p.status)?`<button class="btn btn-outline btn-sm" onclick="cpProductAction('${escapeHtml(p.id)}','archive')">Archive</button>`:''}
      </div></div>`;
  }).join('');
  return `<button class="btn btn-primary btn-block" style="margin-bottom:12px;" onclick="cpNew()">+ Add a listing</button>
    ${rows || '<div class="card" style="padding:18px;text-align:center;"><div class="text-2 small">No listings yet. Add your first one — every listing is reviewed before buyers see it.</div></div>'}
    <div class="text-2 small" style="margin-top:8px;">Listings are reviewed by LEXDEN NOVA before they go live.</div>`;
}


/* ---------------- INVENTORY HUB ----------------
   Stock numbers come from the server ledger (api/creator-inventory). The browser never computes
   availability. Every change sends a fresh idempotency key so a double tap cannot apply twice. */
let cpView = 'listings';
let ci = { items:null, loading:false, error:'', busy:false, view:'items', history:null, historyFor:null, preview:null, channels:null, info:'' };
const ciKey = ()=> 'ui_'+Date.now().toString(36)+Math.random().toString(36).slice(2,10);
async function ciLoad(force){
  if(ci.loading || (ci.items && !force)) return;
  ci.loading = true; ci.error = '';
  try{ ci.items = (await capi('/api/creator-inventory')).items || []; }catch(e){ ci.error = creatorErrText(e); }
  ci.loading = false; render();
}
async function ciAct(itemId, type, extra){
  if(ci.busy) return; ci.busy = true; ci.error = ''; ci.info = ''; render();
  try{ await capi('/api/creator-inventory', { action:'adjust', itemId, type, idempotencyKey: ciKey(), ...extra }); ci.info = 'Saved.'; ci.items = null; ci.history = null; }
  catch(e){ ci.error = creatorErrText(e); }
  ci.busy = false; ciLoad(true); render();
}
function ciPrompt(itemId, type){
  const labels = { EXTERNAL_SALE:'How many did you sell elsewhere (market, Instagram, WhatsApp)?', RESTOCK:'How many units did you add?', COUNT_CORRECTION:'What is the real number you counted on the shelf?', MARK_UNAVAILABLE:'How many are damaged or lost?', RESTORE_AVAILABLE:'How many are usable again?', RETURN_TO_STOCK:'How many returned items are in resellable condition?' };
  const v = prompt(labels[type] || 'Quantity'); if(v===null) return;
  const n = Number(v); if(!Number.isInteger(n) || n < 0 || (type!=='COUNT_CORRECTION' && n < 1)){ toast('Enter a whole number','error'); return; }
  if(type==='COUNT_CORRECTION') return ciAct(itemId, type, { countedOnHand:n, channel:'MANUAL' });
  if(type==='MARK_UNAVAILABLE'){ const r = (prompt('Reason: DAMAGED, LOST, QUARANTINED, EXPIRED or OTHER','DAMAGED')||'').toUpperCase(); return ciAct(itemId, type, { quantity:n, reason:r }); }
  if(type==='RETURN_TO_STOCK'){ if(!confirm('Confirm these items are in resellable condition and can go back on sale.')) return; return ciAct(itemId, type, { quantity:n, resellableConfirmed:true }); }
  if(type==='EXTERNAL_SALE'){ const ch = (prompt('Where? MARKET_STALL, INSTAGRAM, WHATSAPP or OTHER','MARKET_STALL')||'OTHER').toUpperCase(); return ciAct(itemId, type, { quantity:n, channel:ch }); }
  return ciAct(itemId, type, { quantity:n });
}
function ciSafety(itemId){
  const v = prompt('Safety stock: how many units should NOT be sold (a buffer)?'); if(v===null) return;
  const n = Number(v); if(!Number.isInteger(n) || n < 0){ toast('Enter a whole number','error'); return; }
  ciAct(itemId, 'SAFETY_STOCK_CHANGE', { safetyStock:n });
}
async function ciShowHistory(itemId){
  ci.historyFor = itemId; ci.history = null; render();
  try{ ci.history = (await capi('/api/creator-inventory?history=1&itemId='+encodeURIComponent(itemId))).movements || []; }catch(e){ ci.error = creatorErrText(e); }
  render();
}
async function ciPreviewCsv(){
  const csv = (document.getElementById('ciCsv')||{}).value || '';
  ci.busy = true; render();
  try{ ci.preview = await capi('/api/creator-inventory', { action:'import_preview', csv }); ci.csv = csv; }catch(e){ ci.error = creatorErrText(e); }
  ci.busy = false; render();
}
async function ciCommitCsv(skip){
  ci.busy = true; render();
  try{ const r = await capi('/api/creator-inventory', { action:'import_commit', csv:ci.csv, importId:ciKey(), skipInvalid:!!skip }); ci.info = r.refused ? 'Nothing was changed. Fix the rows marked in red, or choose to skip them.' : `Applied ${r.applied} row(s).`; if(!r.refused){ ci.preview = null; ci.items = null; } }
  catch(e){ ci.error = creatorErrText(e); }
  ci.busy = false; ciLoad(true); render();
}
async function ciLoadChannels(){
  if(ci.channels) return;
  try{ ci.channels = (await capi('/api/creator-inventory?channels=1')).listings || []; }catch(e){ ci.channels = []; }
  render();
}
function creatorInventoryHub(){
  if(!ci.items && !ci.error){ ciLoad(); return '<div class="text-2 small" style="padding:20px;text-align:center;">Loading your stock…</div>'; }
  const tabs = ['items','import','channels'].map(v=>`<button class="chip ${ci.view===v?'active':''}" onclick="ci.view='${v}';${v==='channels'?'ciLoadChannels();':''}render();">${{items:'Stock',import:'Import CSV',channels:'Other channels'}[v]}</button>`).join(' ');
  const msg = (ci.error?`<div class="small" style="color:var(--error);margin-bottom:8px;">⚠️ ${escapeHtml(ci.error)}</div>`:'') + (ci.info?`<div class="small" style="color:#2ee6a6;margin-bottom:8px;">✓ ${escapeHtml(ci.info)}</div>`:'');
  let body = '';
  if(ci.view==='items'){
    const chip = st => ({OK:['In stock','#2ee6a6'],LOW:['Low','var(--warn,#d4af37)'],OUT_OF_STOCK:['Out of stock','var(--error)']}[st]||['',''] );
    body = (ci.items||[]).map(it=>{ const c = chip(it.status); const b = (t,l)=>`<button class="btn btn-outline btn-sm" ${ci.busy?'disabled':''} onclick="ciPrompt('${escapeHtml(it.id)}','${t}')">${l}</button>`;
      return `<div class="card" style="padding:12px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;gap:8px;"><strong>${escapeHtml(it.productTitle||it.productId)}</strong><span class="chip" style="font-size:10px;background:${c[1]};color:#111;">${c[0]}</span></div>
      <div class="text-2 small">${escapeHtml(it.variantKey==='default'?'':it.variantKey+' · ')}${escapeHtml(it.locationId==='main'?'Main stock':it.locationId)}${it.sku?' · SKU '+escapeHtml(it.sku):''}</div>
      <div style="display:flex;gap:14px;margin:8px 0;flex-wrap:wrap;"><div><div style="font-size:22px;font-weight:800;">${it.availableToSell}</div><div class="text-2 small">available to sell</div></div><div><div style="font-size:16px;">${it.onHand}</div><div class="text-2 small">on hand</div></div><div><div style="font-size:16px;">${it.reserved}</div><div class="text-2 small">reserved</div></div>${it.unavailable?`<div><div style="font-size:16px;">${it.unavailable}</div><div class="text-2 small">unavailable</div></div>`:''}${it.safetyStock?`<div><div style="font-size:16px;">${it.safetyStock}</div><div class="text-2 small">safety stock</div></div>`:''}</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;">${b('EXTERNAL_SALE','Sold elsewhere')}${b('RESTOCK','Add stock')}${b('COUNT_CORRECTION','Recount')}${b('MARK_UNAVAILABLE','Damaged / lost')}${it.unavailable?b('RESTORE_AVAILABLE','Usable again'):''}${b('RETURN_TO_STOCK','Returned item')}<button class="btn btn-outline btn-sm" onclick="ciSafety('${escapeHtml(it.id)}')">Safety stock</button><button class="btn btn-outline btn-sm" onclick="ciShowHistory('${escapeHtml(it.id)}')">History</button></div>
      ${ci.historyFor===it.id ? (ci.history ? (ci.history.length ? `<div style="margin-top:8px;border-top:1px solid var(--border,#2a2a2a);padding-top:6px;">${ci.history.slice(0,15).map(m=>`<div class="text-2 small">${escapeHtml(new Date(m.atMs).toLocaleString())} · ${escapeHtml(m.type)}${m.quantity!=null?' '+m.quantity:''} · ${m.before.availableToSell}→${m.after.availableToSell} · ${escapeHtml(m.channel||'')}</div>`).join('')}</div>` : '<div class="text-2 small" style="margin-top:6px;">No changes yet.</div>') : '<div class="text-2 small">Loading…</div>') : ''}
    </div>`; }).join('') || '<div class="card" style="padding:18px;text-align:center;"><div class="text-2 small">No stock-tracked listings yet. Published physical listings you ship yourself appear here. Listings from CJ, digital files and services do not use unit stock.</div></div>';
    body += '<div class="text-2 small" style="margin-top:8px;">These numbers are the single source of truth for what buyers can order. Changing stock never needs a new review.</div>';
  } else if(ci.view==='import'){
    const pv = ci.preview;
    body = `<div class="card" style="padding:14px;"><div class="text-2 small" style="margin-bottom:6px;">Paste a CSV with the columns <b>sku,quantity,mode</b>. mode is SET (what you counted) or ADD (new stock received). SKUs must match exactly; similar names are never guessed. Nothing changes until you confirm.</div>
      <textarea id="ciCsv" rows="6" style="width:100%;" placeholder="sku,quantity,mode&#10;SHOE-RED-42,12,SET">${escapeHtml(ci.csv||'')}</textarea>
      <button class="btn btn-outline btn-sm" style="margin-top:8px;" ${ci.busy?'disabled':''} onclick="ciPreviewCsv()">Check file</button>
      ${pv ? (pv.ok ? `<div style="margin-top:10px;">${pv.rows.map(r=>`<div class="small" style="color:${r.valid?'inherit':'var(--error)'};">Line ${r.line}: ${escapeHtml(r.sku||'(empty)')} → ${r.valid?`${escapeHtml(r.mode)} ${r.quantity} ✓`:escapeHtml(r.errors.join(' '))}</div>`).join('')}
        <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;">${pv.invalidCount===0?`<button class="btn btn-primary btn-sm" ${ci.busy?'disabled':''} onclick="ciCommitCsv(false)">Apply ${pv.validCount} row(s)</button>`:`<button class="btn btn-outline btn-sm" ${ci.busy||!pv.validCount?'disabled':''} onclick="ciCommitCsv(true)">Apply ${pv.validCount} good row(s), skip ${pv.invalidCount} bad</button>`}</div></div>` : `<div class="small" style="color:var(--error);margin-top:8px;">${escapeHtml((pv.fileProblems||[]).join(' '))}</div>`) : ''}</div>`;
  } else {
    const ch = ci.channels;
    body = `<div class="card" style="padding:14px;margin-bottom:8px;"><div class="small" style="line-height:1.6;">LEXDEN NOVA does <b>not</b> automatically sync with Instagram, WhatsApp, marketplaces or market stalls. When you sell elsewhere, tap <b>Sold elsewhere</b> on the stock card or import a CSV so NOVA never sells something you no longer have. Mapping a listing below only records which of your products it is; it does not sync anything.</div></div>
      ${ch===null?'<div class="text-2 small">Loading…</div>':(ch.length?ch.map(l=>`<div class="card" style="padding:10px;margin-bottom:6px;"><strong>${escapeHtml(l.channel)} · ${escapeHtml(l.title||l.externalId)}</strong><div class="text-2 small">${escapeHtml(l.mappingStatus)} · ${escapeHtml((l.health||{}).message||'')}</div></div>`).join(''):'<div class="text-2 small">No other channels recorded.</div>')}`;
  }
  return `<div style="display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;">${tabs}</div>${msg}${body}`;
}

/* ---------------- ORDERS ---------------- */
let co = { list:null, loading:false, error:'', shipFor:null, busy:false };
async function coLoad(force){
  if(co.loading || (co.list && !force)) return;
  co.loading = true; co.error = '';
  try{ co.list = (await capi('/api/creator-fulfillments')).fulfillments || []; }
  catch(e){ co.error = creatorErrText(e); }
  co.loading = false; render();
}
async function coAction(orderId, action, extra){
  if(co.busy) return; co.busy = true; render();
  try{ await capi('/api/creator-fulfillments', { orderId, action, ...(extra||{}) }); toast('Updated','success'); co.shipFor = null; co.list = null; coLoad(true); }
  catch(e){ toast(creatorErrText(e),'error'); }
  co.busy = false; render();
}
function coShip(orderId){
  const carrier = (document.getElementById('coCarrier')||{}).value || '';
  const trackingNumber = (document.getElementById('coTrack')||{}).value || '';
  const trackingUrl = (document.getElementById('coUrl')||{}).value || '';
  coAction(orderId, 'mark_shipped', { carrier: carrier.trim(), trackingNumber: trackingNumber.trim(), ...(trackingUrl.trim()?{trackingUrl:trackingUrl.trim()}:{}) });
}
function coCancel(orderId){
  const reason = prompt('Why are you cancelling this order? (the buyer is told)'); if(reason===null) return;
  if(!reason.trim()){ toast('A reason is required','error'); return; }
  coAction(orderId, 'cancel', { reason: reason.trim() });
}
function creatorOrdersTab(){
  if(!co.list && !co.error){ coLoad(); return '<div class="text-2 small" style="padding:20px;text-align:center;">Loading your orders…</div>'; }
  if(co.error && !co.list) return `<div class="card" style="padding:16px;"><p class="text-2 small" style="color:var(--error);">⚠️ ${escapeHtml(co.error)}</p><button class="btn btn-outline" onclick="co.error='';coLoad(true);render();">Retry</button></div>`;
  if(!co.list.length) return '<div class="card" style="padding:18px;text-align:center;"><div class="text-2 small">No physical orders yet. When someone buys a physical listing, it appears here and you ship it.</div></div>';
  const slaChip = s => !s ? '' : `<span class="chip" style="font-size:10px;background:${s.overall==='BREACHED'?'var(--error)':s.overall==='AT_RISK'?'var(--warn,#d4af37)':'#2ee6a6'};color:#111;">${escapeHtml(s.overall==='BREACHED'?'Overdue':s.overall==='AT_RISK'?'Due soon':'On track')}</span>`;
  return co.list.map(f=>{
    const d = f.delivery || {};
    const open = ['PENDING','PACKED'].includes(f.status);
    return `<div class="card" style="padding:12px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;gap:8px;"><strong>${escapeHtml(f.productTitle||'Order')}</strong><span style="display:flex;gap:4px;"><span class="chip" style="font-size:10px;">${escapeHtml(f.status)}</span>${f.status!=='DELIVERED'&&f.status!=='CANCELLED'?slaChip(f.sla):''}</span></div>
      <div class="text-2 small" style="margin-top:6px;">Ship to: <strong>${escapeHtml(d.name||'')}</strong> · ${escapeHtml(d.phone||'')}<br>${escapeHtml([d.address,d.city,d.state,d.country].filter(Boolean).join(', '))}</div>
      ${f.fulfillmentMode==='CJ_DROPSHIP'?'<div class="small text-2" style="margin-top:4px;">Dropship order — handled through your CJ account.</div>':''}
      ${f.carrier?`<div class="text-2 small">Shipped via ${escapeHtml(f.carrier)} ${escapeHtml(f.trackingNumber||'')}</div>`:''}
      ${co.shipFor===f.id ? `<div style="margin-top:8px;"><input id="coCarrier" placeholder="Carrier (e.g. GIG Logistics, DHL)" style="width:100%;margin-bottom:6px;"><input id="coTrack" placeholder="Tracking number" style="width:100%;margin-bottom:6px;"><input id="coUrl" placeholder="Tracking link (optional)" style="width:100%;margin-bottom:6px;"><div style="display:flex;gap:6px;"><button class="btn btn-primary btn-sm" ${co.busy?'disabled':''} onclick="coShip('${escapeHtml(f.id)}')">Confirm shipped</button><button class="btn btn-outline btn-sm" onclick="co.shipFor=null;render();">Cancel</button></div></div>` : `
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">
        ${f.status==='PENDING' && !f.acknowledgedAtMs ?`<button class="btn btn-outline btn-sm" onclick="coAction('${escapeHtml(f.id)}','acknowledge')">I've seen it</button>`:''}
        ${f.status==='PENDING'?`<button class="btn btn-outline btn-sm" onclick="coAction('${escapeHtml(f.id)}','mark_packed')">Mark packed</button>`:''}
        ${open?`<button class="btn btn-primary btn-sm" onclick="co.shipFor='${escapeHtml(f.id)}';render();">Mark shipped</button>`:''}
        ${open?`<button class="btn btn-outline btn-sm" onclick="coCancel('${escapeHtml(f.id)}')">Cancel</button>`:''}
      </div>`}
    </div>`;
  }).join('');
}

/* ---------------- MONEY ---------------- */
let cm = { payout:undefined, wds:null, banks:null, loading:false, error:'', busy:false, cj:undefined, resolved:null };
async function cmLoad(force){
  if(cm.loading || (cm.wds && !force)) return;
  cm.loading = true; cm.error = '';
  try{
    const [p, w] = await Promise.all([capi('/api/creator-payout-account'), capi('/api/creator-withdraw')]);
    cm.payout = p.payoutAccount || null; cm.wds = w.withdrawals || [];
    try{ cm.cj = await capi('/api/creator-supplier-connection'); }catch(e){ cm.cj = null; }
  }catch(e){ cm.error = creatorErrText(e); }
  cm.loading = false; render();
}
async function cmLoadBanks(){
  if(cm.banks) return;
  try{ const r = await withTimeout(fetch(API_BASE+'/api/affiliate-banks'), 15000, 'Could not load banks.'); const d = await r.json(); cm.banks = (d && d.banks) || []; }
  catch(e){ cm.banks = []; }
  render();
}
async function cmSavePayout(){
  const bankCode = (document.getElementById('cmBank')||{}).value || '';
  const num = ((document.getElementById('cmAcct')||{}).value || '').trim();
  const bank = (cm.banks||[]).find(b=>b.code===bankCode);
  if(!bankCode || !/^\d{10}$/.test(num)){ toast('Choose your bank and enter your 10-digit account number','error'); return; }
  cm.busy = true; render();
  try{ const r = await capi('/api/creator-payout-account', { bankCode, bankName: bank?bank.name:'', accountNumber: num }); cm.payout = r.payoutAccount; cm.editPayout = false; toast('Verified: '+r.payoutAccount.accountName,'success'); }
  catch(e){ toast(creatorErrText(e),'error'); }
  cm.busy = false; render();
}
async function cmWithdraw(){
  const amt = Number((document.getElementById('cmAmt')||{}).value);
  if(!(amt>0)){ toast('Enter an amount','error'); return; }
  const fp = cx.policies && cx.policies.withdrawalFeePct!=null ? Number(cx.policies.withdrawalFeePct) : null;
  const fee = fp==null ? null : Math.round(amt*fp)/100;
  if(!confirm('Request a withdrawal of '+cwNaira(amt)+'?'+(fee==null?' A fee applies.':' Fee '+cwNaira(fee)+' → you receive about '+cwNaira(amt-fee)+'.')+' It is paid after review.')) return;
  cm.busy = true; render();
  try{ const r = await capi('/api/creator-withdraw', { amount: amt }); toast('Requested — you will receive '+cwNaira(r.amountPayable),'success'); cm.wds = null; creatorHome.data = null; ce.data = null; cmLoad(true); }
  catch(e){ toast(creatorErrText(e),'error'); }
  cm.busy = false; render();
}
async function cmConnectCj(){
  const email = ((document.getElementById('cjEmail')||{}).value||'').trim();
  const apiKey = ((document.getElementById('cjKey')||{}).value||'').trim();
  if(!email || !apiKey){ toast('Enter your CJ email and API key','error'); return; }
  cm.busy = true; render();
  try{ await capi('/api/creator-supplier-connection', { action:'connect', email, apiKey }, 40000); toast('CJ connected','success'); cm.cj = null; cm.wds = null; cmLoad(true); }
  catch(e){ toast(creatorErrText(e),'error'); }
  cm.busy = false; render();
}
async function cmDisconnectCj(){
  if(!confirm('Disconnect your CJ account? Your dropship listings will stop working until you reconnect.')) return;
  try{ await capi('/api/creator-supplier-connection', { action:'disconnect' }); toast('Disconnected','success'); cm.cj = null; cm.wds = null; cmLoad(true); }
  catch(e){ toast(creatorErrText(e),'error'); }
}

let ce = { data:null, loading:false, error:'' };
async function ceLoad(force){
  if(ce.loading || (ce.data && !force)) return;
  ce.loading = true; ce.error = '';
  try{ ce.data = await capi('/api/creator-earnings'); }catch(e){ ce.error = creatorErrText(e); }
  ce.loading = false; render();
}
function creatorEarningsBreakdown(){
  if(!ce.data && !ce.error){ ceLoad(); return '<div class="text-2 small" style="padding:10px;text-align:center;">Loading your earnings…</div>'; }
  if(ce.error) return `<div class="small" style="color:var(--error);margin-bottom:8px;">⚠️ ${escapeHtml(ce.error)}</div>`;
  const s = ce.data.summary, pol = ce.data.policy;
  const cell = (label, v, hint) => `<div class="card" style="padding:10px;"><div class="text-2 small">${label}</div><div style="font-size:18px;font-weight:800;">${cwNaira(v)}</div><div class="text-2 small" style="font-size:11px;">${hint}</div></div>`;
  const rows = (ce.data.recent||[]).map(x=>`<div class="list-row" style="align-items:flex-start;"><span class="left" style="flex-direction:column;align-items:flex-start;"><span>${escapeHtml(x.productTitle||x.orderId)}</span><span class="text-2 small">Sale ${cwNaira(x.saleAmount)} − ${escapeHtml(String(x.feePct))}% NOVA fee ${cwNaira(x.feeAmount)} = <b>${cwNaira(x.creatorEarning)}</b></span>${x.whyPending?`<span class="small" style="color:var(--warn,#d4af37);">${escapeHtml(x.whyPending)}</span>`:''}</span><span class="chip" style="font-size:10px;">${escapeHtml(x.onHold?'ON HOLD':x.status)}</span></div>`).join('');
  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px;">
    ${cell('Pending', s.pending, 'Not released yet')}${cell('Available', s.available, 'You can withdraw this')}
    ${cell('Reserved', s.reserved, 'In a withdrawal request')}${cell('Paid', s.paid, 'Sent to your bank')}
    ${cell('Disputed', s.disputed, 'Frozen during a dispute')}${cell('Reversed', s.reversed, 'Refunded to buyers')}</div>
    ${s.recoveryDue>0?`<div class="card" style="padding:10px;margin-bottom:10px;"><b>${cwNaira(s.recoveryDue)}</b> is owed back because a refund covered money you already withdrew. Our team will contact you.</div>`:''}
    <div class="text-2 small" style="margin-bottom:8px;">For physical orders, earnings stay pending until delivery is confirmed (by the carrier, by your buyer, or by their delivery code) and the ${pol.disputeWindowDays}-day buyer-protection period ends. NOVA's fee is ${pol.commissionPct}% of the item price (after item discounts, excluding delivery and tax).</div>
    <h2 style="font-size:16px;margin:6px 0;">Recent sales</h2><div class="card" style="padding:4px 16px;margin-bottom:12px;">${rows||'<div class="text-2 small" style="padding:10px 0;">No sales yet.</div>'}</div>`;
}
function creatorMoneyTab(){
  if(!cm.wds && !cm.error){ cmLoad(); return '<div class="text-2 small" style="padding:20px;text-align:center;">Loading…</div>'; }
  if(cm.error && !cm.wds) return `<div class="card" style="padding:16px;"><p class="text-2 small" style="color:var(--error);">⚠️ ${escapeHtml(cm.error)}</p><button class="btn btn-outline" onclick="cm.error='';cmLoad(true);render();">Retry</button></div>`;
  if(!cx.profile && !cx.error) cxLoad();
  const h = creatorHome.data; const bal = h ? h.money.balanceAvailable : null;
  if(!h) loadCreatorHome();
  const editing = !cm.payout || cm.editPayout;
  if(editing) cmLoadBanks();
  const payoutBox = editing ? `<div class="card" style="padding:14px;margin-bottom:12px;"><strong>Payout account</strong>
      <div class="text-2 small" style="margin:4px 0 8px;">Your name is verified with Paystack. Money is only ever sent to this account.</div>
      <select id="cmBank" style="width:100%;margin-bottom:8px;"><option value="">${cm.banks?'Choose your bank…':'Loading banks…'}</option>${(cm.banks||[]).map(b=>`<option value="${escapeHtml(b.code)}">${escapeHtml(b.name)}</option>`).join('')}</select>
      <input id="cmAcct" inputmode="numeric" maxlength="10" placeholder="10-digit account number" style="width:100%;margin-bottom:8px;">
      <div style="display:flex;gap:6px;"><button class="btn btn-primary" ${cm.busy?'disabled':''} onclick="cmSavePayout()">${cm.busy?'Verifying…':'Verify & save'}</button>${cm.payout?'<button class="btn btn-outline" onclick="cm.editPayout=false;render();">Cancel</button>':''}</div></div>`
    : `<div class="card" style="padding:14px;margin-bottom:12px;"><div style="display:flex;justify-content:space-between;"><strong>Payout account</strong><a href="#" onclick="event.preventDefault();cm.editPayout=true;render();" style="color:var(--accent);font-size:13px;">Change</a></div>
      <div style="margin-top:6px;">${escapeHtml(cm.payout.accountName||'')}</div><div class="text-2 small">${escapeHtml(cm.payout.bankName||'')} · ****${escapeHtml(String(cm.payout.accountNumber||'').slice(-4))}</div></div>`;
  const wd = cm.payout ? `<div class="card" style="padding:14px;margin-bottom:12px;"><strong>Withdraw</strong>
      <div class="text-2 small" style="margin:4px 0 8px;">Available: ${bal==null?'…':cwNaira(bal)} · minimum ₦5,000 · one request per 7 days · ${cx.policies && cx.policies.withdrawalFeePct!=null ? 'withdrawal fee '+escapeHtml(String(cx.policies.withdrawalFeePct))+'% (shown again before you confirm)' : 'withdrawal fee shown before you confirm'}</div>
      <div style="display:flex;gap:6px;"><input id="cmAmt" type="number" inputmode="decimal" placeholder="Amount in ₦" style="flex:1;"><button class="btn btn-primary" ${cm.busy?'disabled':''} onclick="cmWithdraw()">Request</button></div></div>` : '<div class="text-2 small" style="margin-bottom:12px;">Add a payout account to withdraw your earnings.</div>';
  const history = cm.wds.length ? cm.wds.map(w=>`<div class="list-row"><span class="left">${cwNaira(w.amountRequested)} <span class="text-2 small" style="margin-left:6px;">pay ${cwNaira(w.amountPayable)}</span></span><span class="chip" style="font-size:10px;">${escapeHtml(w.status)}</span></div>`).join('') : '<div class="text-2 small" style="padding:10px 0;">No withdrawals yet.</div>';
  const cj = cm.cj;
  const cjBox = `<div class="card" style="padding:14px;margin-top:12px;"><strong>CJ Dropshipping</strong>
    ${cj && cj.connected ? `<div class="text-2 small" style="margin:6px 0;">Connected: ${escapeHtml(cj.accountEmail||'')} · ${escapeHtml(cj.status||'')}</div><button class="btn btn-outline btn-sm" onclick="cmDisconnectCj()">Disconnect</button>
      <div class="text-2 small" style="margin-top:8px;">Map your listings to CJ products from the Claude connector (see Home).</div>`
    : `<div class="text-2 small" style="margin:4px 0 8px;">Connect your own CJ account so paid orders are placed in it. Your key is stored encrypted and never shown again.</div>
      <input id="cjEmail" type="email" placeholder="CJ account email" style="width:100%;margin-bottom:6px;"><input id="cjKey" type="password" autocomplete="off" placeholder="CJ API key" style="width:100%;margin-bottom:6px;"><button class="btn btn-primary btn-sm" ${cm.busy?'disabled':''} onclick="cmConnectCj()">Connect</button>`}</div>`;
  return `${creatorEarningsBreakdown()}
    ${payoutBox}${wd}
    <h2 style="font-size:16px;margin:6px 0;">Withdrawal history</h2><div class="card" style="padding:4px 16px;">${history}</div>${cjBox}`;
}

/* =========================================================
   LEXDEN NOVA CREATOR — Stage J: Creator Home (AI co-pilot)
   Talks to /api/creator-ai. All numbers come from the server; the AI only
   phrases advice and can never change anything (suggest-only, blueprint §48).
   Every dynamic string goes through escapeHtml; AI text is plain text.
   ========================================================= */
let creatorHome = { data:null, summary:'', loading:false, error:null, aiText:'', aiNote:'', aiBusy:false, aiError:'', question:'', checklist:null, uid:null };
async function loadCreatorHome(force){
  const u = fbAuth.currentUser;
  if(!u) return;
  if(creatorHome.uid !== u.uid){ creatorHome = { data:null, summary:'', loading:false, error:null, aiText:'', aiNote:'', aiBusy:false, aiError:'', question:'', checklist:null, uid:u.uid }; }
  if(creatorHome.loading || (creatorHome.data && !force)) return;
  creatorHome.loading = true; creatorHome.error = null;
  try{
    const r = await authedApi('/api/creator-ai', {}, 25000, 'Loading your dashboard timed out.');
    const d = await r.json();
    if(d && d.ok){ creatorHome.data = d.data.home; creatorHome.summary = d.data.summary || ''; }
    else creatorHome.error = (d && d.error && d.error.message) || 'Could not load your dashboard.';
  }catch(e){ creatorHome.error = e.message || 'Could not reach the server.'; }
  creatorHome.loading = false;
  if(appState.route === '#creator') render();
}
async function creatorAiCall(body){
  if(creatorHome.aiBusy) return;
  creatorHome.aiBusy = true; creatorHome.aiError = ''; creatorHome.checklist = null; render();
  try{
    const r = await authedApi('/api/creator-ai', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }, 40000, 'The assistant took too long. Please try again.');
    const d = await r.json();
    if(d && d.ok){
      if(d.data.checklist){ creatorHome.checklist = d.data.checklist; creatorHome.aiText = ''; creatorHome.aiNote = ''; }
      else { creatorHome.aiText = d.data.text || ''; creatorHome.aiNote = d.data.ai ? (d.data.note || '') : 'Showing your numbers summary (the AI is busy right now).'; }
    } else creatorHome.aiError = (d && d.error && d.error.message) || 'Something went wrong. Please try again.';
  }catch(e){ creatorHome.aiError = e.message || 'Could not reach the server.'; }
  creatorHome.aiBusy = false; render();
}
function creatorAskSubmit(){
  const el = document.getElementById('creatorAsk');
  const q = el ? el.value.trim() : '';
  if(!q){ toast('Type a question first', 'error'); return; }
  creatorHome.question = q;
  creatorAiCall({ action:'ask', message:q });
}
function copyCreatorMcpUrl(){
  const url = API_BASE + '/mcp/creator';
  try{ navigator.clipboard.writeText(url).then(()=>toast('Link copied','success'), ()=>toast(url)); }catch(e){ toast(url); }
}
function screenCreatorHome(){
  const bar = creatorTabBar();
  const H1 = '<h1 class="screen-title">My Creator Account</h1>';
  if(creatorTab === 'home') return creatorHomeTab().replace(H1, H1 + bar);
  const body = creatorTab==='products' ? creatorProductsTab() : creatorTab==='orders' ? creatorOrdersTab() : creatorTab==='store' ? creatorMoreTab() : creatorMoneyTab();
  return `<div class="screen">${H1}${bar}${body}</div>`;
}
function creatorHomeTab(){
  if(!creatorHome.data && !creatorHome.error){
    loadCreatorHome();
    return `<div class="screen"><h1 class="screen-title">My Creator Account</h1><div class="text-2 small" style="padding:20px;text-align:center;">Loading your dashboard…</div></div>`;
  }
  if(creatorHome.error && !creatorHome.data){
    return `<div class="screen"><h1 class="screen-title">My Creator Account</h1>
      <div class="card" style="padding:16px;"><p class="text-2 small" style="color:var(--error);margin-bottom:10px;">⚠️ ${escapeHtml(creatorHome.error)}</p>
      <button class="btn btn-outline" onclick="creatorHome.error=null;loadCreatorHome(true);render();">Retry</button></div></div>`;
  }
  const h = creatorHome.data, r = h.report, m = h.money;
  const n = v => Number(v||0).toLocaleString(undefined,{maximumFractionDigits:2});
  const change = r.earnedChangePct==null ? 'new' : (r.earnedChangePct>0?'▲ ':r.earnedChangePct<0?'▼ ':'')+Math.abs(r.earnedChangePct)+'%';
  const changeColor = r.earnedChangePct==null||r.earnedChangePct===0 ? 'var(--text-2)' : r.earnedChangePct>0 ? 'var(--success,#2ecc71)' : 'var(--error)';
  const stat = (label, value, sub, color) => `<div class="card" style="padding:12px;flex:1;min-width:130px;"><div class="text-2 small">${escapeHtml(label)}</div><div style="font-weight:700;font-size:19px;margin-top:2px;">${value}</div>${sub?`<div class="small" style="color:${color||'var(--text-2)'};margin-top:2px;">${sub}</div>`:''}</div>`;
  const orders = h.ordersNeedingAction.length
    ? h.ordersNeedingAction.map(o=>`<div class="list-row"><span class="left"><span style="font-size:18px;margin-right:8px;">${o.sla==='BREACHED'?'🔴':'🟠'}</span>${escapeHtml(o.product||o.orderId)}</span><span class="text-2 small">${o.sla==='BREACHED'?'Overdue':'Due soon'} · ${escapeHtml(String(o.status).toLowerCase())}</span></div>`).join('')
    : '<div class="text-2 small" style="padding:12px 0;">Nothing is overdue. 🎉</div>';
  const improve = h.listingsToImprove.length
    ? h.listingsToImprove.map(l=>`<div style="padding:10px 0;border-bottom:1px solid var(--border);">
        <div style="display:flex;justify-content:space-between;gap:8px;"><strong>${escapeHtml(l.title||l.productId)}</strong><span class="text-2 small">${Number(l.score)||0}%</span></div>
        <div class="text-2 small" style="margin:4px 0 8px;">${l.todo.map(t=>'• '+escapeHtml(t)).join('<br>')}</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="chip" ${creatorHome.aiBusy?'disabled':''} onclick="creatorAiCall({action:'suggest_title',productId:'${escapeHtml(l.productId)}'})">✨ Better titles</button>
          <button class="chip" ${creatorHome.aiBusy?'disabled':''} onclick="creatorAiCall({action:'suggest_description',productId:'${escapeHtml(l.productId)}'})">✨ Rewrite description</button>
          <button class="chip" ${creatorHome.aiBusy?'disabled':''} onclick="creatorAiCall({action:'suggest_caption',productId:'${escapeHtml(l.productId)}'})">📣 Captions</button>
        </div></div>`).join('')
    : '<div class="text-2 small" style="padding:12px 0;">Your published listings look complete. Nice work.</div>';
  const out = creatorHome.checklist
    ? `<div class="card" style="padding:14px;margin-top:10px;"><strong>Listing checklist: ${creatorHome.checklist.score}%</strong><div class="text-2 small" style="margin-top:6px;">${creatorHome.checklist.items.map(i=>(i.ok?'✅ ':'⬜ ')+escapeHtml(i.tip)).join('<br>')}</div></div>`
    : creatorHome.aiText
      ? `<div class="card" style="padding:14px;margin-top:10px;white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.5;">${escapeHtml(creatorHome.aiText)}${creatorHome.aiNote?`<div class="text-2 small" style="margin-top:10px;white-space:normal;">${escapeHtml(creatorHome.aiNote)}</div>`:''}</div>`
      : '';
  return `<div class="screen">
    <h1 class="screen-title">My Creator Account</h1>
    <div class="text-2 small" style="margin:-6px 0 12px;">Hi ${escapeHtml(h.creator.displayName||'Creator')} 👋 — here is your shop today.</div>

    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;">
      ${stat('Available balance','₦'+n(m.balanceAvailable), m.hasPayoutAccount?'':'Add a payout account to withdraw','var(--warn,#d4af37)')}
      ${stat('Earned this week','₦'+n(r.earned), 'vs last week '+change, changeColor)}
    </div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      ${stat('Sales this week', String(r.sales), 'last week '+r.previousSales)}
      ${stat('Listings', String(h.products.total), h.products.needAttention?h.products.needAttention+' need attention':'all good', h.products.needAttention?'var(--warn,#d4af37)':'')}
    </div>

    <div class="section"><div class="section-head"><h2>Orders needing action</h2>${h.unreadNotifications?`<span class="text-2 small">🔔 ${h.unreadNotifications} new</span>`:''}</div>
      <div class="card" style="padding:4px 16px;">${orders}</div></div>

    <div class="section"><div class="section-head"><h2>NOVA Assistant</h2></div>
      <div class="card" style="padding:14px;">
        <div class="text-2 small" style="margin-bottom:10px;">Ask about your shop. The assistant only reads your own numbers and gives suggestions — it never changes anything or touches your money.</div>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <input id="creatorAsk" type="text" maxlength="400" placeholder="e.g. What should I fix first?" value="${escapeHtml(creatorHome.question)}" style="flex:1;" onkeydown="if(event.key==='Enter')creatorAskSubmit()">
          <button class="btn btn-primary" ${creatorHome.aiBusy?'disabled':''} onclick="creatorAskSubmit()">${creatorHome.aiBusy?'…':'Ask'}</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="chip" ${creatorHome.aiBusy?'disabled':''} onclick="creatorAiCall({action:'weekly_summary'})">📊 Weekly summary</button>
          <button class="chip" onclick="creatorHome.data=null;creatorHome.aiText='';loadCreatorHome(true);render();">↻ Refresh numbers</button>
        </div>
        ${creatorHome.aiBusy?'<div class="text-2 small" style="margin-top:10px;">Thinking…</div>':''}
        ${creatorHome.aiError?`<div class="small" style="margin-top:10px;color:var(--error);">⚠️ ${escapeHtml(creatorHome.aiError)}</div>`:''}
        ${out}
        ${!creatorHome.aiText && !creatorHome.checklist && !creatorHome.aiBusy ? `<div class="card" style="padding:12px;margin-top:10px;white-space:pre-wrap;font-size:14px;line-height:1.5;">${escapeHtml(creatorHome.summary)}</div>`:''}
      </div></div>

    <div class="section"><div class="section-head"><h2>Listings to improve</h2></div>
      <div class="card" style="padding:4px 16px;">${improve}</div></div>

    <div class="section"><div class="section-head"><h2>Manage with Claude</h2></div>
      <div class="card" style="padding:14px;">
        <div class="text-2 small" style="margin-bottom:10px;">Create listings, ship orders and request payouts by chatting with Claude. In Claude, add a custom connector with this link and sign in with your LEXDEN NOVA account:</div>
        <div style="word-break:break-all;font-size:13px;margin-bottom:10px;">${escapeHtml(API_BASE+'/mcp/creator')}</div>
        <button class="btn btn-outline" onclick="copyCreatorMcpUrl()">Copy connector link</button>
      </div></div>
  </div>`;
}

function screenCreatorStatus(title, body, emoji, allowReapply){
  return `<div class="screen">
    <h1 class="screen-title">${escapeHtml(creatorScreenTitle())}</h1>
    <div class="card" style="padding:24px;text-align:center;">
      <div style="font-size:38px;margin-bottom:10px;">${emoji}</div>
      <div style="font-weight:700;font-size:16px;margin-bottom:8px;">${escapeHtml(title)}</div>
      <div class="text-2 small" style="margin-bottom:${allowReapply?'16px':'0'};">${escapeHtml(body)}</div>
      ${allowReapply ? `<button class="btn btn-primary" onclick="pickCreatorType('personal')">Apply Again</button>` : ''}
    </div>
  </div>`;
}

function screenCreatorForm(serverData){
  const f = creatorForm;
  const isBusiness = f.creatorType === 'business';
  const changeNotice = serverData && serverData.status === 'CHANGES_REQUESTED'
    ? `<div class="card" style="padding:14px;margin-bottom:16px;border:1px solid var(--warn,#d4af37);"><strong>Changes requested:</strong> ${escapeHtml(serverData.changeRequestReason||'See below.')}</div>`
    : '';
  return `<div class="screen">
    <h1 class="screen-title">Become a Creator</h1>
    ${changeNotice}
    <div class="card" style="padding:16px;margin-bottom:12px;">
      <div class="text-2 small" style="margin-bottom:10px;">Applying as <strong>${isBusiness?'Business':'Personal'} Creator</strong>. <a href="#" onclick="event.preventDefault();pickCreatorType(${isBusiness?`'personal'`:`'business'`})" style="color:var(--accent);">Switch to ${isBusiness?'Personal':'Business'}</a></div>

      <div class="form-field"><label>Category</label>
        <select id="cf_category">
          ${['apps','courses','templates','ebooks','software','services','physical','mixed'].map(c=>`<option value="${c}" ${f.publicFields.category===c?'selected':''}>${c[0].toUpperCase()+c.slice(1)}</option>`).join('')}
        </select>
      </div>

      <div class="form-field"><label>${isBusiness?'Business display name':'Display name'} <span class="text-2 small">(shown to buyers — never your legal name)</span></label>
        <input id="cf_displayName" value="${escapeHtml((isBusiness?f.publicFields.businessDisplayName:f.publicFields.displayName)||'')}" placeholder="${isBusiness?'e.g. Lovelace Software':'e.g. Ada Codes'}">
      </div>

      <div class="form-field"><label>Profile image</label>
        <input type="file" accept="image/*" onchange="previewCreatorAvatar(this)">
        ${f.profileImagePreview ? `<img src="${f.profileImagePreview}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;margin-top:8px;">` : ''}
      </div>

      ${isBusiness ? `
      <div class="form-field"><label>Legal business name</label><input id="cf_legalBusinessName" value="${escapeHtml(f.privateFields.legalBusinessName||'')}"></div>
      <div class="form-field"><label>Contact person's name</label><input id="cf_contactName" value="${escapeHtml(f.privateFields.contactName||'')}"></div>
      <div class="form-field"><label>Email</label><input id="cf_email" type="email" value="${escapeHtml(f.privateFields.email||'')}"></div>
      <div class="form-field"><label>WhatsApp / customer-care number</label><input id="cf_whatsapp" value="${escapeHtml(f.privateFields.whatsapp||'')}" placeholder="+234..."></div>
      <div class="form-field"><label>At least one social handle (one per line, full URL)</label><textarea id="cf_social" rows="2" placeholder="https://instagram.com/yourbusiness">${escapeHtml(f.socialHandlesText||'')}</textarea></div>
      <div class="form-field"><label>Business/identity document</label>
        <input type="file" accept="image/jpeg,image/png,application/pdf" onchange="uploadCreatorDocument(this,'business_registration')">
        ${(f.privateFields.documentIds||[]).length ? `<div class="text-2 small" style="margin-top:6px;">✅ ${f.privateFields.documentIds.length} document(s) uploaded</div>` : ''}
      </div>
      ` : `
      <div class="form-field"><label>Legal name <span class="text-2 small">(private — never shown publicly)</span></label><input id="cf_legalName" value="${escapeHtml(f.privateFields.legalName||'')}"></div>
      <div class="form-field"><label>Date of birth</label><input id="cf_dob" type="date" value="${f.privateFields.dob ? String(f.privateFields.dob).slice(0,10) : ''}"></div>
      <div class="form-field"><label>Email</label><input id="cf_email" type="email" value="${escapeHtml(f.privateFields.email||'')}"></div>
      <div class="form-field"><label>Phone</label><input id="cf_phone" value="${escapeHtml(f.privateFields.phone||'')}" placeholder="+234..."></div>
      `}

      <div class="form-field"><label style="display:flex;align-items:center;gap:8px;cursor:pointer;"><input type="checkbox" id="cf_terms" ${f.acceptTerms?'checked':''} style="width:auto;"> I accept the Creator Terms and Marketplace Rules</label></div>

      ${f.errors.length ? `<div class="card" style="padding:12px;margin:10px 0;border:1px solid var(--error);"><div class="text-2 small" style="font-weight:700;margin-bottom:4px;">Please fix:</div>${f.errors.map(e=>`<div class="text-2 small">• ${escapeHtml(e.message)}</div>`).join('')}</div>` : ''}

      <div style="display:flex;gap:10px;margin-top:14px;">
        <button class="btn btn-outline" ${f.saving?'disabled':''} onclick="saveCreatorDraft(false)">${f.saving?'Saving…':'Save Draft'}</button>
        <button class="btn btn-primary" ${f.saving?'disabled':''} onclick="saveCreatorDraft(true)">${f.saving?'Submitting…':'Submit Application'}</button>
      </div>
    </div>
  </div>`;
}

function readCreatorFormFromDom(){
  const f = creatorForm;
  const isBusiness = f.creatorType === 'business';
  f.publicFields.category = $('#cf_category') ? $('#cf_category').value : f.publicFields.category;
  if(isBusiness){
    f.publicFields.businessDisplayName = $('#cf_displayName') ? $('#cf_displayName').value.trim() : '';
    f.publicFields.socialHandles = ($('#cf_social') ? $('#cf_social').value : '').split('\n').map(s=>s.trim()).filter(Boolean);
    f.privateFields.legalBusinessName = $('#cf_legalBusinessName') ? $('#cf_legalBusinessName').value.trim() : '';
    f.privateFields.contactName = $('#cf_contactName') ? $('#cf_contactName').value.trim() : '';
    f.privateFields.email = $('#cf_email') ? $('#cf_email').value.trim() : '';
    f.privateFields.whatsapp = $('#cf_whatsapp') ? $('#cf_whatsapp').value.trim() : '';
  } else {
    f.publicFields.displayName = $('#cf_displayName') ? $('#cf_displayName').value.trim() : '';
    f.privateFields.legalName = $('#cf_legalName') ? $('#cf_legalName').value.trim() : '';
    f.privateFields.dob = $('#cf_dob') ? $('#cf_dob').value : '';
    f.privateFields.email = $('#cf_email') ? $('#cf_email').value.trim() : '';
    f.privateFields.phone = $('#cf_phone') ? $('#cf_phone').value.trim() : '';
  }
  f.acceptTerms = $('#cf_terms') ? $('#cf_terms').checked : false;
}

function previewCreatorAvatar(inputEl){
  const file = inputEl.files && inputEl.files[0];
  if(!file) return;
  if(file.size > 8*1024*1024){ toast('Image too large — 8MB max', 'error'); inputEl.value=''; return; }
  const reader = new FileReader();
  reader.onload = async e=>{
    creatorForm.profileImagePreview = e.target.result;
    render();
    // Re-use the exact same Cloudinary helper every other image upload in
    // this app already goes through (product images, profile pictures,
    // logos — see its own comments above) — a creator's own profile photo
    // isn't a confidential document, so it belongs here, not in the
    // private Firebase Storage KYC path /api/creator-documents uses.
    try{
      const url = await cloudinaryUploadFile(file, 8);
      creatorForm.publicFields.profileImageUrl = url;
      toast('Profile image uploaded', 'success');
    }catch(err){
      toast('Image upload failed — ' + (err.message||'try again'), 'error');
    }
    render();
  };
  reader.readAsDataURL(file);
}

async function uploadCreatorDocument(inputEl, docType){
  const file = inputEl.files && inputEl.files[0];
  if(!file) return;
  if(file.size > 8*1024*1024){ toast('File too large — 8MB max', 'error'); inputEl.value=''; return; }
  const mimeType = file.type;
  if(!['image/jpeg','image/png','application/pdf'].includes(mimeType)){ toast('Use a JPEG, PNG, or PDF', 'error'); inputEl.value=''; return; }
  const user = fbAuth.currentUser;
  if(!user){ toast('Not signed in', 'error'); return; }
  const reader = new FileReader();
  reader.onload = async e=>{
    const fileBase64 = String(e.target.result).split(',')[1] || '';
    try{
      const r = await authedApi('/api/creator-documents', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ docType, fileBase64, fileName: file.name, mimeType }),
      }, 30000, 'Document upload timed out.');
      const d = await r.json();
      if(!d.ok){ toast((d.error&&d.error.message)||'Upload failed', 'error'); return; }
      creatorForm.privateFields.documentIds = [...(creatorForm.privateFields.documentIds||[]), d.data.documentId];
      toast('Document uploaded', 'success');
      render();
    }catch(err){
      toast('Could not reach the server — '+(err.message||'try again'), 'error');
    }
  };
  reader.readAsDataURL(file);
}

async function saveCreatorDraft(thenSubmit){
  readCreatorFormFromDom();
  const f = creatorForm;
  if(!f.creatorType){ toast('Pick Personal or Business first', 'error'); return; }
  const user = fbAuth.currentUser;
  if(!user){ toast('Not signed in', 'error'); return; }
  f.saving = true; f.errors = []; render();
  try{
    const draftBody = {
      action: 'save_draft',
      creatorType: f.creatorType,
      category: f.publicFields.category,
      displayName: f.publicFields.displayName,
      businessDisplayName: f.publicFields.businessDisplayName,
      profileImageUrl: f.publicFields.profileImageUrl,
      socialHandles: f.publicFields.socialHandles,
      legalName: f.privateFields.legalName,
      dob: f.privateFields.dob,
      email: f.privateFields.email,
      phone: f.privateFields.phone,
      legalBusinessName: f.privateFields.legalBusinessName,
      contactName: f.privateFields.contactName,
      whatsapp: f.privateFields.whatsapp,
      documentIds: f.privateFields.documentIds,
      acceptTerms: f.acceptTerms,
    };
    const r1 = await authedApi('/api/creator-application', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify(draftBody),
    }, 25000, 'Saving timed out.');
    const d1 = await r1.json();
    if(!d1.ok){ f.saving=false; f.errors = d1.error && d1.error.errors ? d1.error.errors : [{message:(d1.error&&d1.error.message)||'Could not save.'}]; render(); return; }

    if(!thenSubmit){ f.saving=false; toast('Draft saved','success'); await fetchCreatorApplication(true); render(); return; }

    const r2 = await authedApi('/api/creator-application', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ action:'submit' }),
    }, 25000, 'Submitting timed out.');
    const d2 = await r2.json();
    f.saving = false;
    if(!d2.ok){ f.errors = d2.error && d2.error.errors ? d2.error.errors : [{message:(d2.error&&d2.error.message)||'Could not submit.'}]; render(); return; }
    toast('Application submitted!','success');
    await fetchCreatorApplication(true);
    render();
  }catch(err){
    f.saving = false;
    toast('Could not reach the server — '+(err.message||'try again'), 'error');
    render();
  }
}
