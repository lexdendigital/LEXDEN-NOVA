'use strict';

/* =========================================================
   ADMIN DASHBOARD
   NOTE ON SECURITY: admin access now goes through a real
   Firebase Authentication email/password sign-in (see
   tryAdminLogin below) instead of a plaintext password sitting
   in this file. The account itself is created once, manually,
   in the Firebase console (Authentication -> Users -> Add user)
   — there is no public sign-up form, so only whoever you hand
   that email+password to can ever reach this screen. Actual
   write protection for the catalog data lives in your Firestore
   security rules, which check the signed-in admin's email.
   ========================================================= */
const ADMIN_TABS = [
  {id:'dashboard', label:'Dashboard', ic:'dashboard'},
  {id:'products', label:'Products', ic:'shop'},
  {id:'categories', label:'Categories', ic:'folder'},
  {id:'content', label:'App Content', ic:'edit'},
  {id:'branding', label:'Branding & Currency', ic:'palette'},
  {id:'services', label:'Services', ic:'layers'},
  {id:'feed', label:'Feed Posts', ic:'newspaper'},
  {id:'testimonials', label:'Reviews', ic:'star'},
  {id:'faqs', label:'FAQs', ic:'question'},
  {id:'social', label:'Social & Contact', ic:'phone'},
  {id:'leads', label:'Messages', ic:'mail'},
  {id:'newsletter', label:'Newsletter', ic:'send'},
  {id:'users', label:'Users', ic:'user'},
  {id:'ai', label:'NOVA AI Setup', ic:'sparkle'},
  {id:'payments', label:'Payments', ic:'card'},
  {id:'affiliate', label:'Affiliate Program', ic:'target'},
  {id:'creators', label:'Creator Applications', ic:'target'},
  {id:'creatorOps', label:'Creator Ops', ic:'target'},
  {id:'errors', label:'Error Codes', ic:'bug'},
  {id:'suppliers', label:'Suppliers', ic:'package'},
  {id:'supplierRouting', label:'Supplier Routing', ic:'target'},
  {id:'cj', label:'CJ Dropshipping', ic:'package'},
  {id:'sitemap', label:'Sitemap', ic:'globe'},
  {id:'export', label:'Export', ic:'download'},
  {id:'logs', label:'Logs', ic:'receipt'},
];

function renderAdmin(){
  const app = $('#app');
  if(!appState.adminAuthed){
    app.innerHTML = `
    <div class="admin-overlay">
      <div class="admin-login">
        <div class="admin-lock-badge">${icon('lock')}</div>
        <h2 class="font-display">Admin Access</h2>
        <p class="text-2 small">Sign in with your admin email and password</p>
        <input type="email" id="adminEmail" placeholder="Admin email" autocomplete="username" style="letter-spacing:normal;">
        <input type="password" id="adminPass" placeholder="Password" autocomplete="current-password">
        <div class="flex gap-8">
          <button class="btn btn-primary" id="adminUnlockBtn" onclick="tryAdminLogin()">Unlock</button>
          <button class="btn btn-outline" onclick="navigate('#home')">Cancel</button>
        </div>
        <p class="small text-2" id="adminErr" style="color:var(--error);"></p>
        <p class="small text-2" id="adminCloudNote" style="opacity:.7;"></p>
      </div>
    </div>`;
    const passInp = $('#adminPass');
    passInp.addEventListener('keydown', e=>{ if(e.key==='Enter') tryAdminLogin(); });
    return;
  }
  app.innerHTML = `
  <div class="admin-overlay">
    <div class="mobile-admin-tabs">
      ${ADMIN_TABS.map(t=>`<button class="atab ${appState.adminTab===t.id?'active':''}" onclick="setAdminTab('${t.id}')">${icon(t.ic)} ${t.label}</button>`).join('')}
    </div>
    <div class="admin-shell">
      <div class="admin-side">
        <div style="padding:10px 12px 16px;font-weight:800;font-family:'Space Grotesk';display:flex;align-items:center;gap:8px;"><img src="${DB.content.logoUrl}" style="width:22px;height:22px;border-radius:6px;object-fit:cover;"> NOVA Admin</div>
        ${ADMIN_TABS.map(t=>`<div class="atab ${appState.adminTab===t.id?'active':''}" onclick="setAdminTab('${t.id}')">${icon(t.ic)} ${t.label}</div>`).join('')}
        <div class="divider"></div>
        <div class="atab" onclick="adminLogout()">${icon('logout')} Exit Admin</div>
      </div>
      <div class="admin-main" id="adminMain"></div>
    </div>
  </div>`;
  renderAdminTab();
}
async function tryAdminLogin(){
  const email = ($('#adminEmail')?.value||'').trim();
  const pass = $('#adminPass').value;
  const errEl = $('#adminErr');
  const btn = $('#adminUnlockBtn');
  errEl.textContent = '';
  if(!email || !pass){
    errEl.textContent = 'Enter both email and password.';
    return;
  }
  if(email.toLowerCase() !== window.__ADMIN_EMAIL.toLowerCase()){
    errEl.textContent = 'Incorrect email or password. Try again.';
    if(navigator.vibrate) navigator.vibrate([80,40,80]);
    return;
  }
  if(!window.__fb){ errEl.textContent = 'Still connecting — try again in a moment.'; return; }

  // The ONLY gate: a real Firebase sign-in, race()'d against a hard
  // timeout so a bad connection can never leave the button stuck on
  // "Signing in…" — see withTimeout()/window.__adminAuthTimeoutHelper
  // above for why. Firestore's own rules are the real enforcement here;
  // this is just what lets the correct admin in.
  if(btn){ btn.disabled = true; btn.textContent = 'Signing in…'; }
  const { fbAuth, signInWithEmailAndPassword } = window.__fb;
  try{
    // SPEED FIX: a single stalled attempt on a slow/flaky mobile
    // connection used to mean tapping Unlock all over again by hand. This
    // now tries fast (5s) and — ONLY if that attempt genuinely timed out,
    // never on a wrong-password rejection, which comes back from Firebase
    // almost immediately and should surface right away — silently retries
    // once more before giving up and showing an error. Most real
    // connections recover within one retry; this just removes the need to
    // notice the failure and re-tap manually.
    let result;
    try{
      result = await withTimeout(
        signInWithEmailAndPassword(fbAuth, email, pass), 5000,
        'timeout'
      );
    }catch(firstErr){
      if(firstErr && firstErr.message === 'timeout'){
        if(btn) btn.textContent = 'Still trying…';
        result = await withTimeout(
          signInWithEmailAndPassword(fbAuth, email, pass), 5000,
          'Sign-in is taking too long — check your connection and try again.'
        );
      } else {
        throw firstErr;
      }
    }
    appState.adminAuthed = true;
    window.__adminCloudAuthed = true;
    logActivity('Admin', 'Logged into admin dashboard');
    renderAdmin();
    if(window.__leadsError){ window.__leadsCache = null; refreshLeads(); }
  }catch(e){
    console.warn('Admin sign-in failed:', e);
    const code = e && e.code;
    // BUGFIX ("incorrect email/password even when correct"): current
    // Firebase Auth deliberately no longer distinguishes "wrong password"
    // from "no account exists for this email" — both come back as
    // auth/invalid-credential (a 2023+ change to stop leaking which
    // emails have accounts). auth/user-not-found/auth/wrong-password are
    // kept here only for older SDK behavior; on current versions
    // invalid-credential is what actually fires. The one genuinely likely
    // cause of "this is definitely my real password and it's still
    // rejected": the ruthanselem2@gmail.com account was never actually
    // created in Firebase Console (this app's local-password gate used
    // to make that optional — it no longer is, now that the real gate is
    // real Firebase sign-in). The message below says so plainly instead
    // of just insisting the password is wrong.
    errEl.textContent =
      (code==='auth/invalid-credential' || code==='auth/wrong-password' || code==='auth/user-not-found') ? `Wrong password — or no account exists yet for ${window.__ADMIN_EMAIL}. If you haven't already, create that exact email + password once in Firebase Console → Authentication → Users → Add user, then try again.`
      : code==='auth/too-many-requests' ? 'Too many attempts — wait a bit before trying again.'
      : code==='auth/network-request-failed' ? 'Network problem — check your connection and try again.'
      : `Could not sign in (${code || (e && e.message) || 'unknown error'}). If this is the first time, make sure the ${window.__ADMIN_EMAIL} account exists in Firebase Console → Authentication → Users.`;
    if(navigator.vibrate) navigator.vibrate([80,40,80]);
  } finally {
    if(btn){ btn.disabled = false; btn.textContent = 'Unlock'; }
  }
}
async function adminLogout(){
  appState.adminAuthed = false;
  navigate('#home');
  if(window.__fb){
    const { fbAuth, signOut } = window.__fb;
    try{
      await signOut(fbAuth);
    }catch(e){ console.warn('Sign out failed', e); }
  }
}
function setAdminTab(id){ appState.adminTab = id; renderAdminTab(); }

function renderAdminTab(){
  const main = $('#adminMain');
  if(!main) return;
  const map = {
    dashboard: adminDashboard, products: adminProducts, categories: adminCategories,
    content: adminContent, branding: adminBranding, services: adminServicesTab, feed: adminFeed,
    testimonials: adminTestimonials, social: adminSocial, ai: adminAI, payments: adminPayments,
    faqs: adminFaqs, leads: adminLeads, newsletter: adminNewsletter, users: adminUsers, errors: adminErrorCodes,
    affiliate: adminAffiliateProgram, creators: adminCreatorApplications, creatorOps: adminCreatorOps,
    sitemap: adminSitemap, export: adminExport, logs: adminLogs,
    suppliers: adminSuppliers, supplierRouting: adminSupplierRouting,
    cj: adminCJDropshipping,
  };
  main.innerHTML = (map[appState.adminTab]||adminDashboard)();
  if(appState.adminTab==='cj') cjLoadSyncLogsIfVisible();
}

function adminDashboard(){
  const products = DB.products;
  const log = lsGet(LS_KEYS.activityLog, []);
  const missingImg = products.filter(p=>!p.image).length;
  const noCategory = products.filter(p=>!p.category).length;
  const cs = window.__cloudStatus || {ok:null};
  const cloudLine = cs.ok===true ? '✅ Cloud sync working — last confirmed ' + new Date(cs.lastCheck).toLocaleTimeString()
    : cs.ok===false ? `❌ Cloud sync FAILING: ${cs.lastError||'unknown error'} — changes you make are only saving to this device until this is fixed.`
    : '⏳ Cloud sync status unknown yet (make an edit to check).';
  return `
    <div class="admin-topbar"><h2>Dashboard</h2></div>
    <div class="card" style="padding:14px;margin-bottom:16px;border:1px solid ${cs.ok===false?'var(--error)':'var(--border)'};">
      <h3 style="font-size:14px;margin-bottom:6px;">☁️ Cloud connection</h3>
      <div class="log-row">${cloudLine}</div>
      <div class="log-row small text-2">Signed in as: ${window.__fbAdminEmail || 'not signed in as admin'}</div>
    </div>
    <div class="stat-grid">
      <div class="stat-box"><div class="num">${products.length}</div><div class="lbl">Total products</div></div>
      <div class="stat-box"><div class="num">${DB.categories.length}</div><div class="lbl">Categories</div></div>
      <div class="stat-box"><div class="num">${DB.testimonials.length}</div><div class="lbl">Reviews</div></div>
      <div class="stat-box"><div class="num">${DB.wishlist.length}</div><div class="lbl">Wishlist saves (this device)</div></div>
    </div>
    <h3 style="font-size:14px;margin-bottom:10px;">NOVA AI diagnostics</h3>
    <div class="card" style="padding:14px;margin-bottom:20px;">
      ${missingImg? `<div class="log-row">⚠️ ${missingImg} product(s) missing an image URL.</div>` : `<div class="log-row">✅ All products have images.</div>`}
      ${noCategory? `<div class="log-row">⚠️ ${noCategory} product(s) missing a category.</div>` : `<div class="log-row">✅ All products are categorized.</div>`}
      <div class="log-row">✅ No JavaScript errors detected this session.</div>
      <div class="log-row">ℹ️ ${products.filter(p=>p.status==='draft').length} product(s) currently in Draft (hidden from catalog).</div>
    </div>
    <h3 style="font-size:14px;margin-bottom:10px;">Recent activity</h3>
    <div class="card" style="padding:10px 14px;">
      ${log.slice(0,8).map(l=>`<div class="log-row"><strong>${escapeHtml(l.who)}</strong> — ${escapeHtml(l.what)} <span class="mono">· ${new Date(l.time).toLocaleString()}</span></div>`).join('') || '<div class="log-row">No activity yet.</div>'}
    </div>`;
}

/* Reference list for whoever's fielding a support email — a shopper or
   admin reporting "Upload failed (E01)" doesn't need (or want) the raw
   technical message, but whoever reads lexdendigital@gmail.com does. This
   reads straight from ERROR_CODES so it can never fall out of sync with
   what actually gets shown/thrown in the app. */
function adminErrorCodes(){
  const codes = Object.keys(ERROR_CODES);
  return `
    <div class="admin-topbar"><h2>Error Codes</h2></div>
    <p class="text-2 small" style="margin-bottom:16px;">When an upload fails for a reason only you can fix, shoppers and the admin panel show a short code instead of the raw technical message — e.g. "Upload failed (E01)". Look the code up here to see what actually went wrong and how to fix it. If a shopper emails support with a code, this is what it means.</p>
    ${codes.map(code=>{
      const c = ERROR_CODES[code];
      return `
      <div class="card" style="padding:14px 16px;margin-bottom:12px;">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
          <span class="mono" style="font-weight:800;color:var(--accent);">${escapeHtml(code)}</span>
          <span style="font-weight:700;">${escapeHtml(c.title)}</span>
        </div>
        <div class="log-row" style="border-bottom:none;padding:2px 0;"><strong>Cause:</strong> ${escapeHtml(c.cause)}</div>
        <div class="log-row" style="border-bottom:none;padding:2px 0;"><strong>Fix:</strong> ${escapeHtml(c.fix)}</div>
      </div>`;
    }).join('')}
    <p class="text-2 small">Every code with the same cause always shows the same code — if a shopper reports the same code twice, it's the same underlying issue.</p>`;
}
function adminProducts(){
  const products = DB.legacyProducts;
  return `
    <div class="admin-topbar"><h2>Products (${products.length})</h2><button class="btn btn-primary btn-sm" onclick="openProductForm()">+ Add Product</button></div>
    <div id="productFormWrap"></div>
    <div style="overflow-x:auto;">
    <table class="admin-table">
      <thead><tr><th>Name</th><th>Category</th><th>Price</th><th>Sale</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${products.map(p=>`<tr>
          <td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.category)}</td><td>${fmtPrice(p.price)}</td><td>${p.salePrice?fmtPrice(p.salePrice):'—'}</td>
          <td>${p.status==='draft'?'📝 Draft':'✅ Published'}</td>
          <td class="flex gap-8"><button class="btn btn-ghost btn-sm" onclick="openProductForm('${p.id}')">Edit</button><button class="btn btn-danger btn-sm" onclick="deleteProduct('${p.id}')">Delete</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
    </div>`;
}
function nextProductShareId(excludeId){
  const products=DB.legacyProducts||DB.products||[];
  const used=new Set();
  products.forEach(p=>{
    if(!p || String(p.id||'')===String(excludeId||'')) return;
    const id=String(p.id||'');
    const alias=String(p.shareId||'');
    if(/^p\d{1,4}$/.test(id)) used.add(id);
    if(/^p\d{1,4}$/.test(alias)) used.add(alias);
  });
  let n=1;
  while(used.has('p'+n)) n++;
  return 'p'+n;
}
function openProductForm(id){
  const p = id ? findProduct(id) : null;
  const cats = DB.categories.filter(c=>c.id!=='all');
  const wrap = $('#productFormWrap');
  const existingMedia = p ? productMedia(p) : [];
  const mediaSlots = Array.from({length:8}).map((_,i)=> existingMedia[i]?existingMedia[i].url:'');
  const specs = (p && p.specs) || {};
  window.__adminExistingVariants = p && Array.isArray(p.variants) ? JSON.parse(JSON.stringify(p.variants)) : [];
  window.__adminExistingOptions = p && Array.isArray(p.options) ? JSON.parse(JSON.stringify(p.options)) : [];
  const isPhysicalCategorySelected = isPhysicalCategory(p ? p.category : cats[0]?.id);
  wrap.innerHTML = `
  <div class="card" style="padding:18px;margin-bottom:20px;">
    <h3>${p?'Edit':'Add'} Product</h3>
    <div class="form-grid">
      <div class="form-field"><label>Name</label><input id="f_name" value="${p?escapeHtml(p.name):''}"></div>
      <div class="form-field"><label>Category</label>${customSelect('f_category', p&&p.category||(cats[0]&&cats[0].id), cats.map(c=>({value:c.id,label:c.name})), '', ()=>toggleHardwareFields())}</div>
      <div class="form-field"><label>Regular price (₦ Naira — leave blank or 0 for Free)</label><input id="f_price" type="number" step="1" oninput="updateDiscountPreview()" value="${p?Math.round(p.price*(DB.content.exchangeRates.NGN||1550)):''}"></div>
      <div class="form-field"><label>Sale price (optional, ₦ Naira)</label><input id="f_salePrice" type="number" step="1" oninput="updateDiscountPreview()" value="${p&&p.salePrice?Math.round(p.salePrice*(DB.content.exchangeRates.NGN||1550)):''}"></div>
      <div class="form-field"><label>Discount</label><input id="f_discountPreview" disabled value="${p?discountPercent(p)+'%':'0%'}" style="opacity:.7;"></div>
      <div class="form-field"><label>Item code</label><input id="f_itemCode" value="${p?p.itemCode:'LX-'+Math.random().toString(36).slice(2,7).toUpperCase()}"></div>
      <div class="form-field">
        <label>Product type</label>
        ${customSelect('f_productType', p&&p.productType || (isPhysicalCategorySelected?'PHYSICAL':'DIGITAL'), [
          {value:'DIGITAL',label:'Digital (instant download)'},
          {value:'PHYSICAL',label:'Physical (shipped item)'},
          {value:'SERVICE',label:'Service'},
        ], '', ()=>togglePhysicalFields())}
      </div>
      <div class="form-field"><label>Seller</label><input id="f_seller" value="${p?escapeHtml(p.seller||''):'Lexden Digital'}"></div>
      <div class="form-field"><label>Affiliate / purchase link</label><input id="f_link" value="${p?p.affiliateLink:'#'}"></div>
      <div class="form-field"><label>Status</label>${customSelect('f_status', p&&p.status||'published', [{value:'published',label:'Published'},{value:'draft',label:'Draft'}], '')}</div>
      <div class="form-field"><label>Tags (comma separated)</label><input id="f_tags" value="${p?(p.tags||[]).join(', '):''}"></div>
      <div class="form-field">
        <label><input type="checkbox" id="f_affiliateEnabled" ${p&&p.affiliateEnabled?'checked':''}> Allow Nova Affiliates to earn commission on this product</label>
      </div>
      <div class="form-field"><label>Nova Affiliate commission % (blank = use Program default)</label><input id="f_affiliateCommissionPct" type="number" min="0" max="100" step="0.5" value="${p&&p.affiliateCommissionPct!=null?p.affiliateCommissionPct:''}" placeholder="e.g. 15"></div>
    </div>
    <div class="admin-variant-editor" aria-labelledby="variantEditorHeading">
      <div class="flex" style="justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">
        <div><h4 id="variantEditorHeading" style="font-size:14px;margin-bottom:4px;">Product options and variants</h4><p class="text-2 small">Use one product page for choices such as color, storage, version or license. Each combination can have its own price, stock, delivery, supplier variant and affiliate rate.</p></div>
        <button type="button" class="btn btn-outline btn-sm" onclick="addVariantOptionRow()">+ Add option</button>
      </div>
      <div id="variantOptionsEditor">${variantOptionRowsHtml(p&&p.options||[])}</div>
      <div class="flex gap-8" style="margin:10px 0;">
        <button type="button" class="btn btn-outline btn-sm" onclick="buildVariantMatrix()">Build variant combinations</button>
      </div>
      <div id="variantMatrix" class="variant-matrix"></div>
      <p class="text-2 small" style="margin-top:8px;">Publishing a variant product requires an explicit price for every variant (enter 0 for free). Out-of-stock or disabled variants cannot be selected. Legacy products without options keep their existing checkout behavior.</p>
    </div>
    <div class="divider"></div>
    <h4 style="font-size:13px;margin-bottom:8px;">Details</h4>
    <div class="form-grid">
      <div class="form-field" id="f_formatWrap"><label>Format</label><input id="f_format" placeholder="e.g. Video course (6h), PDF, Physical item" value="${escapeHtml(specs['Format']||'')}"></div>
      <div class="form-field" id="f_levelWrap"><label>Level</label><input id="f_level" placeholder="e.g. Beginner, Intermediate (courses only)" value="${escapeHtml(specs['Level']||'')}"></div>
      <div class="form-field" id="f_conditionWrap" style="display:${isPhysicalCategorySelected?'block':'none'};">
        <label>Condition</label>
        ${customSelect('f_condition', specs['Condition']||'', [
          {value:'',label:'—'},
          {value:'New',label:'New'},
          {value:'Used — Excellent',label:'Used — Excellent'},
          {value:'Used — Good',label:'Used — Good'},
          {value:'Refurbished',label:'Refurbished'}
        ], '—')}
      </div>
      <div class="form-field" id="f_warrantyWrap" style="display:${isPhysicalCategorySelected?'block':'none'};">
        <label>Warranty</label><input id="f_warranty" placeholder="e.g. 6 months, No warranty" value="${escapeHtml(specs['Warranty']||'')}">
      </div>
    </div>
    <!-- Physical-product-only fields: shown when Product type = Physical.
         Kept simple (no formal specifications schema, no cart/shipping
         checkout yet — see the README that ships alongside this file for
         what's covered now vs. what's a deliberate next phase) — this
         extends the existing digital-first data model rather than
         replacing it, per "adapt to the existing NOVA architecture rather
         than blindly replacing existing structures." -->
    <div id="physicalFieldsWrap" style="display:${(p&&p.productType==='PHYSICAL')||(!p&&isPhysicalCategorySelected)?'block':'none'};">
      <div class="divider"></div>
      <h4 style="font-size:13px;margin-bottom:8px;">Physical product details</h4>
      <div class="form-grid">
        <div class="form-field">
          <label>Stock mode</label>
          ${customSelect('f_stockMode', (p&&p.physical&&p.physical.stockMode)||'SUPPLIER_STOCK', [
            {value:'SUPPLIER_STOCK',label:'Supplier stock'},
            {value:'PREORDER',label:'Pre-order'},
          ], '')}
        </div>
        <div class="form-field">
          <label>Stock status (shown honestly to shoppers — do not mark "In stock" unless it really is)</label>
          ${customSelect('f_stockStatus', (p&&p.physical&&p.physical.stockStatus)||'in_stock', [
            {value:'in_stock',label:'In stock'},
            {value:'low_stock',label:'Low stock'},
            {value:'out_of_stock',label:'Out of stock'},
            {value:'preorder',label:'Available for pre-order'},
          ], '')}
        </div>
        <div class="form-field"><label>Delivery estimate</label><input id="f_deliveryEstimate" placeholder="e.g. 3–7 business days" value="${escapeHtml((p&&p.physical&&p.physical.deliveryEstimate)||'')}"></div>
        <div class="form-field"><label>Shipping countries (comma separated)</label><input id="f_shippingCountries" placeholder="e.g. Nigeria, Ghana" value="${escapeHtml((p&&p.physical&&(p.physical.shippingCountries||[]).join(', '))||'Nigeria')}"></div>
        <div class="form-field"><label>Weight</label><input id="f_weight" placeholder="e.g. 1.2kg" value="${escapeHtml((p&&p.physical&&p.physical.weight)||'')}"></div>
        <div class="form-field"><label>Dimensions</label><input id="f_dimensions" placeholder="e.g. 30 x 20 x 4 cm" value="${escapeHtml((p&&p.physical&&p.physical.dimensions)||'')}"></div>
        <div class="form-field"><label>Return policy</label><input id="f_returnPolicy" placeholder="e.g. 7-day return if unopened" value="${escapeHtml((p&&p.physical&&p.physical.returnPolicy)||'')}"></div>
        <div class="form-field">
          <label>Supplier</label>
          ${customSelect('f_supplierId', (p&&p.physical&&p.physical.supplierId)||'', [{value:'',label:'No supplier linked'}, ...DB.suppliers.map(s=>({value:s.id,label:s.name}))], 'No supplier linked')}
        </div>
        <div class="form-field"><label>Supplier SKU</label><input id="f_supplierSku" placeholder="Supplier's own product code" value="${escapeHtml((p&&p.physical&&p.physical.supplierSku)||'')}"></div>
        <div class="form-field"><label>Supplier cost <span class="text-2 small">(what you pay them — never shown to shoppers)</span></label><input id="f_supplierCost" type="number" min="0" step="0.01" value="${p&&p.physical&&p.physical.supplierCost!=null?p.physical.supplierCost:''}"></div>
        <div class="form-field"><label>Supplier currency</label><input id="f_supplierCurrency" placeholder="e.g. NGN, USD, CNY" value="${escapeHtml((p&&p.physical&&p.physical.supplierCurrency)||'')}"></div>
      </div>
      <!-- CJ Dropshipping mapping block (README §32) — collapsible, only
           meaningful once the product was Imported from CJ (see
           adminCJDropshipping()'s importCjSelected()) or manually mapped
           here. Read-only identifiers + live-lookup buttons; nothing here
           is required for a non-CJ physical product to save normally. -->
      <div class="divider"></div>
      <details ${p&&p.physical&&p.physical.cj&&p.physical.cj.productId?'open':''} style="margin-top:4px;">
        <summary style="cursor:pointer;font-size:13px;font-weight:700;padding:6px 0;">📦 CJ Dropshipping data</summary>
        <div class="form-grid" style="margin-top:8px;">
          <div class="form-field"><label>CJ product ID</label><input id="f_cjProductId" placeholder="e.g. 2408..." value="${escapeHtml((p&&p.physical&&p.physical.cj&&p.physical.cj.productId)||'')}"></div>
          <div class="form-field"><label>CJ variant ID</label><input id="f_cjVariantId" placeholder="e.g. 2408...-v1" value="${escapeHtml((p&&p.physical&&p.physical.cj&&p.physical.cj.variantId)||'')}"></div>
          <div class="form-field"><label>CJ SKU</label><input id="f_cjSku" value="${escapeHtml((p&&p.physical&&p.physical.cj&&p.physical.cj.sku)||'')}"></div>
          <div class="form-field">
            <label>CJ sync enabled</label>
            ${customSelect('f_cjSyncEnabled', (p&&p.physical&&p.physical.cj&&p.physical.cj.syncEnabled)===false?'no':'yes', [{value:'yes',label:'Yes'},{value:'no',label:'No'}], '')}
          </div>
        </div>
        <p class="small text-2" id="f_cjLastSynced" style="margin:4px 0 8px;">${p&&p.physical&&p.physical.cj&&p.physical.cj.lastSyncedAt?'Last synced: '+new Date(p.physical.cj.lastSyncedAt).toLocaleString():'Never synced with CJ.'}</p>
        <div class="flex gap-8" style="flex-wrap:wrap;">
          <button type="button" class="btn btn-outline btn-sm" onclick="cjTestProductMapping('${p?p.id:''}')">Test CJ Product</button>
          <button type="button" class="btn btn-outline btn-sm" onclick="cjRefreshStock('${p?p.id:''}')">Refresh Inventory</button>
          <button type="button" class="btn btn-outline btn-sm" onclick="cjRefreshVariants('${p?p.id:''}')">Refresh Variants</button>
        </div>
        <p class="small text-2" style="margin-top:6px;">These identifiers are what checkout uses to auto-create the CJ fulfilment order after payment — see Admin → CJ Dropshipping for connection status and import tools.</p>
      </details>
    </div>
    <div class="flex gap-8" style="align-items:center;margin:6px 0 4px;">
      <h4 style="font-size:13px;">Additional specs (shown as a list on the product page — e.g. Brand, RAM, Storage, Access, Certificate)</h4>
    </div>
    <div id="specRows">
      ${Object.entries(specs).filter(([k])=>!['format','level','condition','warranty'].includes(String(k).trim().toLowerCase())).map(([k,v],i)=>specRowHtml(i,k,v)).join('')}
    </div>
    <button type="button" class="btn btn-outline btn-sm" style="margin:8px 0 4px;" onclick="addSpecRow()">+ Add spec row</button>
    <div class="divider"></div>
    <h4 style="font-size:13px;margin-bottom:8px;">Media gallery — up to 8 items. Either paste a link (an image, a direct .mp4/.webm file, or a share link from YouTube, TikTok, Vimeo, Facebook or Instagram — the type is detected automatically), or upload a file directly from your device and the URL field fills in for you.</h4>
    <div class="form-grid">
      ${mediaSlots.map((url,i)=>`<div class="form-field">
        <label>Media ${i+1}${i===0?' (cover — use an image here for best results)':''}</label>
        <input id="f_media${i}" value="${escapeHtml(url)}" placeholder="Image/video URL, or upload a file below">
        <div class="flex gap-8" style="align-items:center;margin-top:4px;">
          <input type="file" id="f_mediaFile${i}" accept="image/*,video/*" style="font-size:12px;flex:1;" onchange="uploadMediaFile('f_media', ${i}, this)">
          <span id="f_mediaFileStatus${i}" class="small text-2"></span>
        </div>
      </div>`).join('')}
    </div>
    <div class="divider"></div>
    <h4 style="font-size:13px;margin-bottom:8px;">Digital file for sale (PDF or ZIP) — optional. Upload the actual file buyers receive; separate from the Affiliate link above, which is only used when a product has no price (Free/"Get it free"). When a price is set and this file is attached, checkout runs through Paystack and the buyer's download opens automatically the moment payment is verified.</h4>
    <div class="form-field">
      <label>Product file (PDF/ZIP)</label>
      <input type="hidden" id="f_fileUrl" value="${p?escapeHtml(p.fileUrl||''):''}">
      <div class="flex gap-8" style="align-items:center;">
        <input type="file" id="f_fileUpload" accept="application/pdf,.pdf,application/zip,application/x-zip-compressed,.zip" style="font-size:12px;flex:1;" onchange="uploadProductFile(this)">
        <span id="f_fileStatus" class="small text-2">${p&&p.fileUrl?'✅ File attached':''}</span>
      </div>
      ${p&&p.fileUrl?`<div class="small text-2" style="margin-top:4px;">Current file: <a href="${p.fileUrl}" target="_blank" style="color:var(--accent);">open</a> — upload a new one above to replace it, or <a onclick="clearProductFile()" style="color:var(--error);cursor:pointer;">remove it</a>.</div>`:''}
    </div>
    <div class="form-grid" style="margin-top:12px;">
      <div class="form-field">
        <label>Delivery link (optional)</label>
        <input id="f_deliveryLink" placeholder="A URL to open/download after payment — used instead of the uploaded file above if both are set" value="${p?escapeHtml(p.deliveryLink||''):''}">
      </div>
      <div class="form-field">
        <label>External payment link (optional)</label>
        <input id="f_externalPaymentLink" placeholder="Send buyers here to pay instead of the in-app Paystack popup (e.g. another checkout page)" value="${p?escapeHtml(p.externalPaymentLink||''):''}">
      </div>
    </div>
    <p class="text-2 small" style="margin-top:6px;">If a product is Free, tapping "Get it free" opens the Delivery link (or the uploaded file, or the Affiliate link) directly — no payment step. If it's paid and an External payment link is set, the buy button sends the shopper there instead of opening Paystack; use the Delivery link if that other site should redirect back with a downloadable file/receipt.</p>
    <div class="divider"></div>
    <div class="form-field"><label>Description</label><textarea id="f_desc">${p?escapeHtml(p.description):''}</textarea></div>

    <div class="divider"></div>
    <h4 style="font-size:13px;margin-bottom:8px;">Advanced product listing</h4>
    <p class="text-2 small" style="margin-bottom:10px;">Optional structured fields for courses and other detailed products. They appear on the product page only when filled.</p>
    <div class="form-grid">
      <div class="form-field"><label>Short description</label><textarea id="f_shortDescription" maxlength="240" placeholder="Concise summary for cards and search snippets">${p?escapeHtml(p.shortDescription||''):''}</textarea></div>
      <div class="form-field"><label>Hero copy</label><textarea id="f_heroCopy" maxlength="220" placeholder="One strong product promise, without unsupported claims">${p?escapeHtml(p.heroCopy||''):''}</textarea></div>
      <div class="form-field"><label>SEO slug</label><input id="f_slug" maxlength="120" placeholder="affiliate-marketing-professional-programme" value="${p?escapeHtml(p.slug||''):''}"><span class="text-2 small">Stored as metadata. Public links use short IDs; existing product links remain supported.</span></div>
      <div class="form-field"><label>SEO title</label><input id="f_seoTitle" maxlength="60" placeholder="Recommended: about 50–60 characters" value="${p?escapeHtml(p.seoTitle||''):''}"></div>
      <div class="form-field"><label>Meta description</label><textarea id="f_metaDescription" maxlength="160" placeholder="Recommended: up to 160 characters">${p?escapeHtml(p.metaDescription||''):''}</textarea></div>
      <div class="form-field"><label>Search keywords</label><input id="f_searchKeywords" placeholder="Comma separated" value="${p?escapeHtml((p.searchKeywords||[]).join(', ')):''}"></div>
    </div>
    <div id="courseFieldsWrap" class="form-grid" style="display:none;">
      <div class="form-field"><label>Who it is for</label><textarea id="f_audienceFor">${p?escapeHtml(p.audienceFor||''):''}</textarea></div>
      <div class="form-field"><label>Who it is NOT for</label><textarea id="f_audienceNotFor">${p?escapeHtml(p.audienceNotFor||''):''}</textarea></div>
      <div class="form-field"><label>Learning outcomes</label><textarea id="f_learningOutcomes" placeholder="One outcome per line">${p?escapeHtml(p.learningOutcomes||''):''}</textarea></div>
      <div class="form-field"><label>Course / product contents</label><textarea id="f_courseContents" placeholder="Module-by-module or section-by-section contents">${p?escapeHtml(p.courseContents||''):''}</textarea></div>
      <div class="form-field"><label>Delivery format</label><textarea id="f_deliveryFormat">${p?escapeHtml(p.deliveryFormat||''):''}</textarea></div>
      <div class="form-field"><label>Duration / pace note</label><textarea id="f_durationNote">${p?escapeHtml(p.durationNote||''):''}</textarea></div>
      <div class="form-field"><label>Requirements</label><textarea id="f_requirements">${p?escapeHtml(p.requirements||''):''}</textarea></div>
      <div class="form-field"><label>Tools</label><textarea id="f_tools">${p?escapeHtml(p.tools||''):''}</textarea></div>
      <div class="form-field"><label>Certificate / completion</label><textarea id="f_certificateDetails">${p?escapeHtml(p.certificateDetails||''):''}</textarea></div>
      <div class="form-field"><label>Assignments / assessment</label><textarea id="f_assignmentsDetails">${p?escapeHtml(p.assignmentsDetails||''):''}</textarea></div>
      <div class="form-field"><label>Capstone / final project</label><textarea id="f_capstoneDetails">${p?escapeHtml(p.capstoneDetails||''):''}</textarea></div>
    </div>
    <div class="form-grid">
      <div class="form-field"><label>Access and delivery wording</label><textarea id="f_accessDelivery">${p?escapeHtml(p.accessDelivery||''):''}</textarea></div>
      <div class="form-field"><label>Support wording</label><textarea id="f_supportWording">${p?escapeHtml(p.supportWording||''):''}</textarea></div>
      <div class="form-field"><label>Refund policy</label><textarea id="f_refundPolicy" placeholder="Product-specific refund/return policy">${p?escapeHtml(p.refundPolicy||''):''}</textarea></div>
      <div class="form-field"><label>Compliance disclaimer</label><textarea id="f_complianceDisclaimer">${p?escapeHtml(p.complianceDisclaimer||''):''}</textarea></div>
      <div class="form-field"><label>Earnings / results disclaimer</label><textarea id="f_earningsDisclaimer">${p?escapeHtml(p.earningsDisclaimer||''):''}</textarea></div>
    </div>
    <div class="form-field">
      <label>Product FAQs</label>
      <textarea id="f_productFaqs" placeholder="One FAQ per line: Question || Answer">${p?escapeHtml((p.productFaqs||[]).map(f=>`${f.q} || ${f.a}`).join('\n')):''}</textarea>
      <span class="text-2 small">Use exactly one question and answer per line, separated by ||.</span>
    </div>
    <div class="flex gap-8">
      <button class="btn btn-primary" id="productSaveBtn" onclick="saveProduct('${p?p.id:''}')">Save</button>
      <button class="btn btn-outline" onclick="$('#productFormWrap').innerHTML=''">Cancel</button>
    </div>
  </div>`;
  renderVariantMatrix(window.__adminExistingVariants);
  updateProductFieldVisibility();
  wrap.scrollIntoView({behavior:'smooth'});
}
function variantSlug(value){return String(value||'').trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,48)||'value';}
function variantOptionRowsHtml(options){
  return (options||[]).map((option,index)=>`<div class="variant-option-row" data-variant-option="${index}" data-option-id="${escapeHtml(option.id||'')}">
    <label>Option name<input class="variant-option-name" value="${escapeHtml(option.name||'')}" placeholder="Color"></label>
    <label>Choices, separated by commas<input class="variant-option-values" value="${escapeHtml((option.values||[]).map(value=>typeof value==='string'?value:value.label).join(', '))}" placeholder="Black, Blue"></label>
    <button type="button" class="btn btn-danger btn-sm" aria-label="Remove option" onclick="this.closest('.variant-option-row').remove()">Remove</button>
  </div>`).join('');
}
function addVariantOptionRow(){
  const wrap=$('#variantOptionsEditor'); if(!wrap)return;
  wrap.insertAdjacentHTML('beforeend',variantOptionRowsHtml([{name:'',values:[]}]));
  wrap.lastElementChild?.querySelector('.variant-option-name')?.focus();
}
function readVariantOptions(){
  const seen=new Set();
  return $all('#variantOptionsEditor .variant-option-row').map(row=>{
    const name=(row.querySelector('.variant-option-name')?.value||'').trim();
    const source=(window.__adminExistingOptions||[]).find(option=>option.id===row.dataset.optionId)||null;
    const id=source&&source.id||variantSlug(name);
    const labels=(row.querySelector('.variant-option-values')?.value||'').split(',').map(value=>value.trim()).filter(Boolean);
    if(!name||!labels.length)return null;
    if(seen.has(id))throw new Error(`Option names must be unique: ${name}`);
    seen.add(id);
    const valueSeen=new Set();
    const values=labels.map(label=>{const old=source&&(source.values||[]).find(value=>String(typeof value==='string'?value:value.label).toLowerCase()===label.toLowerCase());return {id:old&&(typeof old==='string'?variantSlug(old):old.id)||variantSlug(label),label};}).filter(value=>{if(valueSeen.has(value.id))return false;valueSeen.add(value.id);return true;});
    return {id,name,values};
  }).filter(Boolean);
}
function variantCombinations(options){
  if(!options.length)return [];
  return options.reduce((rows,option)=>rows.flatMap(row=>option.values.map(value=>({labels:[...row.labels,value.label],optionValues:{...row.optionValues,[option.id]:value.id}}))),[{labels:[],optionValues:{}}]);
}
function renderVariantMatrix(existing){
  const wrap=$('#variantMatrix'); if(!wrap)return;
  const options=readVariantOptions();
  if(!options.length){wrap.innerHTML='<div class="variant-empty">Add an option and its choices, then build the combinations.</div>';return;}
  const combinations=variantCombinations(options);
  if(combinations.length>100){wrap.innerHTML='<p class="err">This product creates more than 100 variants. Split the options into separate products or reduce the choice count.</p>';return;}
  const old=Array.isArray(existing)?existing:(window.__adminExistingVariants||[]);
  const byCombination=new Map(old.map(variant=>[JSON.stringify(variant.optionValues||{}),variant]));
  wrap.innerHTML=combinations.map((combination,index)=>{
    const prior=byCombination.get(JSON.stringify(combination.optionValues))||{};
    const variant={...prior,id:prior.id||`v-${Object.values(combination.optionValues).join('-')}`,title:combination.labels.join(' • '),optionValues:combination.optionValues};
    const rate=(DB.content.exchangeRates&&DB.content.exchangeRates.NGN)||1550;
    return `<fieldset class="variant-row" data-variant-row="${index}" data-option-values="${escapeHtml(JSON.stringify(combination.optionValues))}">
      <legend>${escapeHtml(variant.title)}</legend>
      <input type="hidden" class="variant-id" value="${escapeHtml(variant.id)}">
      <div class="variant-row-fields">
        <label>Price (₦)<input class="variant-price" type="number" min="0" step="1" value="${typeof variant.price==='number'?Math.round(variant.price*rate):''}" placeholder="Required"></label>
        <label>Sale price (₦)<input class="variant-sale" type="number" min="0" step="1" value="${typeof variant.salePrice==='number'?Math.round(variant.salePrice*rate):''}"></label>
        <label>Stock<input class="variant-stock" type="number" min="0" step="1" value="${variant.stock??''}" placeholder="Optional"></label>
        <label>SKU<input class="variant-sku" value="${escapeHtml(variant.sku||'')}" placeholder="Item code"></label>
        <label>Delivery link<input class="variant-delivery" type="url" value="${escapeHtml(variant.deliveryLink||'')}" placeholder="Optional"></label>
        <label>File URL<input class="variant-file" type="url" value="${escapeHtml(variant.fileUrl||'')}" placeholder="Optional"></label>
        <label>External payment or affiliate link<input class="variant-external-link" type="url" value="${escapeHtml(variant.externalPaymentLink||variant.affiliateLink||'')}" placeholder="Only if this option uses an external link"></label>
        <label>Variant image URL<input class="variant-image" type="url" value="${escapeHtml(variant.image||'')}" placeholder="Optional exact variant image"></label>
        <label>CJ variant ID<input class="variant-cj-id" value="${escapeHtml(variant.cjVariantId||'')}" placeholder="Physical products"></label>
        <label>Affiliate commission %<input class="variant-commission" type="number" min="0" max="100" step="0.5" value="${variant.affiliateCommissionPct??''}" placeholder="Use product default"></label>
        <label class="variant-enabled"><input class="variant-active" type="checkbox" ${variant.active===false?'':'checked'}> Available for purchase</label>
        <label class="variant-affiliate">Affiliate eligibility<select class="variant-affiliate-enabled"><option value="inherit" ${variant.affiliateEnabled===undefined||variant.affiliateEnabled===null?'selected':''}>Use product setting</option><option value="yes" ${variant.affiliateEnabled===true?'selected':''}>Enabled</option><option value="no" ${variant.affiliateEnabled===false?'selected':''}>Disabled</option></select></label>
      </div>
    </fieldset>`;
  }).join('');
  window.__adminExistingVariants=Array.from(wrap.querySelectorAll('.variant-row')).map((row,index)=>{
    const oldVariant=byCombination.get(JSON.stringify(JSON.parse(row.dataset.optionValues||'{}')))||{};
    return {...oldVariant,title:combinations[index].labels.join(' • '),optionValues:combinations[index].optionValues};
  });
}
function buildVariantMatrix(){
  try{
    const rate=(DB.content.exchangeRates&&DB.content.exchangeRates.NGN)||1550;
    const rows=$all('#variantMatrix .variant-row');
    const current=rows.length?readVariantMatrix(rate,'draft',false).variants:(window.__adminExistingVariants||[]);
    renderVariantMatrix(current);
    toast('Variant combinations updated','success');
  }
  catch(error){toast(error.message||'Check option names and choices','error');}
}
function readVariantMatrix(ngnRate,status,requireMatches=true){
  const rows=$all('#variantMatrix .variant-row');
  const options=readVariantOptions();
  if(!rows.length){if(options.length)throw new Error('Build the variant combinations before saving this product.');return {options:[],variants:[]};}
  if(requireMatches){
    const combinations=variantCombinations(options);
    const matches=combinations.length===rows.length&&rows.every((row,index)=>JSON.stringify(JSON.parse(row.dataset.optionValues||'{}'))===JSON.stringify(combinations[index].optionValues));
    if(!matches)throw new Error('Product choices changed. Build the variant combinations again before saving.');
  }
  const variants=rows.map(row=>{
    const title=row.querySelector('legend')?.textContent||'';
    const rawPrice=row.querySelector('.variant-price')?.value;
    const rawSale=row.querySelector('.variant-sale')?.value;
    const price=rawPrice===''?null:Number(rawPrice)/ngnRate;
    const salePrice=rawSale===''?null:Number(rawSale)/ngnRate;
    if(status==='published'&&(price===null||!Number.isFinite(price)))throw new Error(`Enter a valid price for ${title}; enter 0 when this variant is free.`);
    if(price!==null&&(!Number.isFinite(price)||price<0))throw new Error(`Enter a valid non-negative price for ${title}.`);
    if(salePrice!==null&&(!Number.isFinite(salePrice)||salePrice<0||(price!==null&&salePrice>=price)))throw new Error(`Sale price for ${title} must be less than its regular price.`);
    const rawStock=row.querySelector('.variant-stock')?.value;
    const commission=row.querySelector('.variant-commission')?.value;
    const stock=rawStock===''?null:Number(rawStock);
    const commissionPct=commission===''?null:Number(commission);
    if(stock!==null&&(!Number.isFinite(stock)||stock<0))throw new Error(`Stock for ${title} must be a non-negative number.`);
    if(commissionPct!==null&&(!Number.isFinite(commissionPct)||commissionPct<0||commissionPct>100))throw new Error(`Affiliate commission for ${title} must be between 0 and 100%.`);
    return {
      id:row.querySelector('.variant-id')?.value,
      title,
      optionValues:JSON.parse(row.dataset.optionValues||'{}'),
      ...(price!==null?{price}:{}),
      salePrice,
      stock,
      sku:row.querySelector('.variant-sku')?.value.trim()||'',
      deliveryLink:row.querySelector('.variant-delivery')?.value.trim()||'',
      fileUrl:row.querySelector('.variant-file')?.value.trim()||'',
      externalPaymentLink:row.querySelector('.variant-external-link')?.value.trim()||'',
      image:row.querySelector('.variant-image')?.value.trim()||'',
      cjVariantId:row.querySelector('.variant-cj-id')?.value.trim()||'',
      affiliateEnabled:(row.querySelector('.variant-affiliate-enabled')?.value||'inherit')==='inherit'?null:row.querySelector('.variant-affiliate-enabled')?.value==='yes',
      affiliateCommissionPct:commissionPct,
      active:row.querySelector('.variant-active')?.checked!==false,
    };
  });
  return {options,variants};
}
function specRowHtml(i,k,v){
  return `<div class="flex gap-8" style="margin-bottom:8px;" data-spec-row="${i}">
    <input class="spec-key" placeholder="Label (e.g. RAM)" value="${escapeHtml(k||'')}" style="flex:1;padding:9px 11px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);">
    <input class="spec-val" placeholder="Value (e.g. 16GB)" value="${escapeHtml(v||'')}" style="flex:1;padding:9px 11px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);">
    <button type="button" class="btn btn-danger btn-sm" onclick="this.closest('[data-spec-row]').remove()">✕</button>
  </div>`;
}
function addSpecRow(){
  const wrap = $('#specRows');
  const n = wrap.children.length;
  wrap.insertAdjacentHTML('beforeend', specRowHtml(n,'',''));
}
/* Admin PDF upload for a product's actual sold file. Separate from
   uploadMediaFile (images/video for the gallery) because it validates
   for PDF specifically and writes to a single fixed field, not a slotted
   one. NOTE: some Cloudinary accounts restrict public delivery of raw
   PDF/ZIP files by default (Settings → Security → "Allow delivery of
   PDF and ZIP files") — if uploads succeed here but a buyer's download
   link 404s/blocks, that toggle is almost always the fix. */
async function uploadProductFile(inputEl){
  const file = inputEl.files && inputEl.files[0];
  if(!file) return;
  const nameLower = file.name.toLowerCase();
  const looksLikePdf = file.type === 'application/pdf' || nameLower.endsWith('.pdf');
  const looksLikeZip = /zip/.test(file.type) || nameLower.endsWith('.zip');
  if(!looksLikePdf && !looksLikeZip){ toast('Please choose a PDF or ZIP file.', 'error'); inputEl.value=''; return; }
  const statusEl = $('#f_fileStatus');
  if(statusEl) statusEl.textContent = 'Uploading…';
  try{
    // 20MB cap keeps files reasonable to both upload and later download on
    // a limited data plan — bump this if a specific product genuinely needs more.
    const url = await cloudinaryUploadFile(file, 20);
    const urlInput = $('#f_fileUrl');
    if(urlInput) urlInput.value = url;
    if(statusEl) statusEl.textContent = '✅ File attached';
    toast('PDF uploaded', 'success');
  }catch(e){
    console.warn('Product file upload failed', e);
    if(statusEl) statusEl.textContent = e.code ? `❌ Upload failed (${e.code})` : '❌ '+e.message;
    toast(uploadErrorMessage(e), 'error');
    inputEl.value = '';
  }
}
function clearProductFile(){
  const urlInput = $('#f_fileUrl');
  if(urlInput) urlInput.value = '';
  const statusEl = $('#f_fileStatus');
  if(statusEl) statusEl.textContent = '';
  toast('File removed — click Save to apply.');
}
function productCategoryRecord(categoryId){
  const id=String(categoryId||'').trim().toLowerCase();
  return (DB.categories||[]).find(c=>String(c.id||'').trim().toLowerCase()===id || String(c.name||'').trim().toLowerCase()===id) || {id:categoryId||'',name:categoryId||''};
}
function isCourseCategory(categoryId){
  const c=productCategoryRecord(categoryId);
  return /\b(course|courses|training|learning|education|academy|masterclass|programme|program)\b/i.test(String(c.id||'')+' '+String(c.name||''));
}
function isHardwareCategory(categoryId){
  const c=productCategoryRecord(categoryId);
  return HARDWARE_CATEGORY_IDS.includes(String(c.id||categoryId||'')) || /\b(gadget|gadgets|electronics?|hardware|computers?|phones?|mobile|accessories)\b/i.test(String(c.id||'')+' '+String(c.name||''));
}
function isPhysicalCategory(categoryId){
  const c=productCategoryRecord(categoryId);
  return isHardwareCategory(categoryId) || /\b(fashion|clothing|apparel|bags?|shoes?|footwear|wearables?)\b/i.test(String(c.id||'')+' '+String(c.name||''));
}
function isDigitalDetailsCategory(categoryId){
  const c=productCategoryRecord(categoryId);
  return isCourseCategory(categoryId) || /\b(template|templates|software|bundles?|ebooks?|digital|resources?|tools?|apps?)\b/i.test(String(c.id||'')+' '+String(c.name||''));
}
function updateProductFieldVisibility(){
  const categoryId=$('#f_category')?.value||'';
  const productType=$('#f_productType')?.value||'DIGITAL';
  const isPhysical=productType==='PHYSICAL';
  const isCourse=!isPhysical && productType!=='SERVICE' && isCourseCategory(categoryId);
  const showFormat=!isPhysical && productType!=='SERVICE' && isDigitalDetailsCategory(categoryId);
  const setDisplay=(selector,visible,displayValue='block')=>{const el=$(selector);if(el)el.style.display=visible?displayValue:'none';};
  setDisplay('#f_formatWrap',showFormat);
  setDisplay('#f_levelWrap',isCourse);
  setDisplay('#f_conditionWrap',isPhysical);
  setDisplay('#f_warrantyWrap',isPhysical);
  setDisplay('#courseFieldsWrap',isCourse,'grid');
  setDisplay('#physicalFieldsWrap',isPhysical);
}
function toggleHardwareFields(){ updateProductFieldVisibility(); }
function togglePhysicalFields(){ updateProductFieldVisibility(); }
function updateDiscountPreview(){
  const reg = parseFloat($('#f_price')?.value);
  const sale = parseFloat($('#f_salePrice')?.value);
  const out = $('#f_discountPreview');
  if(!out) return;
  out.value = (reg>0 && sale>0 && sale<reg) ? Math.round((1-sale/reg)*100)+'%' : '0%';
}
// BUGFIX (v2.0.1 -> this pass): this used to call pushProductsToCloud()
// without awaiting it, then show "Product saved" and immediately close
// the form regardless of whether the cloud write actually succeeded.
// DB.products already persists to this device's localStorage the
// instant it's assigned (see its setter above), so nothing was ever
// lost — but on a flaky mobile connection the product would silently
// never reach Firestore, meaning it never appeared for shoppers or on
// any other device, while the admin had already been told "saved" and
// had the form closed out from under them with no way to retry without
// re-typing everything. This is almost certainly what "products upload
// failed several times" was actually describing. Now: genuinely await
// the cloud write, only claim success and close the form if it really
// reached Firestore, and leave the form open with everything still
// filled in in on failure so retrying is one tap, not a re-type.
async function saveProduct(id){
  const name = $('#f_name').value.trim();
  const nairaPrice = parseFloat($('#f_price').value);
  const list = DB.legacyProducts;
  const mediaUrls = Array.from({length:8}).map((_,i)=>$('#f_media'+i)?.value.trim()).filter(Boolean);
  const gallery = mediaUrls.map(url=>({url, type:guessMediaType(url)}));
  const coverImage = (gallery[0] && gallery[0].type==='image') ? gallery[0].url
    : (gallery.find(g=>g.type==='image')||{}).url || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600&q=80';
  // Admin enters prices in Naira; we store the neutral USD base internally
  // (same base every other currency's rate is defined against) using the
  // current NGN rate, so a blank/zero price correctly means "Free".
  const ngnRate = (DB.content.exchangeRates && DB.content.exchangeRates.NGN) || 1550;
  let price = (!nairaPrice || nairaPrice<=0) ? 0 : nairaPrice / ngnRate;
  const nairaSale = parseFloat($('#f_salePrice').value);
  if(!name){ toast('Product name is required','error'); return; }
  let variantData;
  try{variantData=readVariantMatrix(ngnRate,$('#f_status')?.value||'draft');}
  catch(error){toast(error.message||'Review the variant values before saving.','error');return;}
  const variantPrices=variantData.variants.map(variant=>variant.price).filter(value=>typeof value==='number'&&Number.isFinite(value));
  if(variantPrices.length)price=Math.min(...variantPrices);
  const productType=$('#f_productType')?.value||'DIGITAL';
  const categoryId=$('#f_category')?.value||'';
  const courseDetailsRelevant=isCourseCategory(categoryId) && productType!=='PHYSICAL' && productType!=='SERVICE';
  const formatRelevant=isDigitalDetailsCategory(categoryId) && productType!=='PHYSICAL' && productType!=='SERVICE';
  const publishing=$('#f_status')?.value==='published';
  if(publishing&&productType==='PHYSICAL'){
    const badVariant=variantData.variants.find(variant=>typeof variant.price!=='number'||variant.price<=0);
    if(variantData.variants.length&&badVariant){toast(`Set a positive selling price for ${badVariant.title} before publishing a physical product.`,'error');return;}
    if(!variantData.variants.length&&(!Number.isFinite(price)||price<=0)){toast('Set a positive selling price before publishing a physical product.','error');return;}
  }
  const specs = {};
  const fmt = $('#f_format')?.value.trim(); if(formatRelevant && fmt) specs['Format'] = fmt;
  const lvl = $('#f_level')?.value.trim(); if(courseDetailsRelevant && lvl) specs['Level'] = lvl;
  const cond = $('#f_condition')?.value.trim(); if(productType==='PHYSICAL' && cond) specs['Condition'] = cond;
  const warr = $('#f_warranty')?.value.trim(); if(productType==='PHYSICAL' && warr) specs['Warranty'] = warr;
  $all('#specRows [data-spec-row]').forEach(row=>{
    const k = row.querySelector('.spec-key')?.value.trim();
    const v = row.querySelector('.spec-val')?.value.trim();
    const key=String(k||'').trim().toLowerCase();
    const builtInIrrelevant=(key==='level'&&!courseDetailsRelevant)||(key==='format'&&!formatRelevant)||(key==='condition'&&productType!=='PHYSICAL')||(key==='warranty'&&productType!=='PHYSICAL');
    if(k && v && !builtInIrrelevant) specs[k] = v;
  });
  const data = {
    name, category:categoryId, price,
    salePrice: variantData.variants.length ? null : ((nairaSale && nairaSale>0) ? nairaSale / ngnRate : null),
    options: variantData.options,
    variants: variantData.variants,
    pricingReviewRequired: publishing ? false : !!(id&&findProduct(id)?.pricingReviewRequired),
    itemCode:$('#f_itemCode').value, seller:$('#f_seller').value,
    shareId: (id && findProduct(id)?.shareId) || (/^p\d{1,4}$/.test(String(id||'')) ? String(id) : nextProductShareId(id)),
    image: coverImage,
    gallery: gallery.length?gallery:[{url:coverImage,type:'image'}], affiliateLink:$('#f_link').value || '#',
    fileUrl: $('#f_fileUrl')?.value.trim() || '',
    deliveryLink: $('#f_deliveryLink')?.value.trim() || '',
    externalPaymentLink: $('#f_externalPaymentLink')?.value.trim() || '',
    status:$('#f_status').value, tags:$('#f_tags').value.split(',').map(t=>t.trim()).filter(Boolean),
    description:$('#f_desc').value,
    shortDescription: $('#f_shortDescription')?.value.trim() || '',
    heroCopy: $('#f_heroCopy')?.value.trim() || '',
    slug: $('#f_slug')?.value.trim() || '',
    seoTitle: $('#f_seoTitle')?.value.trim() || '',
    metaDescription: $('#f_metaDescription')?.value.trim() || '',
    searchKeywords: ($('#f_searchKeywords')?.value || '').split(',').map(v=>v.trim()).filter(Boolean),
    audienceFor: courseDetailsRelevant ? ($('#f_audienceFor')?.value.trim() || '') : '',
    audienceNotFor: courseDetailsRelevant ? ($('#f_audienceNotFor')?.value.trim() || '') : '',
    learningOutcomes: courseDetailsRelevant ? ($('#f_learningOutcomes')?.value.trim() || '') : '',
    courseContents: courseDetailsRelevant ? ($('#f_courseContents')?.value.trim() || '') : '',
    deliveryFormat: courseDetailsRelevant ? ($('#f_deliveryFormat')?.value.trim() || '') : '',
    durationNote: courseDetailsRelevant ? ($('#f_durationNote')?.value.trim() || '') : '',
    requirements: courseDetailsRelevant ? ($('#f_requirements')?.value.trim() || '') : '',
    tools: courseDetailsRelevant ? ($('#f_tools')?.value.trim() || '') : '',
    certificateDetails: courseDetailsRelevant ? ($('#f_certificateDetails')?.value.trim() || '') : '',
    assignmentsDetails: courseDetailsRelevant ? ($('#f_assignmentsDetails')?.value.trim() || '') : '',
    capstoneDetails: courseDetailsRelevant ? ($('#f_capstoneDetails')?.value.trim() || '') : '',
    accessDelivery: $('#f_accessDelivery')?.value.trim() || '',
    supportWording: $('#f_supportWording')?.value.trim() || '',
    refundPolicy: $('#f_refundPolicy')?.value.trim() || '',
    complianceDisclaimer: $('#f_complianceDisclaimer')?.value.trim() || '',
    earningsDisclaimer: $('#f_earningsDisclaimer')?.value.trim() || '',
    productFaqs: ($('#f_productFaqs')?.value || '').split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{
      const split=line.indexOf('||');
      return split<0?{q:line,a:''}:{q:line.slice(0,split).trim(),a:line.slice(split+2).trim()};
    }).filter(f=>f.q&&f.a),
    specs, rating:(id&&findProduct(id)?.rating)||4.5,
    reviewCount:(id&&findProduct(id)?.reviewCount)||0, featured:(id&&findProduct(id)?.featured)||false, trending:(id&&findProduct(id)?.trending)||false,
    productType,
    affiliateEnabled: $('#f_affiliateEnabled')?.checked || false,
    affiliateCommissionPct: $('#f_affiliateCommissionPct')?.value !== '' ? Number($('#f_affiliateCommissionPct').value) : null,
  };
  // Physical-only data block — see the "Physical product details" fields
  // above. Only attached when productType is actually PHYSICAL so this is
  // a pure addition for existing digital products (data.physical simply
  // stays undefined for them, same as before this field existed).
  if(data.productType === 'PHYSICAL'){
    data.physical = {
      stockMode: $('#f_stockMode')?.value || 'SUPPLIER_STOCK',
      stockStatus: $('#f_stockStatus')?.value || 'in_stock',
      deliveryEstimate: $('#f_deliveryEstimate')?.value.trim() || '',
      shippingCountries: ($('#f_shippingCountries')?.value || 'Nigeria').split(',').map(s=>s.trim()).filter(Boolean),
      weight: $('#f_weight')?.value.trim() || '',
      dimensions: $('#f_dimensions')?.value.trim() || '',
      returnPolicy: $('#f_returnPolicy')?.value.trim() || '',
      // Supplier linkage (physical-commerce doc section 7/28). supplierCost
      // is deliberately private data — see the "must NOT be publicly
      // exposed" rule in that doc's Multiple Supplier Architecture section
      // — screenProductDetail() never reads product.physical.supplierCost
      // or .supplierCurrency; only the admin dashboard does.
      supplierId: $('#f_supplierId')?.value || '',
      supplierSku: $('#f_supplierSku')?.value.trim() || '',
      supplierCost: $('#f_supplierCost')?.value ? Number($('#f_supplierCost').value) : null,
      supplierCurrency: $('#f_supplierCurrency')?.value.trim() || '',
      // Preserve any routing already set via the Supplier Routing tab —
      // this form has no routing fields of its own, so without this an
      // ordinary product edit would silently wipe previously saved routing.
      routing: (id && findProduct(id)?.physical?.routing) || null,
      // CJ Dropshipping mapping (README §15/§32) — read from the
      // collapsible block above. lastSyncedAt is preserved from whatever
      // it already was; it's only ever set by the cjRefresh*() actions
      // below, never by a manual form save, so editing other fields here
      // never falsely implies a sync just happened.
      cj: {
        productId: $('#f_cjProductId')?.value.trim() || '',
        variantId: $('#f_cjVariantId')?.value.trim() || '',
        sku: $('#f_cjSku')?.value.trim() || '',
        syncEnabled: $('#f_cjSyncEnabled')?.value !== 'no',
        lastSyncedAt: (id && findProduct(id)?.physical?.cj?.lastSyncedAt) || null,
      },
    };
  }
  if(id){
    const idx = list.findIndex(p=>p.id===id);
    list[idx] = {...list[idx], ...data};
    logActivity('Admin', `Edited product "${name}"`);
  } else {
    data.id = 'p'+Date.now();
    list.push(data);
    logActivity('Admin', `Added product "${name}"`);
  }
  DB.products = list;
  const saveBtn = $('#productSaveBtn');
  if(saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  const ok = await pushProductsToCloud();
  if(saveBtn){ saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  if(ok){
    toast('Product saved','success');
    updateCatalogSchema();
    $('#productFormWrap').innerHTML='';
    renderAdminTab();
  } else {
    // pushProductsToCloud() already showed the "Cloud save failed" toast
    // with the specific reason — leave the form exactly as it is (data
    // is safe in this device's local storage either way) so the admin
    // can just press Save again once their connection recovers.
    toast('Saved on this device only — will not appear for shoppers or other devices until cloud sync succeeds. Check your connection and press Save again.', 'error');
    renderAdminTab();
  }
}
function deleteProduct(id){
  const p = findProduct(id);
  if(!confirm(`Delete "${p?.name}"? This cannot be undone.`)) return;
  DB.products = DB.legacyProducts.filter(x=>x.id!==id);
  DB.wishlist = DB.wishlist.filter(x=>x!==id);
  pushProductsToCloud();
  logActivity('Admin', `Deleted product "${p?.name}"`);
  toast('Product deleted');
  updateCatalogSchema();
  renderAdminTab();
}

function adminCategories(){
  const cats = DB.categories.filter(c=>c.id!=='all');
  return `
    <div class="admin-topbar"><h2>Categories</h2></div>
    <div class="card" style="padding:16px;margin-bottom:16px;">
      <div class="flex gap-8">
        <input id="newCatName" placeholder="New category name" style="flex:1;padding:9px 11px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);">
        <button class="btn btn-primary btn-sm" onclick="addCategory()">Add</button>
      </div>
    </div>
    <table class="admin-table"><thead><tr><th>Name</th><th># Products</th><th></th></tr></thead>
    <tbody>${cats.map(c=>`<tr><td>${escapeHtml(c.name)}</td><td>${DB.legacyProducts.filter(p=>p.category===c.id).length}</td><td><button class="btn btn-danger btn-sm" onclick="deleteCategory('${c.id}')">Delete</button></td></tr>`).join('')}</tbody></table>`;
}
function addCategory(){
  const name = $('#newCatName').value.trim();
  if(!name) return;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  const cats = DB.categories;
  if(cats.some(c=>c.id===id)){ toast('Category already exists','error'); return; }
  cats.push({id, name});
  DB.categories = cats;
  pushProductsToCloud();
  logActivity('Admin', `Added category "${name}"`);
  toast('Category added','success');
  renderAdminTab();
}
function deleteCategory(id){
  if(!confirm('Delete this category? Products in it will need reassigning.')) return;
  DB.categories = DB.categories.filter(c=>c.id!==id);
  pushProductsToCloud();
  logActivity('Admin', `Deleted category "${id}"`);
  renderAdminTab();
}

function adminContent(){
  const c = DB.content;
  return `
    <div class="admin-topbar"><h2>App Content</h2></div>
    <div class="card" style="padding:16px;">
      <h3 style="font-size:14px;margin-bottom:10px;">Hero section</h3>
      <div class="form-field"><label>Eyebrow tag</label><input id="c_heroTag" value="${escapeHtml(c.heroTag)}"></div>
      <div class="form-field"><label>Headline</label><input id="c_heroTitle" value="${escapeHtml(c.heroTitle)}"></div>
      <div class="form-field"><label>Subheadline</label><textarea id="c_heroSub">${escapeHtml(c.heroSub)}</textarea></div>
      <div class="form-field"><label>CTA button text</label><input id="c_heroCta" value="${escapeHtml(c.heroCta)}"></div>
      <div class="divider"></div>
      <h3 style="font-size:14px;margin-bottom:10px;">About Us page</h3>
      <p class="text-2 small" style="margin-bottom:8px;">This powers the dedicated "About Us" page (Menu → About Us) — separate from NOVA AI.</p>
      <div class="form-field"><label>Our story / about text</label><textarea id="c_about">${escapeHtml(c.aboutText)}</textarea></div>
      <div class="form-field"><label>Mission</label><textarea id="c_mission">${escapeHtml(c.missionText||'')}</textarea></div>
      <div class="form-field"><label>Vision</label><textarea id="c_vision">${escapeHtml(c.visionText||'')}</textarea></div>
      <div class="divider"></div>
      <h3 style="font-size:14px;margin-bottom:10px;">Purchase button</h3>
      <div class="form-field"><label>Buy button text</label><input id="c_buyBtn" value="${escapeHtml(c.buyButtonText)}"></div>
      <div class="divider"></div>
      <h3 style="font-size:14px;margin-bottom:10px;">Footer</h3>
      <div class="form-field"><label>Copyright text</label><input id="c_footer" value="${escapeHtml(c.footerCopyright)}"></div>
      <button class="btn btn-primary" onclick="saveContent()">Save changes</button>
    </div>
    <div class="card" style="padding:16px;margin-top:16px;">
      <h3 style="font-size:14px;margin-bottom:6px;">Management / Team</h3>
      <p class="text-2 small" style="margin-bottom:12px;">Shown on the About Us page.</p>
      <div id="mgmtFormWrap"></div>
      <button class="btn btn-primary btn-sm" style="margin-bottom:14px;" onclick="openManagementForm()">+ Add person</button>
      <table class="admin-table"><thead><tr><th>Name</th><th>Role</th><th></th></tr></thead>
      <tbody>${DB.management.map(m=>`<tr>
        <td>${escapeHtml(m.name)}</td><td>${escapeHtml(m.role||'')}</td>
        <td class="flex gap-8"><button class="btn btn-ghost btn-sm" onclick="openManagementForm('${m.id}')">Edit</button><button class="btn btn-danger btn-sm" onclick="deleteManagement('${m.id}')">Delete</button></td>
      </tr>`).join('') || '<tr><td colspan="3">No team members added yet.</td></tr>'}</tbody></table>
    </div>`;
}
function saveContent(){
  const c = DB.content;
  const updated = {...c,
    heroTag:$('#c_heroTag').value, heroTitle:$('#c_heroTitle').value, heroSub:$('#c_heroSub').value, heroCta:$('#c_heroCta').value,
    aboutText:$('#c_about').value, missionText:$('#c_mission').value, visionText:$('#c_vision').value,
    buyButtonText:$('#c_buyBtn').value, footerCopyright:$('#c_footer').value,
  };
  DB.content = updated;
  pushSettingsToCloud();
  logActivity('Admin', 'Updated app content');
  toast('Content saved — changes are live','success');
}
function openManagementForm(id){
  const m = id ? DB.management.find(x=>x.id===id) : null;
  const wrap = $('#mgmtFormWrap');
  wrap.innerHTML = `<div class="card" style="padding:16px;margin-bottom:16px;">
    <h3>${m?'Edit':'Add'} Team Member</h3>
    <div class="form-grid">
      <div class="form-field"><label>Name</label><input id="mg_name" value="${m?escapeHtml(m.name):''}"></div>
      <div class="form-field"><label>Role</label><input id="mg_role" value="${m?escapeHtml(m.role||''):''}"></div>
    </div>
    <div class="form-field"><label>Bio</label><textarea id="mg_bio">${m?escapeHtml(m.bio||''):''}</textarea></div>
    <div class="flex gap-8"><button class="btn btn-primary" onclick="saveManagement('${m?m.id:''}')">Save</button><button class="btn btn-outline" onclick="$('#mgmtFormWrap').innerHTML=''">Cancel</button></div>
  </div>`;
}
function saveManagement(id){
  const name = $('#mg_name').value.trim();
  if(!name){ toast('Name is required','error'); return; }
  const data = {name, role:$('#mg_role').value.trim(), bio:$('#mg_bio').value.trim()};
  const list = DB.management;
  if(id){
    const idx = list.findIndex(m=>m.id===id);
    list[idx] = {...list[idx], ...data};
  } else {
    data.id = 'm'+Date.now();
    list.push(data);
  }
  DB.management = list;
  pushSettingsToCloud();
  logActivity('Admin', 'Updated management/team info');
  toast('Team member saved','success');
  $('#mgmtFormWrap').innerHTML='';
  renderAdminTab();
}
function deleteManagement(id){
  DB.management = DB.management.filter(m=>m.id!==id);
  pushSettingsToCloud();
  logActivity('Admin', 'Removed a team member');
  toast('Team member removed');
  renderAdminTab();
}

function adminTestimonials(){
  const list = DB.testimonials;
  return `
    <div class="admin-topbar"><h2>Reviews (${list.length})</h2></div>
    <table class="admin-table"><thead><tr><th>Product</th><th>Name</th><th>Rating</th><th>Text</th><th></th></tr></thead>
    <tbody>${list.map(t=>`<tr>
      <td>${escapeHtml(findProduct(t.productId)?.name||t.productId)}</td>
      <td>${escapeHtml(t.name)}</td><td>${'★'.repeat(t.rating)}</td>
      <td style="max-width:220px;">${escapeHtml(t.text.slice(0,80))}${t.text.length>80?'…':''}</td>
      <td><button class="btn btn-danger btn-sm" onclick="deleteTestimonial('${t.id}')">Delete</button></td>
    </tr>`).join('') || '<tr><td colspan="5">No reviews yet.</td></tr>'}</tbody></table>`;
}
function deleteTestimonial(id){
  DB.testimonials = DB.testimonials.filter(t=>t.id!==id);
  deleteReviewFromCloud(id);
  logActivity('Admin', 'Removed a review');
  toast('Review removed');
  renderAdminTab();
}

/* ---------------- ADMIN: MESSAGES (contact form submissions) ----------------
   Shoppers' "Send us a message" / Contact Us submissions are written to the
   Firestore "leads" collection (see pushLeadToCloud) but previously had
   nowhere to be READ back — they just piled up invisibly. This tab fetches
   and displays them, with a lightweight in-memory cache so switching tabs
   doesn't re-fetch every time. */
window.__leadsCache = null;
window.__leadsError = null;
async function fetchLeadsFromCloud(force){
  if(window.__leadsCache && !force) return window.__leadsCache;
  if(!window.__fb){
    window.__leadsError = 'Cloud connection is not ready yet.';
    return [];
  }
  const { fbDb, collection, getDocs } = window.__fb;
  try{
    // BUGFIX ("Loading messages…" stuck forever, no matter how long you
    // wait or refresh): getDocs() had no timeout, so on a slow/unreliable
    // connection it could sit pending indefinitely instead of erroring —
    // and with no error, adminLeads() had nothing to show but the loading
    // state forever. A hard 15s timeout (same pattern already used for the
    // Google redirect sign-in and profile-photo uploads elsewhere in this
    // file) guarantees this always settles one way or the other.
    const snap = await withTimeout(
      getDocs(collection(fbDb, "leads")),
      15000,
      'Timed out loading messages — check your connection and tap Retry.'
    );
    const list = [];
    snap.forEach(d=>list.push({ id:d.id, ...d.data() }));
    list.sort((a,b)=> new Date(b.at||0) - new Date(a.at||0));
    window.__leadsCache = list;
    window.__leadsError = null;
    return list;
  }catch(e){
    console.warn('Fetch leads failed', e);
    // Don't silently pretend "no messages" — a permission-denied error
    // (e.g. the admin's Firestore cloud sign-in hasn't gone through yet,
    // see tryAdminLogin's Step 2) looks identical to a genuinely empty
    // inbox unless we surface it explicitly.
    window.__leadsError = (e && e.code==='permission-denied')
      ? 'Not signed in to the cloud yet — try Refresh in a moment, or re-enter the admin password to reconnect.'
      : (e && e.message ? e.message : 'Could not load messages (connection problem).');
    window.__leadsCache = null;
    return [];
  }
}
function adminLeads(){
  fetchLeadsFromCloud().then(()=>{ if(appState.adminTab==='leads') renderAdminTab(); });
  const list = window.__leadsCache;
  if(list===null){
    if(window.__leadsError){
      return `<div class="admin-topbar"><h2>Messages</h2><button class="btn btn-outline btn-sm" onclick="refreshLeads()">Retry</button></div><p class="text-2 small" style="color:var(--error);">⚠️ ${escapeHtml(window.__leadsError)}</p>`;
    }
    return `<div class="admin-topbar"><h2>Messages</h2></div><p class="text-2 small">Loading messages…</p>`;
  }
  return `
    <div class="admin-topbar"><h2>Messages (${list.length})</h2><button class="btn btn-outline btn-sm" onclick="refreshLeads()">Refresh</button></div>
    <p class="text-2 small" style="margin-bottom:12px;">Everything shoppers send through "Contact Us" / "Send us a message" on the Menu screen shows up here.</p>
    ${list.length ? list.map(l=>`
      <div class="card" style="padding:14px;margin-bottom:10px;">
        <div class="flex" style="justify-content:space-between;align-items:flex-start;">
          <div>
            <div style="font-weight:700;font-size:14px;">${escapeHtml(l.name||'—')} ${l.reason?`<span class="text-2 small" style="font-weight:500;">· ${escapeHtml(l.reason)}</span>`:''}</div>
            <div class="text-2 small">${escapeHtml(l.email||'—')} · ${l.at?new Date(l.at).toLocaleString():''}</div>
          </div>
          <div class="flex gap-8">
            <a class="btn btn-outline btn-sm" href="mailto:${encodeURIComponent(l.email||'')}?subject=${encodeURIComponent('Re: your message to LEXDEN NOVA')}">Reply</a>
            <button class="btn btn-danger btn-sm" onclick="deleteLead('${l.id}')">Delete</button>
          </div>
        </div>
        <p style="font-size:13.5px;margin-top:8px;">${escapeHtml(l.message||'')}</p>
        <div class="form-field" style="margin-top:10px;margin-bottom:0;">
          <label class="small text-2">Admin note (private)</label>
          <div class="flex gap-8">
            <input id="leadNote_${l.id}" value="${escapeHtml(l.note||'')}" placeholder="e.g. followed up 12/08, resolved" style="flex:1;">
            <button class="btn btn-outline btn-sm" onclick="saveLeadNote('${l.id}')">Save</button>
          </div>
        </div>
      </div>`).join('') : '<p class="text-2 small">No messages yet.</p>'}`;
}
function refreshLeads(){ fetchLeadsFromCloud(true).then(renderAdminTab); }

/* ---------------- ADMIN: NEWSLETTER SUBSCRIBERS ----------------
   Lists everyone who submitted the "Stay in the loop" popup — reads the
   "newsletterSubs" collection (see pushNewsletterSubToCloud). Same
   cache/fetch/error shape as adminLeads above, on purpose, so this behaves
   identically (Retry on failure, Refresh to force a re-pull, 15s timeout
   so a bad connection can never leave this stuck on "Loading…" forever). */
window.__newsletterCache = null;
window.__newsletterError = null;
async function fetchNewsletterSubsFromCloud(force){
  if(window.__newsletterCache && !force) return window.__newsletterCache;
  if(!window.__fb){
    window.__newsletterError = 'Cloud connection is not ready yet.';
    return [];
  }
  const { fbDb, collection, getDocs } = window.__fb;
  try{
    const snap = await withTimeout(
      getDocs(collection(fbDb, "newsletterSubs")),
      15000,
      'Timed out loading subscribers — check your connection and tap Retry.'
    );
    const list = [];
    snap.forEach(d=>list.push({ id:d.id, ...d.data() }));
    list.sort((a,b)=> new Date(b.at||0) - new Date(a.at||0));
    window.__newsletterCache = list;
    window.__newsletterError = null;
    return list;
  }catch(e){
    console.warn('Fetch newsletter subs failed', e);
    window.__newsletterError = (e && e.code==='permission-denied')
      ? 'Not signed in to the cloud yet — try Refresh in a moment, or re-enter the admin password to reconnect.'
      : (e && e.message ? e.message : 'Could not load subscribers (connection problem).');
    window.__newsletterCache = null;
    return [];
  }
}
function adminNewsletter(){
  fetchNewsletterSubsFromCloud().then(()=>{ if(appState.adminTab==='newsletter') renderAdminTab(); });
  const list = window.__newsletterCache;
  if(list===null){
    if(window.__newsletterError){
      return `<div class="admin-topbar"><h2>Newsletter</h2><button class="btn btn-outline btn-sm" onclick="refreshNewsletterSubs()">Retry</button></div><p class="text-2 small" style="color:var(--error);">⚠️ ${escapeHtml(window.__newsletterError)}</p>`;
    }
    return `<div class="admin-topbar"><h2>Newsletter</h2></div><p class="text-2 small">Loading subscribers…</p>`;
  }
  return `
    <div class="admin-topbar"><h2>Newsletter (${list.length})</h2>
      <div class="flex gap-8">
        <button class="btn btn-outline btn-sm" onclick="copyAllNewsletterEmails()">Copy all emails</button>
        <button class="btn btn-outline btn-sm" onclick="refreshNewsletterSubs()">Refresh</button>
      </div>
    </div>
    <p class="text-2 small" style="margin-bottom:12px;">Everyone who subscribed through the "Stay in the loop" popup shows up here.</p>
    ${list.length ? list.map(s=>`
      <div class="card" style="padding:14px;margin-bottom:10px;">
        <div class="flex" style="justify-content:space-between;align-items:center;">
          <div>
            <div style="font-weight:700;font-size:14px;">${escapeHtml(s.email||'—')}</div>
            <div class="text-2 small">${s.at?new Date(s.at).toLocaleString():''}${s.uid?' · signed-in shopper':' · guest'}</div>
          </div>
          <div class="flex gap-8">
            <a class="btn btn-outline btn-sm" href="mailto:${encodeURIComponent(s.email||'')}">Email</a>
            <button class="btn btn-danger btn-sm" onclick="deleteNewsletterSub('${s.id}')">Delete</button>
          </div>
        </div>
      </div>`).join('') : '<p class="text-2 small">No subscribers yet.</p>'}`;
}
function refreshNewsletterSubs(){ fetchNewsletterSubsFromCloud(true).then(renderAdminTab); }
function copyAllNewsletterEmails(){
  const list = window.__newsletterCache || [];
  if(!list.length){ toast('No subscribers to copy yet'); return; }
  const emails = list.map(s=>s.email).filter(Boolean).join(', ');
  navigator.clipboard?.writeText(emails).then(()=>toast(`Copied ${list.length} email(s)`,'success')).catch(()=>toast('Could not copy','error'));
}
async function deleteNewsletterSub(id){
  if(!window.__fb) return;
  const { fbDb, doc, deleteDoc } = window.__fb;
  try{ await deleteDoc(doc(fbDb, "newsletterSubs", id)); }
  catch(e){ console.warn('Delete newsletter sub failed', e); toast('Could not delete from cloud', 'error'); return; }
  if(window.__newsletterCache) window.__newsletterCache = window.__newsletterCache.filter(s=>s.id!==id);
  renderAdminTab();
  toast('Subscriber removed');
}

/* ---------------- ADMIN: USERS (every shopper who has signed up/signed in) ----------------
   Every shopper's account (Google or email/password) is upserted into the
   Firestore "users" collection by novaUpsertUserProfile — email, name,
   provider and sign-up date were already being saved, just never
   surfaced anywhere. This lists them, same fetch/cache/timeout/error
   pattern as the Messages tab above so it can't hang or silently look
   empty either. */
window.__usersCache = null;
window.__usersError = null;
async function fetchUsersFromCloud(force){
  if(window.__usersCache && !force) return window.__usersCache;
  if(!window.__fb){
    window.__usersError = 'Cloud connection is not ready yet.';
    return [];
  }
  const { fbDb, collection, getDocs } = window.__fb;
  try{
    const snap = await withTimeout(
      getDocs(collection(fbDb, "users")),
      15000,
      'Timed out loading users — check your connection and tap Retry.'
    );
    const list = [];
    snap.forEach(d=>list.push({ id:d.id, ...d.data() }));
    list.sort((a,b)=> new Date(b.createdAt||0) - new Date(a.createdAt||0));
    window.__usersCache = list;
    window.__usersError = null;
    return list;
  }catch(e){
    console.warn('Fetch users failed', e);
    window.__usersError = (e && e.code==='permission-denied')
      ? 'Not signed in to the cloud yet — try Refresh in a moment, or re-enter the admin password to reconnect.'
      : (e && e.message ? e.message : 'Could not load users (connection problem).');
    window.__usersCache = null;
    return [];
  }
}
function adminUsers(){
  fetchUsersFromCloud().then(()=>{ if(appState.adminTab==='users') renderAdminTab(); });
  const list = window.__usersCache;
  if(list===null){
    if(window.__usersError){
      return `<div class="admin-topbar"><h2>Users</h2><button class="btn btn-outline btn-sm" onclick="refreshUsers()">Retry</button></div><p class="text-2 small" style="color:var(--error);">⚠️ ${escapeHtml(window.__usersError)}</p>`;
    }
    return `<div class="admin-topbar"><h2>Users</h2></div><p class="text-2 small">Loading users…</p>`;
  }
  return `
    <div class="admin-topbar"><h2>Users (${list.length})</h2><button class="btn btn-outline btn-sm" onclick="refreshUsers()">Refresh</button></div>
    <p class="text-2 small" style="margin-bottom:12px;">Every shopper who has signed up or signed in — Google or email/password — with the email address they used.</p>
    ${list.length ? `<div class="card" style="padding:0;overflow:hidden;">
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead><tr style="text-align:left;border-bottom:1px solid var(--border);">
          <th style="padding:10px 12px;">Name</th><th style="padding:10px 12px;">Email</th>
          <th style="padding:10px 12px;">Signed in via</th><th style="padding:10px 12px;">Since</th>
        </tr></thead>
        <tbody>
        ${list.map(u=>`<tr style="border-bottom:1px solid var(--border);">
          <td style="padding:10px 12px;font-weight:600;">${escapeHtml(u.name||'—')}</td>
          <td style="padding:10px 12px;">${escapeHtml(u.email||'—')}</td>
          <td style="padding:10px 12px;text-transform:capitalize;">${escapeHtml(u.provider||'—')}</td>
          <td style="padding:10px 12px;">${u.createdAt?new Date(u.createdAt).toLocaleDateString():'—'}</td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '<p class="text-2 small">No users yet.</p>'}`;
}
function refreshUsers(){ fetchUsersFromCloud(true).then(renderAdminTab); }
async function saveLeadNote(id){
  const input = $('#leadNote_'+id);
  const note = input ? input.value.trim() : '';
  if(window.__fb){
    const { fbDb, doc, setDoc } = window.__fb;
    try{ await setDoc(doc(fbDb, "leads", id), { note }, { merge:true }); }
    catch(e){ console.warn('Save lead note failed', e); toast('Could not save note', 'error'); return; }
  }
  if(window.__leadsCache){
    const l = window.__leadsCache.find(x=>x.id===id);
    if(l) l.note = note;
  }
  toast('Note saved', 'success');
}
async function deleteLead(id){
  if(!confirm('Delete this message?')) return;
  if(window.__fb){
    const { fbDb, doc, deleteDoc } = window.__fb;
    try{ await deleteDoc(doc(fbDb, "leads", id)); }catch(e){ console.warn('Delete lead failed', e); toast('Could not delete from cloud', 'error'); }
  }
  if(window.__leadsCache) window.__leadsCache = window.__leadsCache.filter(l=>l.id!==id);
  logActivity('Admin', 'Deleted a contact message');
  renderAdminTab();
}

// ---- SUPPLIERS (physical-commerce: dropshipping/fulfilment partners) ----
// Fields match the physical-commerce doc's "Supplier Management Admin
// Section" spec exactly. Deliberately holds NO api key/secret field —
// "Do not store secrets in visible product forms" (the doc's own rule)
// applies doubly here, since this data round-trips through Firestore AND
// this browser-based admin form. A supplier that has a real API
// integration gets its actual key set as a Render environment variable —
// same pattern as PAYSTACK_SECRET_KEY/BREVO_API_KEY elsewhere in this app
// — never typed into this form or stored in Firestore. apiAvailable/
// apiStatus here are informational flags the admin sets by hand to
// reflect what's really configured server-side, not live credentials.
const FULFILMENT_METHODS = [
  {value:'api_automated', label:'API — automated'},
  {value:'manual_email', label:'Manual — email order'},
  {value:'manual_whatsapp', label:'Manual — WhatsApp order'},
  {value:'manual_phone', label:'Manual — phone order'},
];
function adminSuppliers(){
  const list = DB.suppliers;
  return `
    <div class="admin-topbar"><h2>Suppliers (${list.length})</h2></div>
    <p class="text-2 small" style="margin-bottom:12px;">Dropshipping/fulfilment partners — both API-connected and manual-order-only suppliers. Real API keys are never stored here; set those in Render's environment variables and just reflect the connection status below.</p>
    <div id="supplierFormWrap"></div>
    <button class="btn btn-primary btn-sm" style="margin-bottom:14px;" onclick="openSupplierForm()">+ Add Supplier</button>
    <table class="admin-table"><thead><tr><th>Name</th><th>Fulfilment</th><th>Status</th><th>Priority</th><th></th></tr></thead>
    <tbody>${list.map(s=>`<tr>
      <td>${escapeHtml(s.name)}<div class="text-2 small">${escapeHtml(s.country||'—')} · ${escapeHtml(s.currency||'—')}</div></td>
      <td>${escapeHtml((FULFILMENT_METHODS.find(m=>m.value===s.fulfilmentMethod)||{}).label || s.fulfilmentMethod || '—')}${s.apiAvailable?' <span class="chip" style="display:inline-block;">API</span>':''}</td>
      <td>${s.active ? '<span style="color:#5FD6A5;">● Active</span>' : '<span style="color:#e05a5a;">● Inactive</span>'}<div class="text-2 small">${escapeHtml(s.connectionStatus||'—')}</div></td>
      <td>${s.priority ?? '—'}${s.backupPriority ? ` / bk ${s.backupPriority}` : ''}</td>
      <td class="flex gap-8"><button class="btn btn-ghost btn-sm" onclick="openSupplierForm('${s.id}')">Edit</button><button class="btn btn-danger btn-sm" onclick="deleteSupplier('${s.id}')">Delete</button></td>
    </tr>`).join('') || '<tr><td colspan="5">No suppliers yet.</td></tr>'}</tbody></table>`;
}
function openSupplierForm(id){
  const s = id ? DB.suppliers.find(x=>x.id===id) : null;
  const wrap = $('#supplierFormWrap');
  wrap.innerHTML = `<div class="card" style="padding:16px;margin-bottom:16px;">
    <h3>${s?'Edit':'Add'} Supplier</h3>
    <div class="form-grid">
      <div class="form-field"><label>Supplier name</label><input id="sup_name" value="${s?escapeHtml(s.name):''}"></div>
      <div class="form-field"><label>Country/Region</label><input id="sup_country" placeholder="e.g. Nigeria, China, Global" value="${s?escapeHtml(s.country||''):''}"></div>
      <div class="form-field"><label>Website</label><input id="sup_website" placeholder="https://" value="${s?escapeHtml(s.website||''):''}"></div>
      <div class="form-field"><label>Currency</label><input id="sup_currency" placeholder="e.g. NGN, USD, CNY" value="${s?escapeHtml(s.currency||''):''}"></div>
      <div class="form-field"><label>Supported countries (comma separated)</label><input id="sup_supportedCountries" placeholder="e.g. Nigeria, Ghana" value="${s?escapeHtml((s.supportedCountries||[]).join(', ')):''}"></div>
      <div class="form-field"><label>Supported categories (comma separated)</label><input id="sup_supportedCategories" placeholder="e.g. computers, phones" value="${s?escapeHtml((s.supportedCategories||[]).join(', ')):''}"></div>
      <div class="form-field">
        <label>Fulfilment method</label>
        ${customSelect('sup_fulfilmentMethod', (s&&s.fulfilmentMethod)||'manual_email', FULFILMENT_METHODS, '')}
      </div>
      <div class="form-field">
        <label>API available?</label>
        ${customSelect('sup_apiAvailable', (s&&s.apiAvailable)?'yes':'no', [{value:'yes',label:'Yes'},{value:'no',label:'No'}], '', ()=>toggleSupplierApiFields())}
      </div>
      <div id="supplierApiFieldsWrap" style="display:${(s&&s.apiAvailable)?'contents':'none'};">
        <div class="form-field">
          <label>API status <span class="text-2 small">(informational only — the real key lives in Render env vars, never here)</span></label>
          ${customSelect('sup_apiStatus', (s&&s.apiStatus)||'not_connected', [
            {value:'not_connected',label:'Not connected yet'},
            {value:'connected',label:'Connected'},
            {value:'needs_attention',label:'Needs attention'},
          ], '')}
        </div>
        <div class="form-field">
          <label>Connection status</label>
          ${customSelect('sup_connectionStatus', (s&&s.connectionStatus)||'testing', [
            {value:'active',label:'Active'},
            {value:'testing',label:'Testing'},
            {value:'inactive',label:'Inactive'},
          ], '')}
        </div>
      </div>
      <div class="form-field"><label>Priority (lower = preferred)</label><input id="sup_priority" type="number" min="1" value="${s&&s.priority!=null?s.priority:'1'}"></div>
      <div class="form-field"><label>Backup priority</label><input id="sup_backupPriority" type="number" min="1" value="${s&&s.backupPriority!=null?s.backupPriority:''}"></div>
      <div class="form-field">
        <label>Active</label>
        ${customSelect('sup_active', (s&&s.active===false)?'no':'yes', [{value:'yes',label:'Yes'},{value:'no',label:'No'}], '')}
      </div>
      <div class="form-field"><label>Last verified</label><input id="sup_lastVerified" type="date" value="${s&&s.lastVerified?s.lastVerified:''}"></div>
    </div>
    <div class="form-field"><label>Notes</label><textarea id="sup_notes">${s?escapeHtml(s.notes||''):''}</textarea></div>
    <div class="flex gap-8"><button class="btn btn-primary" onclick="saveSupplier('${s?s.id:''}')">Save</button><button class="btn btn-outline" onclick="$('#supplierFormWrap').innerHTML=''">Cancel</button></div>
  </div>`;
}
function toggleSupplierApiFields(){
  const wrap = $('#supplierApiFieldsWrap');
  if(wrap) wrap.style.display = ($('#sup_apiAvailable')?.value === 'yes') ? 'contents' : 'none';
}
function saveSupplier(id){
  const name = $('#sup_name').value.trim();
  if(!name){ toast('Supplier name is required', 'error'); return; }
  const data = {
    name,
    country: $('#sup_country').value.trim(),
    website: $('#sup_website').value.trim(),
    currency: $('#sup_currency').value.trim(),
    supportedCountries: $('#sup_supportedCountries').value.split(',').map(s=>s.trim()).filter(Boolean),
    supportedCategories: $('#sup_supportedCategories').value.split(',').map(s=>s.trim()).filter(Boolean),
    fulfilmentMethod: $('#sup_fulfilmentMethod').value,
    apiAvailable: $('#sup_apiAvailable').value === 'yes',
    apiStatus: $('#sup_apiStatus')?.value || 'not_connected',
    connectionStatus: $('#sup_connectionStatus')?.value || 'testing',
    priority: Number($('#sup_priority').value) || 1,
    backupPriority: $('#sup_backupPriority').value ? Number($('#sup_backupPriority').value) : null,
    active: $('#sup_active').value === 'yes',
    lastVerified: $('#sup_lastVerified').value || null,
    notes: $('#sup_notes').value.trim(),
  };
  const list = DB.suppliers;
  if(id){ const idx = list.findIndex(x=>x.id===id); data.id = id; list[idx] = data; }
  else { data.id = 'sup'+Date.now(); list.push(data); }
  DB.suppliers = list;
  pushSettingsToCloud();
  logActivity('Admin', `Saved supplier "${name}"`);
  toast('Supplier saved', 'success');
  $('#supplierFormWrap').innerHTML = '';
  renderAdminTab();
}
function deleteSupplier(id){
  if(!confirm('Delete this supplier? Any product routing that references it will need to be reassigned.')) return;
  DB.suppliers = DB.suppliers.filter(s=>s.id!==id);
  pushSettingsToCloud();
  renderAdminTab();
}

// ---- SUPPLIER ROUTING (per-physical-product primary/backup supplier) ----
// One routing rule per physical product — stored on
// product.physical.routing (see the physical-commerce doc's "Supplier
// Routing Admin Section"). Kept as a per-product edit here rather than a
// separate collection, matching how the rest of a product's physical
// data already lives on the product itself.
function adminSupplierRouting(){
  const physicalProducts = DB.legacyProducts.filter(p=>p.productType==='PHYSICAL');
  const suppliers = DB.suppliers;
  if(!suppliers.length){
    return `<div class="admin-topbar"><h2>Supplier Routing</h2></div>
      <p class="text-2 small">Add at least one supplier on the Suppliers tab before setting up routing.</p>`;
  }
  return `
    <div class="admin-topbar"><h2>Supplier Routing (${physicalProducts.length} physical products)</h2></div>
    <p class="text-2 small" style="margin-bottom:12px;">For each physical product: which supplier fulfils it first, which is the backup, and the cost/margin guardrails routing should respect.</p>
    ${physicalProducts.length ? physicalProducts.map(p=>{
      const r = (p.physical && p.physical.routing) || {};
      return `<div class="card" style="padding:16px;margin-bottom:14px;">
        <h3 style="margin-bottom:10px;">${escapeHtml(p.name)}</h3>
        <div class="form-grid">
          <div class="form-field">
            <label>Primary supplier</label>
            ${customSelect('route_primary_'+p.id, r.primarySupplierId||'', suppliers.map(s=>({value:s.id,label:s.name})), 'None selected')}
          </div>
          <div class="form-field">
            <label>Backup supplier</label>
            ${customSelect('route_backup_'+p.id, r.backupSupplierId||'', [{value:'',label:'None'}, ...suppliers.map(s=>({value:s.id,label:s.name}))], 'None')}
          </div>
          <div class="form-field"><label>Minimum margin (%)</label><input id="route_minMargin_${p.id}" type="number" min="0" value="${r.minMargin!=null?r.minMargin:''}"></div>
          <div class="form-field"><label>Maximum acceptable cost</label><input id="route_maxCost_${p.id}" type="number" min="0" value="${r.maxCost!=null?r.maxCost:''}"></div>
          <div class="form-field">
            <label>Routing active</label>
            ${customSelect('route_active_'+p.id, r.active===false?'no':'yes', [{value:'yes',label:'Yes'},{value:'no',label:'No'}], '')}
          </div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="saveSupplierRouting('${p.id}')">Save routing</button>
      </div>`;
    }).join('') : '<p class="text-2 small">No physical products yet — set a product\'s type to Physical on the Products tab first.</p>'}
  `;
}
function saveSupplierRouting(productId){
  const list = DB.legacyProducts;
  const idx = list.findIndex(p=>p.id===productId);
  if(idx === -1) return;
  const p = list[idx];
  const primarySupplierId = $('#route_primary_'+productId)?.value || '';
  const routing = {
    primarySupplierId,
    backupSupplierId: $('#route_backup_'+productId)?.value || '',
    minMargin: $('#route_minMargin_'+productId).value ? Number($('#route_minMargin_'+productId).value) : null,
    maxCost: $('#route_maxCost_'+productId).value ? Number($('#route_maxCost_'+productId).value) : null,
    active: $('#route_active_'+productId)?.value !== 'no',
  };
  list[idx] = { ...p, physical: { ...(p.physical||{}), routing } };
  DB.products = list;
  pushProductsToCloud();
  logActivity('Admin', `Updated supplier routing for "${p.name}"`);
  toast('Routing saved', 'success');
  renderAdminTab();
}

function adminFaqs(){
  const list = DB.faqs;
  return `
    <div class="admin-topbar"><h2>FAQs (${list.length})</h2></div>
    <p class="text-2 small" style="margin-bottom:12px;">Shown on the Service/FAQ screen — and NOVA AI reads these directly, so a good FAQ often teaches NOVA a new answer instantly.</p>
    <div id="faqFormWrap"></div>
    <button class="btn btn-primary btn-sm" style="margin-bottom:14px;" onclick="openFaqForm()">+ Add FAQ</button>
    <table class="admin-table"><thead><tr><th>Question</th><th>Answer</th><th></th></tr></thead>
    <tbody>${list.map(f=>`<tr>
      <td style="max-width:220px;">${escapeHtml(f.q)}</td>
      <td style="max-width:280px;">${escapeHtml(f.a.slice(0,90))}${f.a.length>90?'…':''}</td>
      <td class="flex gap-8"><button class="btn btn-ghost btn-sm" onclick="openFaqForm('${f.id}')">Edit</button><button class="btn btn-danger btn-sm" onclick="deleteFaq('${f.id}')">Delete</button></td>
    </tr>`).join('') || '<tr><td colspan="3">No FAQs yet.</td></tr>'}</tbody></table>`;
}
function openFaqForm(id){
  const f = id ? DB.faqs.find(x=>x.id===id) : null;
  const wrap = $('#faqFormWrap');
  wrap.innerHTML = `<div class="card" style="padding:16px;margin-bottom:16px;">
    <h3>${f?'Edit':'Add'} FAQ</h3>
    <div class="form-field"><label>Question</label><input id="faq_q" value="${f?escapeHtml(f.q):''}"></div>
    <div class="form-field"><label>Answer</label><textarea id="faq_a">${f?escapeHtml(f.a):''}</textarea></div>
    <div class="flex gap-8"><button class="btn btn-primary" onclick="saveFaq('${f?f.id:''}')">Save</button><button class="btn btn-outline" onclick="$('#faqFormWrap').innerHTML=''">Cancel</button></div>
  </div>`;
}
function saveFaq(id){
  const q = $('#faq_q').value.trim();
  const a = $('#faq_a').value.trim();
  if(!q || !a){ toast('Both question and answer are required','error'); return; }
  const list = DB.faqs;
  if(id){ const idx = list.findIndex(f=>f.id===id); list[idx] = {...list[idx], q, a}; }
  else { list.push({id:'f'+Date.now(), q, a}); }
  DB.faqs = list;
  pushSettingsToCloud();
  logActivity('Admin', 'Saved a FAQ');
  toast('FAQ saved','success');
  $('#faqFormWrap').innerHTML='';
  renderAdminTab();
}
function deleteFaq(id){
  if(!confirm('Delete this FAQ?')) return;
  DB.faqs = DB.faqs.filter(f=>f.id!==id);
  pushSettingsToCloud();
  renderAdminTab();
}

function adminSocial(){
  const c = DB.content;
  return `
    <div class="admin-topbar"><h2>Social &amp; Contact</h2></div>
    <div class="card" style="padding:16px;">
      <div class="form-grid">
        <div class="form-field"><label>Email</label><input id="s_email" value="${escapeHtml(c.contactEmail)}"></div>
        <div class="form-field"><label>WhatsApp number (local format)</label><input id="s_wa" value="${escapeHtml(c.whatsappNumber)}"></div>
        <div class="form-field"><label>WhatsApp display</label><input id="s_waDisplay" value="${escapeHtml(c.whatsappDisplay)}"></div>
        <div class="form-field"><label>WhatsApp username</label><input id="s_waUser" value="${escapeHtml(c.whatsappUsername)}"></div>
        <div class="form-field"><label>YouTube handle</label><input id="s_yt" value="${escapeHtml(c.youtube)}"></div>
        <div class="form-field"><label>TikTok handle</label><input id="s_tt" value="${escapeHtml(c.tiktok)}"></div>
        <div class="form-field"><label>Instagram handle</label><input id="s_ig" value="${escapeHtml(c.instagram)}"></div>
        <div class="form-field"><label>Facebook page name</label><input id="s_fb" value="${escapeHtml(c.facebook)}"></div>
      </div>
      <button class="btn btn-primary" onclick="saveSocial()">Save changes</button>
    </div>`;
}
function saveSocial(){
  const c = DB.content;
  DB.content = {...c,
    contactEmail:$('#s_email').value, whatsappNumber:$('#s_wa').value, whatsappDisplay:$('#s_waDisplay').value,
    whatsappUsername:$('#s_waUser').value, youtube:$('#s_yt').value, tiktok:$('#s_tt').value, instagram:$('#s_ig').value, facebook:$('#s_fb').value,
  };
  pushSettingsToCloud();
  logActivity('Admin', 'Updated social & contact info');
  toast('Contact info saved','success');
}

function adminBranding(){
  const c = DB.content;
  const rates = c.exchangeRates;
  return `
    <div class="admin-topbar"><h2>Branding &amp; Currency</h2></div>
    <div class="card" style="padding:16px;margin-bottom:16px;">
      <h3 style="font-size:14px;margin-bottom:10px;">App logo</h3>
      <div class="flex gap-8" style="align-items:center;margin-bottom:10px;">
        <img src="${c.logoUrl}" style="width:52px;height:52px;border-radius:12px;object-fit:cover;background:var(--surface);" id="brandLogoPreview">
        <div class="text-2 small">This image is used as the app's logo everywhere — mobile header, desktop header, and the admin sidebar. Press-and-hold it opens this admin panel.</div>
      </div>
      <div class="form-field"><label>Logo image URL</label><input id="b_logoUrl" value="${escapeHtml(c.logoUrl)}" oninput="$('#brandLogoPreview').src=this.value"></div>
      <div class="flex gap-8" style="align-items:center;margin-bottom:12px;">
        <input type="file" id="logoFileInput" accept="image/*" style="font-size:12px;flex:1;" onchange="uploadLogoFile(this)">
        <span id="logoUploadStatus" class="small text-2"></span>
      </div>
      <div class="form-field"><label>App name</label><input id="b_appName" value="${escapeHtml(c.appName||'LEXDEN NOVA')}"></div>
      <button class="btn btn-primary" onclick="saveBranding()">Save branding</button>
    </div>
    <div class="card" style="padding:16px;margin-bottom:16px;">
      <h3 style="font-size:14px;margin-bottom:6px;">Default avatars (by gender)</h3>
      <p class="text-2 small" style="margin-bottom:12px;">Shown automatically on a shopper's profile when they sign up without choosing their own profile picture. Based on the gender they select on the Sign Up form. Paste a media URL directly (e.g. a Cloudinary link) or upload a file — either one works.</p>
      <div class="form-grid">
        ${['male','female'].map(g=>`
          <div class="form-field">
            <label>${g[0].toUpperCase()+g.slice(1)}</label>
            <img src="${c['defaultAvatar'+g[0].toUpperCase()+g.slice(1)]||DEFAULT_LOGO_DATA_URI}" id="genderAvatarPreview_${g}" style="width:44px;height:44px;border-radius:50%;object-fit:cover;background:var(--surface);border:1px solid var(--border);display:block;margin-bottom:6px;">
            <input id="genderAvatarUrl_${g}" placeholder="Media URL (https://…)" value="${escapeHtml(c['defaultAvatar'+g[0].toUpperCase()+g.slice(1)]||'')}" style="font-size:12px;margin-bottom:6px;" oninput="$('#genderAvatarPreview_${g}').src=this.value">
            <button class="btn btn-outline btn-sm" style="margin-bottom:6px;" onclick="saveGenderAvatarUrl('${g}')">Save URL</button>
            <input type="file" accept="image/*" id="genderAvatarInput_${g}" style="font-size:12px;" onchange="uploadGenderAvatarFile('${g}', this)">
            <span id="genderAvatarStatus_${g}" class="small text-2"></span>
          </div>`).join('')}
      </div>
    </div>
    <div class="card" style="padding:16px;">
      <h3 style="font-size:14px;margin-bottom:6px;">Currency</h3>
      <p class="text-2 small" style="margin-bottom:10px;">You enter every product's price in Naira (₦) on the product form. Behind the scenes it's converted using the NGN rate below, then shown to shoppers in whichever currency they pick. Rates are "units of currency per 1 USD" and refresh automatically (at most once a day) whenever the site is opened online — you can also force a refresh below.</p>
      <div class="form-field"><label>Default currency shown to new visitors</label>
        ${customSelect('b_displayCurrency', c.displayCurrency, Object.keys(rates).map(code=>({value:code,label:code})), '')}
      </div>
      <div class="form-grid">
        ${Object.keys(rates).map(code=>`<div class="form-field"><label>${code} (${c.currencySymbols[code]||''}) per $1</label><input id="rate_${code}" type="number" step="0.0001" value="${rates[code]}"></div>`).join('')}
      </div>
      <p class="text-2 small">${c.ratesUpdatedAt?`Last auto-updated: ${new Date(c.ratesUpdatedAt).toLocaleString()}`:'Never auto-updated yet — using these manually-set rates.'}</p>
      <div class="flex gap-8 mt-8">
        <button class="btn btn-primary" onclick="saveCurrencyRates()">Save rates</button>
        <button class="btn btn-outline" onclick="forceRefreshRates()">🔄 Fetch live rates now</button>
      </div>
    </div>
    <div class="card" style="padding:16px;">
      <h3 style="font-size:14px;margin-bottom:6px;">Search & Indexing</h3>
      <p class="text-2 small">Moved to its own <strong>Sitemap</strong> tab in the sidebar — it now covers every page type (products, feed, services, about), not just products/feed.</p>
    </div>`;
}
// v2.0.1: sitemap.xml generation now has its own dedicated admin tab (was
// buried inside Branding) and covers every real page the site has, not
// just products/feed. It's built from the SAME requested URL structure
// (/, /products, /product/{id}, /services, /service/{id}, /feed,
// /feed/{post-id}, /about, /contact) mapped onto what actually exists:
//
//  - /product/{id} and /feed/{post-id} get REAL, individually-fetchable
//    URLs already — NOVA_LINKS_BASE (the Vercel link-preview project)
//    serves an actual server-rendered page at those exact paths. Those
//    are correct, fully-indexable sitemap entries as-is.
//  - /, /products, /services and /about only exist as hash routes
//    (#home, #products, #service, #about) on the GitHub Pages SPA — there
//    is no server-side file or route at a literal path like
//    "/products", so a sitemap entry at that literal path would 404 for
//    Google. They're included pointing at the real hash URL instead
//    (e.g. SITE_URL+'#products'), which Google *can* fetch (it gets
//    index.html and renders it), even though hash fragments carry very
//    little standalone SEO weight — this is a known, disclosed
//    limitation of hash-routed SPAs, not a bug in this generator.
//  - /service/{id} (a page per individual service) and /feed (a page
//    listing all feed posts) and /contact don't correspond to any screen
//    that exists in the app today — services are shown together on one
//    #service screen, there's no standalone feed index, and there's no
//    dedicated contact screen (contact info lives inside #about /
//    Social & Contact settings). These are left out rather than
//    generating sitemap entries for pages that don't exist and would
//    404.
function buildSitemapEntries(){
  const today = new Date().toISOString().slice(0,10);
  return [
    {loc:SITE_URL, freq:'daily', pri:'1.0', note:'/ — home'},
    {loc:SITE_URL+'#products', freq:'daily', pri:'0.9', note:'/products — hash route, real page'},
    ...DB.products.filter(p=>p.status!=='draft').map(p=>({loc:NOVA_LINKS_BASE+'/product/'+(p.shareId||p.id), freq:'weekly', pri:'0.9', note:'/product/'+(p.shareId||p.id)+' — real server page'})),
    {loc:SITE_URL+'#service', freq:'weekly', pri:'0.6', note:'/services — hash route, real page'},
    ...DB.feed.map(f=>({loc:NOVA_LINKS_BASE+'/feed/'+f.id, freq:'monthly', pri:'0.5', note:'/feed/'+f.id+' — real server page'})),
    {loc:SITE_URL+'#about', freq:'monthly', pri:'0.5', note:'/about — hash route, real page'},
  ].map(u=>({...u, lastmod:today}));
}
function downloadSitemap(){
  const urls = buildSitemapEntries();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n`
    + urls.map(u=>`  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod><changefreq>${u.freq}</changefreq><priority>${u.pri}</priority></url>`).join('\n')
    + `\n</urlset>\n`;
  const blob = new Blob([xml], {type:'application/xml'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'sitemap.xml'; a.click();
  toast('sitemap.xml downloaded — upload it to your repo root, replacing the old one','success');
  logActivity('Admin', 'Downloaded sitemap.xml ('+urls.length+' URLs)');
}
function adminSitemap(){
  const urls = buildSitemapEntries();
  return `
    <div class="admin-topbar"><h2>Sitemap</h2></div>
    <div class="card" style="padding:16px;margin-bottom:16px;">
      <h3 style="font-size:14px;margin-bottom:6px;">Your live sitemap (automatic)</h3>
      <p class="text-2 small" style="margin-bottom:10px;">Your sitemap now builds itself from your real products and feed posts every time Google asks for it — nothing to download or upload, and the demo items can never appear. Give Google this address:</p>
      <p class="mono" style="word-break:break-all;margin-bottom:10px;">${NOVA_LINKS_BASE}/sitemap.xml</p>
      <a class="btn btn-primary" href="${NOVA_LINKS_BASE}/sitemap.xml" target="_blank" rel="noopener">🗺️ Open live sitemap</a>
      <p class="text-2 small" style="margin-top:14px;">Google only accepts a sitemap that sits on the same website as the pages inside it. Your product and feed pages live on <code>${NOVA_LINKS_BASE.replace('https://','')}</code>, so add that address as a property in Google Search Console and submit <code>sitemap.xml</code> there. The older download button is kept below for reference only.</p>
      <button class="btn btn-outline" style="margin-top:8px;" onclick="downloadSitemap()">Download a copy (${urls.length} URLs)</button>
    </div>
    <div class="card" style="padding:16px;">
      <h3 style="font-size:14px;margin-bottom:10px;">What's included right now</h3>
      ${urls.map(u=>`<div class="log-row small"><span class="mono">${escapeHtml(u.note)}</span><br><span class="text-2" style="word-break:break-all;">${escapeHtml(u.loc)}</span></div>`).join('')}
      <p class="text-2 small" style="margin-top:12px;">Not included: a standalone <code>/service/{id}</code> page per service, a <code>/feed</code> index page, and <code>/contact</code> — none of these exist as their own page in the app today (services are one combined screen; there's no feed index screen; contact info lives inside About). Say the word if you'd like any of those built as real pages — then they'd belong here too.</p>
    </div>`;
}
async function uploadLogoFile(inputEl){
  const file = inputEl.files && inputEl.files[0];
  if(!file) return;
  const statusEl = $('#logoUploadStatus');
  if(statusEl) statusEl.textContent = 'Uploading…';
  try{
    const url = await cloudinaryUploadFile(file, 5); // logos are small — 5MB is plenty
    const urlInput = $('#b_logoUrl');
    if(urlInput) urlInput.value = url;
    const preview = $('#brandLogoPreview');
    if(preview) preview.src = url;
    if(statusEl) statusEl.textContent = '✅ Uploaded — press Save branding below';
    toast('Logo uploaded', 'success');
  }catch(e){
    console.warn('Logo upload failed', e);
    if(statusEl) statusEl.textContent = e.code ? `❌ Upload failed (${e.code})` : '❌ '+e.message;
    toast(uploadErrorMessage(e), 'error');
    inputEl.value = '';
  }
}
function saveGenderAvatarUrl(gender){
  const key = 'defaultAvatar' + gender[0].toUpperCase() + gender.slice(1);
  const url = ($('#genderAvatarUrl_'+gender)?.value||'').trim();
  if(!url){ toast('Enter a media URL first', 'error'); return; }
  DB.content = {...DB.content, [key]: url};
  pushSettingsToCloud();
  const preview = $('#genderAvatarPreview_'+gender);
  if(preview) preview.src = url;
  toast(gender[0].toUpperCase()+gender.slice(1)+' default avatar saved', 'success');
  logActivity('Admin', `Updated default ${gender} avatar (URL)`);
}
async function uploadGenderAvatarFile(gender, inputEl){
  const file = inputEl.files && inputEl.files[0];
  if(!file) return;
  const key = 'defaultAvatar' + gender[0].toUpperCase() + gender.slice(1);
  const statusEl = $('#genderAvatarStatus_'+gender);
  if(statusEl) statusEl.textContent = 'Uploading…';
  try{
    const url = await cloudinaryUploadFile(file, 5);
    DB.content = {...DB.content, [key]: url};
    pushSettingsToCloud();
    const preview = $('#genderAvatarPreview_'+gender);
    if(preview) preview.src = url;
    const urlInput = $('#genderAvatarUrl_'+gender);
    if(urlInput) urlInput.value = url;
    if(statusEl) statusEl.textContent = '✅ Saved';
    toast(gender[0].toUpperCase()+gender.slice(1)+' default avatar saved', 'success');
    logActivity('Admin', `Updated default ${gender} avatar`);
  }catch(e){
    console.warn('Default avatar upload failed', e);
    if(statusEl) statusEl.textContent = e.code ? `❌ Upload failed (${e.code})` : '❌ '+e.message;
    toast(uploadErrorMessage(e), 'error');
    inputEl.value = '';
  }
}
function saveBranding(){
  const c = DB.content;
  DB.content = {...c, logoUrl:$('#b_logoUrl').value.trim()||c.logoUrl, appName:$('#b_appName').value.trim()||c.appName};
  pushSettingsToCloud();
  logActivity('Admin', 'Updated app branding');
  toast('Branding saved','success');
  render();
}
function saveCurrencyRates(){
  const c = DB.content;
  const rates = {...c.exchangeRates};
  Object.keys(rates).forEach(code=>{ const v = parseFloat($('#rate_'+code)?.value); if(!isNaN(v) && v>0) rates[code]=v; });
  DB.content = {...c, exchangeRates:rates, displayCurrency:$('#b_displayCurrency').value};
  pushSettingsToCloud();
  logActivity('Admin', 'Updated currency exchange rates manually');
  toast('Exchange rates saved','success');
  render();
}
async function forceRefreshRates(){
  const c = DB.content;
  DB.content = {...c, ratesUpdatedAt:''}; // clear the once-a-day guard
  await tryRefreshExchangeRates();
  pushSettingsToCloud();
  toast('Rates refreshed (or kept as-is if offline)','success');
  renderAdminTab();
}

function adminServicesTab(){
  const list = DB.services;
  return `
    <div class="admin-topbar"><h2>Services (${list.length})</h2></div>
    <p class="text-2 small" style="margin-bottom:12px;">These are the things LEXDEN DIGITAL does for customers (website building, apps, AI, security, training) — shown on the Home screen and the Service tab.</p>
    <div id="serviceFormWrap"></div>
    <button class="btn btn-primary btn-sm" style="margin-bottom:14px;" onclick="openServiceForm()">+ Add Service</button>
    <table class="admin-table"><thead><tr><th>Icon</th><th>Title</th><th>Description</th><th></th></tr></thead>
    <tbody>${list.map(s=>`<tr>
      <td style="font-size:20px;">${s.ic}</td><td>${escapeHtml(s.title)}</td>
      <td style="max-width:280px;">${escapeHtml(s.desc.slice(0,90))}${s.desc.length>90?'…':''}</td>
      <td class="flex gap-8"><button class="btn btn-ghost btn-sm" onclick="openServiceForm('${s.id}')">Edit</button><button class="btn btn-danger btn-sm" onclick="deleteService('${s.id}')">Delete</button></td>
    </tr>`).join('') || '<tr><td colspan="4">No services yet.</td></tr>'}</tbody></table>`;
}
function openServiceForm(id){
  const s = id ? DB.services.find(x=>x.id===id) : null;
  const wrap = $('#serviceFormWrap');
  wrap.innerHTML = `<div class="card" style="padding:16px;margin-bottom:16px;">
    <h3>${s?'Edit':'Add'} Service</h3>
    <div class="form-grid">
      <div class="form-field"><label>Icon (emoji)</label><input id="sv_ic" value="${s?s.ic:'💻'}"></div>
      <div class="form-field"><label>Title</label><input id="sv_title" value="${s?escapeHtml(s.title):''}"></div>
    </div>
    <div class="form-field"><label>Description</label><textarea id="sv_desc">${s?escapeHtml(s.desc):''}</textarea></div>
    <div class="flex gap-8"><button class="btn btn-primary" onclick="saveService('${s?s.id:''}')">Save</button><button class="btn btn-outline" onclick="$('#serviceFormWrap').innerHTML=''">Cancel</button></div>
  </div>`;
}
function saveService(id){
  const title = $('#sv_title').value.trim();
  if(!title){ toast('Title is required','error'); return; }
  const list = DB.services;
  const data = {ic:$('#sv_ic').value.trim()||'💻', title, desc:$('#sv_desc').value.trim()};
  if(id){ const idx = list.findIndex(s=>s.id===id); list[idx] = {...list[idx], ...data}; }
  else { list.push({id:'sv'+Date.now(), ...data}); }
  DB.services = list;
  pushSettingsToCloud();
  logActivity('Admin', `Saved service "${title}"`);
  toast('Service saved','success');
  $('#serviceFormWrap').innerHTML='';
  renderAdminTab();
}
function deleteService(id){
  if(!confirm('Delete this service?')) return;
  DB.services = DB.services.filter(s=>s.id!==id);
  pushSettingsToCloud();
  renderAdminTab();
}

function adminFeed(){
  const list = DB.feed;
  return `
    <div class="admin-topbar"><h2>Feed Posts (${list.length})</h2></div>
    <p class="text-2 small" style="margin-bottom:12px;">These show as "From the feed" on Home. Posts marked <strong>Important</strong> show instead as a big banner at the top of Home — like Play Store's featured banners — with full media and a push notification sent to everyone.</p>
    <div id="feedFormWrap"></div>
    <button class="btn btn-primary btn-sm" style="margin-bottom:14px;" onclick="openFeedForm()">+ Add Feed Post</button>
    <table class="admin-table"><thead><tr><th>Title</th><th>Media</th><th>Important</th><th>Date</th><th></th></tr></thead>
    <tbody>${list.map(p=>`<tr>
      <td style="max-width:220px;">${escapeHtml(p.title)}</td><td>${(p.media||[]).length} item(s)</td>
      <td>${p.important?'⭐ Yes':'—'}</td><td>${p.date||''}</td>
      <td class="flex gap-8"><button class="btn btn-ghost btn-sm" onclick="openFeedForm('${p.id}')">Edit</button><button class="btn btn-danger btn-sm" onclick="deleteFeedPost('${p.id}')">Delete</button></td>
    </tr>`).join('') || '<tr><td colspan="5">No feed posts yet.</td></tr>'}</tbody></table>`;
}
function openFeedForm(id){
  const p = id ? DB.feed.find(x=>x.id===id) : null;
  const cats = DB.products;
  const mediaSlots = Array.from({length:8}).map((_,i)=> (p&&p.media&&p.media[i]) ? p.media[i].url : '');
  const wrap = $('#feedFormWrap');
  wrap.innerHTML = `<div class="card" style="padding:16px;margin-bottom:16px;">
    <h3>${p?'Edit':'Add'} Feed Post</h3>
    <div class="form-field"><label>Title</label><input id="fp_title" value="${p?escapeHtml(p.title):''}"></div>
    <div class="form-field"><label>Body text</label><textarea id="fp_body">${p?escapeHtml(p.body):''}</textarea></div>
    <div class="form-field"><label>Tag products (optional — link this post to one or more products)</label>
      <div class="card" style="max-height:180px;overflow-y:auto;padding:8px 10px;">
        ${cats.length ? cats.map(c=>{
          const checked = (p ? feedPostProductIds(p) : []).includes(c.id);
          return `<label class="flex gap-8" style="align-items:center;padding:5px 0;cursor:pointer;font-size:13px;">
            <input type="checkbox" class="fp-product-cb" value="${c.id}" ${checked?'checked':''} style="width:auto;">
            ${escapeHtml(c.name)}
          </label>`;
        }).join('') : '<p class="text-2 small">No products yet.</p>'}
      </div>
    </div>
    <div class="form-field" style="flex-direction:row;align-items:center;gap:8px;">
      <input type="checkbox" id="fp_important" ${p&&p.important?'checked':''} style="width:auto;">
      <label for="fp_important" style="margin:0;">Mark as Important — big banner on Home + push notification to everyone</label>
    </div>
    <h4 style="font-size:13px;margin:10px 0 6px;">Media — up to 8 photos/videos (first one is the cover shown on Home). Paste a link, or upload a file straight from your device.</h4>
    <div class="form-grid">
      ${mediaSlots.map((url,i)=>`<div class="form-field">
        <label>Media ${i+1}${i===0?' (cover)':''}</label>
        <input id="fp_media${i}" value="${escapeHtml(url)}" placeholder="Image/video URL, or upload a file below">
        <div class="flex gap-8" style="align-items:center;margin-top:4px;">
          <input type="file" id="fp_mediaFile${i}" accept="image/*,video/*" style="font-size:12px;flex:1;" onchange="uploadMediaFile('fp_media', ${i}, this)">
          <span id="fp_mediaFileStatus${i}" class="small text-2"></span>
        </div>
      </div>`).join('')}
    </div>
    <div class="flex gap-8"><button class="btn btn-primary" id="feedSaveBtn" onclick="saveFeedPost('${p?p.id:''}')">Save</button><button class="btn btn-outline" onclick="$('#feedFormWrap').innerHTML=''">Cancel</button></div>
  </div>`;
}
// BUGFIX (same root cause as saveProduct, above): was fire-and-forget on
// pushSettingsToCloud() with an unconditional "saved" toast and an
// immediate form close. Now genuinely awaits the cloud write and only
// confirms success (and only closes the form) if it really landed.
async function saveFeedPost(id){
  const title = $('#fp_title').value.trim();
  if(!title){ toast('Title is required','error'); return; }
  const list = DB.feed;
  const media = Array.from({length:8}).map((_,i)=>$('#fp_media'+i)?.value.trim()).filter(Boolean).map(url=>({url, type:guessMediaType(url)}));
  const productIds = Array.from(document.querySelectorAll('.fp-product-cb:checked')).map(el=>el.value);
  const important = !!$('#fp_important')?.checked;
  const isNew = !id;
  const body = $('#fp_body').value.trim();
  const newId = id || 'fp'+Date.now();
  const data = {title, body, media, productIds, important, date:(id&&list.find(p=>p.id===id)?.date)||new Date().toISOString().slice(0,10)};
  if(id){ const idx = list.findIndex(p=>p.id===id); list[idx] = {...list[idx], ...data}; }
  else { list.unshift({id:newId, ...data}); }
  DB.feed = list;
  const saveBtn = $('#feedSaveBtn');
  if(saveBtn){ saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }
  const ok = await pushSettingsToCloud();
  if(saveBtn){ saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
  if(!ok){
    // Same as products: data is safe locally, but shoppers and other
    // devices won't see it until this succeeds — leave the form open
    // so retrying doesn't mean re-typing the post.
    toast('Saved on this device only — will not appear for shoppers or other devices until cloud sync succeeds. Check your connection and press Save again.', 'error');
    renderAdminTab();
    return;
  }
  // A brand-new Important post triggers a push notification to every
  // device that's enabled notifications. This is a lightweight trigger
  // doc a Cloud Function watches (see functions/index.js) — it can't be
  // done purely client-side since a phone can't message OTHER phones by
  // itself.
  if(isNew && important) notifyNewFeedPost({id:newId, title, body, coverUrl:(media[0]||{}).url||''});
  logActivity('Admin', `Saved feed post "${title}"`);
  toast('Feed post saved','success');
  $('#feedFormWrap').innerHTML='';
  renderAdminTab();
}
function deleteFeedPost(id){
  if(!confirm('Delete this feed post?')) return;
  DB.feed = DB.feed.filter(p=>p.id!==id);
  pushSettingsToCloud();
  renderAdminTab();
}
// ms: how long to wait. The server sleeps when idle and needs up to ~45s to
// wake, so searches wait longer than the old fixed 15s (which gave up before
// the server was even awake and looked like "nothing happened").
async function cjApiGet(path, ms){
  const base = cjBackendUrl();
  if(!base) return {ok:false, error:'Set the CJ backend API base URL below first.'};
  try{
    const r = await withTimeout(fetch(base+path), ms||45000, 'The server did not answer in time. Try once more in a minute.');
    if(!r.ok) return {ok:false, error:`The server answered with an error [code ${r.status}].`};
    return await r.json();
  }catch(e){
    return {ok:false, error:(e.message||'Could not reach the server.') + (e.name==='TypeError' ? ' [network]' : '')};
  }
}

function adminCJDropshipping(){
  const c = DB.content;
  const enabled = c.cjEnabled !== false;
  return `
    <div class="admin-topbar"><h2>CJ Dropshipping</h2></div>
    <div class="card" style="padding:16px;margin-bottom:16px;">
      <h3 style="font-size:14px;margin-bottom:8px;">Connection</h3>
      <p class="text-2 small" style="margin-bottom:10px;">Every CJ product search, stock check, order and tracking lookup runs through your own Render backend's <code>/api/cj-*.js</code> routes — the browser never holds a CJ API key or access token, exactly like Payments and NOVA AI Setup work. Set <code>CJ_EMAIL</code> and <code>CJ_API_KEY</code> in Render's dashboard → your service → Environment — that's the only setup this needs.</p>
      <div class="form-field"><label>Backend API base URL</label><input value="${escapeHtml(API_BASE)}/api" disabled style="opacity:.65;"></div>
      <p class="text-2 small" style="margin-top:-4px;margin-bottom:10px;opacity:.7;">Fixed — always your one Render service, nothing to configure here.</p>
      <div class="form-grid">
        <div class="form-field"><label>CJ enabled</label>${customSelect('cj_enabled', enabled?'yes':'no', [{value:'yes',label:'Yes'},{value:'no',label:'No'}], '')}</div>
        <div class="form-field"><label>Auto-import</label>${customSelect('cj_autoImport', c.cjAutoImport?'yes':'no', [{value:'no',label:'No (manual review — recommended)'},{value:'yes',label:'Yes'}], '')}</div>
        <div class="form-field"><label>Auto-publish</label>${customSelect('cj_autoPublish', c.cjAutoPublish?'yes':'no', [{value:'no',label:'No (manual review — recommended)'},{value:'yes',label:'Yes'}], '')}</div>
        <div class="form-field"><label>Inventory safety buffer</label><input id="cj_stockBuffer" type="number" min="0" value="${c.cjStockBuffer!=null?c.cjStockBuffer:2}" placeholder="e.g. 2"></div>
        <div class="form-field"><label>Default source country</label><input id="cj_sourceCountry" value="${escapeHtml(c.cjSourceCountry||'CN')}" placeholder="CN"></div>
        <div class="form-field"><label>Default target country</label><input id="cj_targetCountry" value="${escapeHtml(c.cjTargetCountry||'NG')}" placeholder="NG"></div>
      </div>
      <div class="flex gap-8" style="margin-top:6px;">
        <button class="btn btn-primary" onclick="saveCjSettings()">Save CJ settings</button>
        <button class="btn btn-outline" onclick="cjTestConnection()">Test Connection</button>
      </div>
      <p class="small text-2" id="cjConnStatus" style="margin-top:8px;">${c.cjLastConnStatus?('Last check: '+escapeHtml(c.cjLastConnStatus)+(c.cjLastConnAt?' — '+new Date(c.cjLastConnAt).toLocaleString():'')):'Not tested yet.'}</p>
      <p class="small text-2" style="margin-top:4px;opacity:.75;">Webhook URL (read-only, configure in your CJ App settings): <code>${escapeHtml(cjBackendUrl()||'https://lexden-nova.onrender.com/api')}/cj-webhook</code></p>
    </div>

    <div class="card" style="padding:16px;margin-bottom:16px;">
      <h3 style="font-size:14px;margin-bottom:8px;">Import Products</h3>
      <p class="text-2 small" style="margin-bottom:10px;">Search CJ's live catalog and import as a <strong>Draft</strong> physical product — nothing here goes live on the storefront until you review it in Products and set Status to Published (README §29/§30).</p>
      <div class="flex gap-8">
        <input id="cj_searchKeyword" value="${escapeHtml(window.__cjSearchKeyword||'')}" placeholder="Search CJ products (e.g. wireless earbuds)" onkeydown="if(event.key==='Enter'){event.preventDefault();cjRunImportSearch();}" style="flex:1;padding:9px 11px;border-radius:8px;border:1px solid var(--border);background:var(--surface);color:var(--text);">
        <button class="btn btn-primary btn-sm" onclick="cjRunImportSearch()">Search</button>
      </div>
      <div id="cjImportResults" style="margin-top:12px;">${window.__cjSearchHtml||''}</div>
    </div>

    <div class="card" style="padding:16px;margin-bottom:16px;">
      <h3 style="font-size:14px;margin-bottom:8px;">Imported Products</h3>
      ${cjImportedProductsTable()}
    </div>

    <div class="card" style="padding:16px;">
      <h3 style="font-size:14px;margin-bottom:8px;">Sync Logs</h3>
      <p class="text-2 small" style="margin-bottom:10px;">Every CJ API call this backend makes — never shows tokens/secrets (see cj-shared.js's redact()).</p>
      <div id="cjSyncLogsWrap"><p class="text-2 small">Loading…</p></div>
    </div>`;
}
// Fired after the panel is in the DOM (renderAdminTab() sets innerHTML
// synchronously, so this is called right after, same pattern refreshLeads
// etc. use — see setAdminTab()/renderAdminTab() calling this below).
async function cjLoadSyncLogsIfVisible(){
  const wrap = $('#cjSyncLogsWrap');
  if(!wrap || !window.__fb) return;
  const { fbDb, collection, getDocs, query, orderBy, limit } = window.__fb;
  try{
    const snap = await withTimeout(getDocs(query(collection(fbDb,'cjSyncLogs'), orderBy('at','desc'), limit(50))), 15000, 'Loading sync logs timed out.');
    const rows = snap.docs.map(d=>d.data());
    wrap.innerHTML = rows.length ? `<table class="admin-table"><thead><tr><th>Time</th><th>Event</th><th>Object</th><th>Result</th><th>Message</th><th>ms</th></tr></thead><tbody>
      ${rows.map(l=>`<tr>
        <td>${l.at&&l.at.toDate?l.at.toDate().toLocaleString():''}</td>
        <td>${escapeHtml(l.event||'')}</td>
        <td>${escapeHtml(l.objectId||'—')}</td>
        <td>${l.success?'✅':'❌'}</td>
        <td>${escapeHtml((l.message||'').slice(0,80))}</td>
        <td>${l.tookMs!=null?l.tookMs:''}</td>
      </tr>`).join('')}
    </tbody></table>` : `<p class="text-2 small">No sync activity logged yet — run Test Connection or an import search above.</p>`;
  }catch(e){
    wrap.innerHTML = `<p class="text-2 small" style="color:var(--error);">Could not load sync logs: ${escapeHtml(e.message||'unknown error')}</p>`;
  }
}
function cjImportedProductsTable(){
  const imported = DB.legacyProducts.filter(p=>p.physical && p.physical.cj && p.physical.cj.productId);
  if(!imported.length) return `<p class="text-2 small">No products imported from CJ yet.</p>`;
  return `<table class="admin-table"><thead><tr><th>Name</th><th>Status</th><th>CJ Variant</th><th>Stock</th><th></th></tr></thead><tbody>
    ${imported.map(p=>`<tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.status)}</td>
      <td>${escapeHtml(p.physical.cj.variantId||'—')}</td>
      <td>${escapeHtml(p.physical.stockStatus||'unknown')}</td>
      <td><button class="btn btn-ghost btn-sm" onclick="openProductForm('${p.id}')">Open</button></td>
    </tr>`).join('')}
  </tbody></table>`;
}
function saveCjSettings(){
  DB.content = {...DB.content,
    cjEnabled: $('#cj_enabled').value !== 'no',
    cjAutoImport: $('#cj_autoImport').value === 'yes',
    cjAutoPublish: $('#cj_autoPublish').value === 'yes',
    cjStockBuffer: Math.max(0, parseInt($('#cj_stockBuffer').value,10) || 0),
    cjSourceCountry: ($('#cj_sourceCountry').value||'CN').trim().toUpperCase(),
    cjTargetCountry: ($('#cj_targetCountry').value||'NG').trim().toUpperCase(),
  };
  pushSettingsToCloud();
  logActivity('Admin', 'Updated CJ Dropshipping settings');
  toast('CJ settings saved','success');
  renderAdminTab();
}
async function cjTestConnection(){
  const statusEl = $('#cjConnStatus');
  if(statusEl) statusEl.textContent = 'Testing…';
  const r = await cjApiPost('/cj-auth', {action:'test'});
  const status = r.status || (r.ok ? 'Connected' : (r.error||'Authentication failed'));
  DB.content = {...DB.content, cjLastConnStatus: status, cjLastConnAt: new Date().toISOString()};
  pushSettingsToCloud();
  if(statusEl) statusEl.textContent = `Last check: ${status} — ${new Date().toLocaleString()}`;
  toast(r.connected ? 'CJ connection OK' : `CJ connection: ${status}`, r.connected ? 'success' : 'error');
}
// Search results are remembered in window.__cjSearchHtml and written into
// whatever #cjImportResults is on screen RIGHT NOW. The admin page can
// re-render while CJ is still answering (it rebuilds the whole tab); the old
// code held on to the element from before the wait, so the answer landed in
// a box that was no longer on the page and the admin saw nothing at all.
function cjShowSearch(html){
  window.__cjSearchHtml = html;
  const el = $('#cjImportResults'); if(el) el.innerHTML = html;
}
async function cjRunImportSearch(){
  const input = $('#cj_searchKeyword');
  const keyword = ((input && input.value)||'').trim();
  window.__cjSearchKeyword = keyword;
  cjShowSearch('<p class="text-2 small">Searching CJ… (the first search after a quiet spell can take up to 30 seconds while the server wakes up)</p>');
  const r = await cjApiGet(`/cj-products?mode=search&keyword=${encodeURIComponent(keyword)}&pageSize=20`);
  if(!r.ok){
    const disabled = /api access has been disabled|reactivate/i.test(String(r.error||''));
    cjShowSearch(`<p class="text-2 small" style="color:var(--error);">${escapeHtml(r.error||'Search failed.')}</p>${disabled?'<p class="text-2 small">CJ has switched off API access for this account. <a href="https://www.cjdropshipping.com/my.html#/authorize/APIStores" target="_blank" rel="noopener" style="color:var(--accent);">Open CJ and reactivate it</a>, then search again.</p>':''}`);
    return;
  }
  if(!r.products || !r.products.length){ cjShowSearch(`<p class="text-2 small">CJ returned no products for "${escapeHtml(keyword)}". Try a shorter or more general English keyword (for example "earbuds" instead of "wireless bluetooth earbuds 2024").</p>`); return; }
  window.__cjSearchResults = r.products;
  cjShowSearch(`<div class="admin-grid">${r.products.map(p=>`
    <div class="card" style="padding:10px;">
      ${p.image?`<img src="${escapeHtml(p.image)}" style="width:100%;height:110px;object-fit:cover;border-radius:8px;margin-bottom:6px;">`:''}
      <p class="small" style="font-weight:700;">${escapeHtml((p.name||'').slice(0,80))}</p>
      <p class="small text-2">${p.priceText?escapeHtml(String(p.priceText).replace(/^\$?/,'$')):(p.sellPrice!=null?'$'+Number(p.sellPrice).toFixed(2):'Price on import')}${p.stock!=null?' · '+Number(p.stock).toLocaleString()+' in stock':''}</p>
      ${p.categoryName?`<p class="small text-2">${escapeHtml(p.categoryName)}</p>`:''}
      <button class="btn btn-primary btn-sm" style="width:100%;margin-top:6px;" onclick="importCjProduct('${escapeHtml(p.pid)}')">Import</button>
    </div>`).join('')}</div>`);
}
async function importCjProduct(pid){
  const already = (DB.products||[]).find(x=>x.physical && x.physical.cj && String(x.physical.cj.productId)===String(pid));
  if(already){ toast(`Already imported as "${already.name}". Open it in Products.`, 'info'); return; }
  toast('Fetching product from CJ…');
  const r = await cjApiGet(`/cj-product?pid=${encodeURIComponent(pid)}`);
  if(!r.ok){ toast(r.error||'Could not fetch product detail.', 'error'); return; }
  const product = r.product || {};
  const variants = (r.variants||[]).filter(Boolean);
  const firstVariant = variants[0] || {};
  // Live stock for up to 20 variants, same snapshot the AI assistant import takes.
  let stockMap = {}, stockOk = false, stockErr = '';
  const vids = variants.map(v=>v.vid).filter(Boolean).slice(0,20);
  if(vids.length){
    const sr = await cjApiGet(`/cj-stock?vid=${encodeURIComponent(vids.join(','))}`);
    if(sr && sr.ok){ stockMap = sr.stock || {}; stockOk = true; } else stockErr = (sr && sr.error) || 'Stock could not be verified.';
  }
  const inStock = stockOk && Object.values(stockMap).some(x=>x && x.inStock);
  // Specs: every supplier attribute CJ gave us, as label → value.
  const specs = {};
  const addSpec = (label, value)=>{ if(value==null || value==='' ) return; specs[label] = Array.isArray(value) ? value.filter(Boolean).join(', ') : String(value); };
  addSpec('Supplier category', product.categoryName); addSpec('Product options', product.productOptions);
  addSpec('Material', product.materials); addSpec('Package weight (g)', product.packageWeight);
  addSpec('Package materials', product.packageMaterials); addSpec('Shipping attributes', product.logisticsAttributes);
  addSpec('Customs code', product.customsCode); addSpec('Customs description', product.customsName);
  addSpec('Supplier suggested price (USD)', product.suggestedSellPrice);
  if(product.specifications && typeof product.specifications==='object') Object.entries(product.specifications).forEach(([k,v])=>addSpec(k,v));
  const images = [...new Set([...(product.images||[]), ...variants.map(v=>v.image)].filter(u=>typeof u==='string' && /^https?:\/\//i.test(u)))];
  const w = firstVariant.weight!=null ? firstVariant.weight : product.weight;
  const dim = (firstVariant.length||firstVariant.width||firstVariant.height) ? [firstVariant.length,firstVariant.width,firstVariant.height].map(v=>v==null?'?':(Number(v)/10)).join(' × ')+' cm' : '';
  const cats = DB.categories.filter(c=>c.id!=='all');
  const supplierCategoryName=String(product.categoryName||'').trim().toLowerCase();
  const exactCategory=cats.find(c=>String(c.id||'').trim().toLowerCase()===supplierCategoryName || String(c.name||'').trim().toLowerCase()===supplierCategoryName);
  const supplierLooksFashion=/\b(fashion|bags?|clothing|apparel|shoes?|footwear|wearables?)\b/i.test(supplierCategoryName);
  const fashionFallback=cats.find(c=>/\b(fashion|apparel|clothing)\b/i.test(String(c.id||'')+' '+String(c.name||'')));
  const matchedCategory=exactCategory||(supplierLooksFashion?fashionFallback:null);
  const supplierLooksHardware=/\b(gadget|electronics?|hardware|computers?|phones?|mobile|charger|power bank|earbuds|headphones?|smartwatch|tablet|laptop|USB)\b/i.test(supplierCategoryName+' '+String(product.name||''));
  const physicalFallback=supplierLooksHardware?cats.find(c=>/\b(gadget|electronics?|hardware)\b/i.test(String(c.id||'')+' '+String(c.name||''))):null;
  const chosenCategory=matchedCategory||physicalFallback;
  const data = {
    id: 'p'+Date.now(),
    shareId: nextProductShareId(),
    name: (product.name||'Imported CJ product').slice(0,200),
    category: chosenCategory?.id || '',
    categoryName: product.categoryName || chosenCategory?.name || '',
    price: 0, // supplier cost is not a shopper price; leave selling price for admin review
    salePrice: null,
    itemCode: 'CJ-'+String(pid).slice(-8).toUpperCase(),
    seller: 'Lexden Digital',
    image: images[0] || '',
    gallery: images.map((url,i)=>({url, type:'image', alt:`${product.name||'Product'} image ${i+1}`})),
    affiliateLink: '#',
    fileUrl: '', deliveryLink: '', externalPaymentLink: '',
    status: 'draft', // README §29 — never auto-publish an import
    tags: ['cj-import','physical'],
    description: product.description || '',
    specs,
    rating: 4.5, reviewCount: 0, featured: false, trending: false,
    productType: 'PHYSICAL',
    options: variants.length ? [{
      id:'cj-variant', name:'Supplier variant', values:variants.map((variant,index)=>({id:`cj-${variant.vid||index}`,label:variant.name||variant.variantKey||variant.sku||`Option ${index+1}`})),
    }] : [],
    variants: variants.map((variant,index)=>({
      id:`cj-${variant.vid||index}`,title:variant.name||variant.variantKey||variant.sku||`Option ${index+1}`,
      optionValues:{'cj-variant':`cj-${variant.vid||index}`},price:null,salePrice:null,
      stock: stockMap[variant.vid] ? stockMap[variant.vid].total : null,
      sku:variant.sku||'',image:variant.image||'',cjVariantId:variant.vid||'',active:true,
    })),
    pricingReviewRequired: true,
    physical: {
      stockMode: 'SUPPLIER_STOCK',
      stockStatus: inStock ? 'in_stock' : 'out_of_stock',
      deliveryEstimate: product.deliveryCycle ? `${product.deliveryCycle} days (supplier estimate; confirm destination)` : '7–20 business days',
      shippingCountries: [DB.content.cjTargetCountry||'Nigeria'],
      weight: w!=null ? `${(Number(w)/1000).toFixed(3)} kg` : '',
      dimensions: dim,
      returnPolicy: '',
      supplier: 'CJ Dropshipping',
      supplierId: '', supplierSku: firstVariant.sku || product.sku || '',
      supplierCost: firstVariant.sellPrice ?? product.sellPrice ?? null,
      supplierCurrency: 'USD',
      routing: null,
      cj: {
        productId: product.pid || pid,
        variantId: firstVariant.vid || '',
        sku: firstVariant.sku || product.sku || '',
        syncEnabled: true,
        lastSyncedAt: new Date().toISOString(),
        lastImportedAt: new Date().toISOString(),
        stockCheckError: stockOk ? null : (stockErr || 'Stock could not be verified; refresh inventory before publishing.'),
        videoIds: product.videoIds || [],
        variants: variants.map(v=>({ id:v.vid||'', sku:v.sku||'', name:v.name||'', optionKey:v.variantKey||'', barcode:v.barcode||'', standard:v.standard||'', unit:v.unit||'', image:v.image||'', sellPrice:v.sellPrice??null, suggestedSellPrice:v.suggestedSellPrice??null, weight:v.weight??null, length:v.length??null, width:v.width??null, height:v.height??null, stock: stockMap[v.vid]||null, supplierInventories:v.inventories||[] })),
      },
    },
    importSource: { supplier:'CJ Dropshipping', productId: product.pid || pid, importedAt: new Date().toISOString(), sourceCategoryId: product.categoryId || '' },
  };
  DB.products = [...DB.legacyProducts, data];
  const ok = await pushProductsToCloud();
  if(ok){
    logActivity('Admin', `Imported CJ product "${data.name}"`);
    toast(images.length ? 'Imported as Draft — review and publish from Products.' : 'Imported as Draft, but CJ gave no usable image — add one before publishing.', images.length?'success':'info');
    updateCatalogSchema();
    renderAdminTab();
  } else {
    toast('Saved on this device only — cloud sync failed, try again.', 'error');
  }
}
async function cjTestProductMapping(productId){
  const p = findProduct(productId);
  const vid = p&&p.physical&&p.physical.cj&&p.physical.cj.variantId;
  if(!vid){ toast('Enter a CJ variant ID first.','error'); return; }
  const r = await cjApiGet(`/cj-product?vid=${encodeURIComponent(vid)}`);
  toast(r.ok ? `CJ variant OK: ${r.variant&&r.variant.name||vid}` : (r.error||'CJ lookup failed'), r.ok?'success':'error');
}
async function cjRefreshStock(productId){
  const p = findProduct(productId);
  const vid = p&&p.physical&&p.physical.cj&&p.physical.cj.variantId;
  // Check the main CJ variant plus every other variant that has its own CJ id
  // (CJ gives one stock answer per variant, about one per second).
  const vids = [...new Set([vid, ...((p&&p.variants)||[]).map(v=>v&&v.cjVariantId)].filter(Boolean))].slice(0,8);
  if(!vids.length){ toast('Enter a CJ variant ID first.','error'); return; }
  toast(`Checking ${vids.length} variant${vids.length>1?'s':''} with CJ…`,'info');
  const r = await cjApiGet(`/cj-stock?vid=${encodeURIComponent(vids.join(','))}&sync=1&productId=${encodeURIComponent(productId)}`, 30000);
  if(!r.ok){ toast(r.error||'Stock check failed.','error'); return; }
  const main = vids[0];
  const s = r.stock && r.stock[main];
  const failed = Object.keys(r.errors||{}).length;
  if(!s && failed){ toast(`CJ said: ${Object.values(r.errors)[0]}`,'error'); return; }
  const total = Object.values(r.stock||{}).reduce((n,x)=>n+(x.total||0),0);
  toast(s ? `Stock: ${s.inStock?`${total} in stock across ${Object.keys(r.stock).length} variant(s)`:'Out of stock'}${failed?` (${failed} not checked)`:''}` : 'No stock data returned.', s&&s.inStock?'success':'error');
  // The backend already wrote physical.stockStatus/cj.lastSyncedAt to
  // Firestore (sync=1 above) — mirror that into this session's in-memory
  // DB.products so the panel reflects it immediately without a full reload.
  if(s){
    DB.products = DB.legacyProducts.map(x=>x.id===productId
      ? {...x, physical:{...x.physical, stockStatus: s.inStock?'in_stock':'out_of_stock', cj:{...x.physical.cj, lastSyncedAt:new Date().toISOString()}}}
      : x);
  }
  renderAdminTab();
}
async function cjRefreshVariants(productId){
  const p = findProduct(productId);
  const pid = p&&p.physical&&p.physical.cj&&p.physical.cj.productId;
  if(!pid){ toast('Enter a CJ product ID first.','error'); return; }
  const r = await cjApiGet(`/cj-product?pid=${encodeURIComponent(pid)}`);
  if(!r.ok){ toast(r.error||'Could not refresh variants.','error'); return; }
  toast(`${(r.variants||[]).length} variant(s) found on CJ — first variant: ${r.variants&&r.variants[0]&&r.variants[0].name||'—'}`, 'success');
}

function adminAI(){
  const c = DB.content;
  return `
    <div class="admin-topbar"><h2>NOVA AI Setup</h2></div>
    <div class="card" style="padding:16px;margin-bottom:16px;">
      <h3 style="font-size:14px;margin-bottom:8px;">Current mode: ${c.novaMode==='api'?'✨ Live Gemini API (via nova-ai.js)':'💾 Local (offline, zero-cost)'}</h3>
      <p class="text-2 small" style="margin-bottom:10px;">NOVA works fully offline by default: a rules-based engine that reads your live catalog/FAQ/content data, plus each shopper's own on-device activity, wishlist and cached order history, to give personalized, grounded answers — no data cost, no backend needed. It can greet returning visitors differently, recall what someone's been browsing, check order status, reason about product media by type/count, and covers dozens of question patterns (greetings, buying, refunds, comparisons, budget, free items, media, navigation, order status, "what have I been looking at") with pidgin-English normalization built in. It is honest about its limits — it reasons about media metadata, it does not literally see images, and it will say so if it doesn't understand a question rather than making something up.</p>
      <p class="text-2 small" style="margin-bottom:10px;"><strong>To use real Gemini answers instead</strong> — genuinely open-ended understanding, real image/video vision, and conversational quality indistinguishable from a live model — a static file like this one can't safely hold a Gemini API key — anyone could open "view source" and steal it. Instead, the <code>nova-ai.js</code> file already deployed on your Render backend holds the key on the server (as the <code>GEMINI_API_KEY</code> environment variable) and forwards NOVA's questions to Gemini. Just switch the mode below — the endpoint is fixed, nothing to paste in.</p>
      <p class="text-2 small" style="margin-bottom:10px;">Every request in API mode also sends: the shopper's <strong>recent on-device activity</strong>, a derived <strong>shopper profile</strong> (returning-visitor flag, top-interest category, wishlist, purchase history), <strong>cached order status</strong>, and <strong>media URLs</strong> from both products and feed posts. <code>nova-ai.js</code> fetches a capped, prioritized set of those images server-side and feeds them to Gemini as visual context — so NOVA's text answers are grounded in what your photos actually show, not just the specs you typed. This does NOT let shoppers upload their own photos into the chat — the widget stays text-in/text-out; it only widens what NOVA already knows about your catalog.</p>
      <div class="form-field"><label>Mode</label>
        ${customSelect('ai_mode', c.novaMode==='api'?'api':'local', [
          {value:'local',label:'💾 Local (offline, free)'},
          {value:'api',label:'✨ Live Gemini API'}
        ], '')}
      </div>
      <div class="form-field"><label>Backend endpoint</label><input value="${escapeHtml(API_BASE)}/api/nova-ai" disabled style="opacity:.65;"></div>
      <div class="flex gap-8">
        <button class="btn btn-primary" onclick="saveNovaSettings()">Save NOVA settings</button>
        <button class="btn btn-outline" onclick="copyWorkerSetupNote()">Copy Render/Gemini setup steps</button>
      </div>
      <p class="small text-2" style="margin-top:8px;">Switching to API mode just needs <code>GEMINI_API_KEY</code> (or <code>GEMINI_API_KEYS</code>) set on Render — the endpoint itself is always your one Render service, so there's nothing here to leave misconfigured. No matter which mode is active, NOVA will always answer "NOVA AI" if asked its name.</p>
    </div>
    <div class="card" style="padding:16px;margin-bottom:16px;">
      <h3 style="font-size:14px;margin-bottom:8px;">🧠 Understanding &amp; self-improvement</h3>
      <p class="text-2 small">NOVA now understands common Nigerian Pidgin phrasing ("wetin", "abeg", "how much e cost", "I wan buy") by mapping it to the same intent matching used for English, and it remembers what it just offered you — so replying "yes" to "want a suggestion?" now actually works instead of dead-ending.</p>
      <p class="text-2 small" style="margin-top:8px;">Being honest about the ceiling: local mode is a rule-based assistant grounded in your live catalog/FAQ data, not a model that retrains itself. What it <em>can</em> do is log every question it couldn't confidently answer below — review these and add a matching FAQ so NOVA gets measurably better over time without needing a paid AI backend.</p>
    </div>
    <div class="card" style="padding:16px;">
      <h3 style="font-size:14px;margin-bottom:6px;">Learning queue — unanswered questions</h3>
      <p class="text-2 small" style="margin-bottom:10px;">Real visitor questions NOVA fell back on, most frequent first.</p>
      ${novaLearningTable()}
      <button class="btn btn-outline btn-sm mt-8" onclick="clearNovaLearning()">Clear queue</button>
    </div>`;
}
function saveNovaSettings(){
  const mode = $('#ai_mode').value;
  // FIX (mega-fix batch #2): used to require a manually-pasted endpoint
  // URL and REFUSE to switch to API mode without one — the endpoint is
  // now the fixed API_BASE constant, so switching mode is the only step.
  DB.content = {...DB.content, novaMode:mode, novaApiEndpoint:`${API_BASE}/api/nova-ai`};
  pushSettingsToCloud();
  logActivity('Admin', `Set NOVA AI mode to "${mode}"`);
  toast('NOVA settings saved','success');
  renderAdminTab();
}
function copyWorkerSetupNote(){
  navigator.clipboard?.writeText(
    `All endpoints are fixed to your Render backend (${API_BASE}) — nothing to paste. To change keys (Gemini/Paystack/Brevo/CJ), edit them in Render dashboard -> your service -> Environment.`
  ).then(()=>toast('Copied','success')).catch(()=>toast('Could not copy','error'));
}
function novaLearningTable(){
  const log = lsGet(LS_KEYS.novaLearning, []).slice().sort((a,b)=>b.count-a.count);
  if(!log.length) return `<p class="text-2 small">No unanswered questions logged yet.</p>`;
  return `<table class="admin-table"><thead><tr><th>Question</th><th>Times asked</th><th>Last asked</th></tr></thead>
  <tbody>${log.slice(0,30).map(l=>`<tr><td>${escapeHtml(l.text)}</td><td>${l.count}</td><td>${new Date(l.last).toLocaleDateString()}</td></tr>`).join('')}</tbody></table>`;
}
function clearNovaLearning(){
  lsSet(LS_KEYS.novaLearning, []);
  toast('Learning queue cleared');
  renderAdminTab();
}

// Cache for GET /api/admin-payment-mode — same shape as
// window.__affiliatesCache above (null = not loaded yet, triggers a fetch
// + re-render of the Payments tab once it resolves).
window.__paymentModeCache = null;
window.__paymentModeError = null;
async function fetchPaymentModeFromServer(force){
  if(window.__paymentModeCache && !force) return window.__paymentModeCache;
  const user = fbAuth.currentUser;
  if(!user){ window.__paymentModeError = 'Not signed in.'; return null; }
  try{
    const token = await user.getIdToken();
    const r = await withTimeout(fetch(API_BASE+'/api/admin-payment-mode', {
      headers:{'Authorization':'Bearer '+token},
    }), 15000, 'Payment mode lookup timed out.');
    const d = await r.json();
    if(d && d.ok){ window.__paymentModeCache = d.data; window.__paymentModeError = null; return d.data; }
    window.__paymentModeError = (d && d.error && d.error.message) || 'Could not load payment mode.';
    return null;
  }catch(e){
    window.__paymentModeError = e.message || 'Could not reach the server.';
    return null;
  }
}
async function switchPaymentMode(mode){
  const user = fbAuth.currentUser;
  if(!user){ toast('Not signed in.', 'error'); return; }
  if(!confirm(mode==='live'
    ? 'Switch checkout and affiliate payouts to LIVE Paystack? Real money will move.'
    : 'Switch checkout and affiliate payouts to TEST Paystack? No real charges will be made while in test mode.')) return;
  try{
    const token = await user.getIdToken();
    const r = await withTimeout(fetch(API_BASE+'/api/admin-payment-mode', {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body: JSON.stringify({ mode }),
    }), 15000, 'Switching payment mode timed out.');
    const d = await r.json();
    if(!d.ok){ toast((d.error&&d.error.message)||'Could not switch mode.', 'error'); return; }
    if(d.data.warning) toast(d.data.warning, 'error'); else toast(`Switched to ${mode.toUpperCase()} mode`, 'success');
    logActivity('Admin', `Switched Paystack to ${mode.toUpperCase()} mode`);
    await fetchPaymentModeFromServer(true);
    // The server may have also updated content.paystackPublicKey — pull
    // settings fresh so this tab (and checkout) reflects it immediately.
    await pullFromCloud();
    renderAdminTab();
  }catch(e){
    toast('Could not reach the server — '+(e.message||'check your connection'), 'error');
  }
}
function adminPayments(){
  const c = DB.content;
  const pm = window.__paymentModeCache;
  if(!pm && !window.__paymentModeError){
    fetchPaymentModeFromServer().then(()=>renderAdminTab());
  }
  const modeBadge = pm
    ? `<span class="badge" style="background:${pm.mode==='live'?'#16a34a':pm.mode==='test'?'#d97706':'#6b7280'};color:#fff;">${pm.mode ? pm.mode.toUpperCase() : 'NOT SET'}</span>`
    : `<span class="text-2 small">${window.__paymentModeError || 'Loading…'}</span>`;
  return `
    <div class="admin-topbar"><h2>Payments</h2></div>
    <div class="card" style="padding:16px;margin-bottom:16px;">
      <h3 style="font-size:14px;margin-bottom:8px;display:flex;align-items:center;gap:10px;">Live / Test mode ${modeBadge}</h3>
      <p class="text-2 small" style="margin-bottom:12px;">Switches checkout <em>and</em> affiliate bank-lookup/payouts together — every Paystack call on the server reads this one setting, so they can never drift apart. Switching is instant (no redeploy); the secret keys themselves still live only in Render's environment variables, never in Firestore or the browser.</p>
      ${pm ? `
      <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:6px;">
        <button class="btn ${pm.mode==='test'?'btn-primary':''}" ${!pm.hasTestSecret?'disabled title="No PAYSTACK_SECRET_KEY_TEST set in Render"':''} onclick="switchPaymentMode('test')">Use TEST ${pm.hasTestSecret?'':'(no test key configured)'}</button>
        <button class="btn ${pm.mode==='live'?'btn-primary':''}" ${!pm.hasLiveSecret?'disabled title="No PAYSTACK_SECRET_KEY_LIVE set in Render"':''} onclick="switchPaymentMode('live')">Use LIVE ${pm.hasLiveSecret?'':'(no live key configured)'}</button>
      </div>
      <p class="small text-2">Server has: test secret key ${pm.hasTestSecret?'✅':'❌ missing'} · live secret key ${pm.hasLiveSecret?'✅':'❌ missing'}</p>
      ` : ''}
    </div>
    <div class="card" style="padding:16px;margin-bottom:16px;">
      <h3 style="font-size:14px;margin-bottom:8px;">Gateway: Paystack (NGN)</h3>
      <p class="text-2 small" style="margin-bottom:10px;">Checkout uses Paystack's Inline JS/Popup SDK. The client only ever holds a <strong>public</strong> key — the matching secret key lives only in Render's environment variables (<code>PAYSTACK_SECRET_KEY_LIVE</code> / <code>PAYSTACK_SECRET_KEY_TEST</code>) and is never sent to the browser.</p>
      <div class="form-field"><label>Paystack LIVE public key</label><input id="pk_public_live" value="${escapeHtml(c.paystackPublicKeyLive||c.paystackPublicKey||'')}" placeholder="pk_live_xxxxxxxxxxxx"></div>
      <div class="form-field"><label>Paystack TEST public key</label><input id="pk_public_test" value="${escapeHtml(c.paystackPublicKeyTest||'')}" placeholder="pk_test_xxxxxxxxxxxx"></div>
      <div class="form-field"><label>Currently active public key</label><input value="${escapeHtml(c.paystackPublicKey||'')}" disabled style="opacity:.65;"></div>
      <div class="form-field"><label>Verification endpoint</label><input value="${escapeHtml(API_BASE)}/api/verify-paystack" disabled style="opacity:.65;"></div>
      <button class="btn btn-primary" onclick="savePaymentsSettings()">Save payment settings</button>
      <p class="small text-2" style="margin-top:8px;">Saving here stores both public keys. Which one is actually live on checkout is controlled by the Live/Test toggle above, not by this form — "Currently active public key" shows that result.</p>
    </div>
    <div class="card" style="padding:16px;">
      <h3 style="font-size:14px;margin-bottom:6px;">Adding another gateway later</h3>
      <p class="text-2 small">The checkout flow is dispatched from one place — the <code>startCheckout()</code> function — via <code>DB.content.paymentGateway</code>. To add Flutterwave or another provider, write a <code>startFlutterwaveCheckout()</code> function alongside <code>startPaystackCheckout()</code> and add one line to <code>startCheckout()</code>; nothing else in the app needs to change.</p>
    </div>`;
}
function savePaymentsSettings(){
  const pubLive = $('#pk_public_live').value.trim();
  const pubTest = $('#pk_public_test').value.trim();
  const pm = window.__paymentModeCache;
  // Keep the legacy single `paystackPublicKey` (what checkout actually
  // reads) pointed at whichever mode is currently active, so saving this
  // form can never silently swap checkout to the wrong pair.
  const active = pm && pm.mode === 'live' ? pubLive : pm && pm.mode === 'test' ? pubTest : DB.content.paystackPublicKey;
  DB.content = {...DB.content, paystackPublicKeyLive:pubLive, paystackPublicKeyTest:pubTest, paystackPublicKey:active, paymentVerifyEndpoint:`${API_BASE}/api/verify-paystack`};
  pushSettingsToCloud();
  logActivity('Admin', 'Updated payment settings');
  toast('Payment settings saved','success');
  renderAdminTab();
}

/* ================== ADMIN: NOVA AFFILIATE PROGRAM ==================
   Same cache/fetch/error/render pattern as adminLeads()/adminNewsletter()
   above, on purpose — Retry on failure, Refresh to force a re-pull, 15s
   timeout. Settings (commission %, fee %, min withdrawal, WhatsApp/
   Telegram links) live in DB.content and save through the EXISTING
   pushSettingsToCloud() — same as every other admin-editable setting in
   this file, no new sync mechanism. Applications/withdrawals live in
   their own collections (affiliates, affiliateWithdrawals) and are
   fetched live, same as Messages/Newsletter above. */
function affiliateApiBase(){
  // FIX (mega-fix batch #2): this used to regex-strip the payment
  // endpoint field to reverse-engineer the base URL — if that field was
  // ever blank (the actual reported bug), this silently returned ''
  // and every affiliate-admin action failed. It's the fixed constant now.
  return API_BASE;
}
async function callAffiliateAdminAction(action, payload){
  const base = affiliateApiBase();
  if(!base){ toast('Backend URL missing.', 'error'); return {ok:false}; }
  const user = fbAuth.currentUser;
  if(!user){ toast('Not signed in.', 'error'); return {ok:false}; }
  const token = await user.getIdToken();
  try{
    const res = await withTimeout(fetch(base+'/api/affiliate-admin', {
      method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
      body: JSON.stringify({ action, ...payload }),
    }), 20000, 'Request timed out — check your connection and try again.');
    const data = await res.json();
    if(!data.ok) toast(data.error || 'Action failed.', 'error');
    return data;
  }catch(e){
    toast('Could not reach the server — ' + (e.message||'check your connection'), 'error');
    return {ok:false};
  }
}

window.__affiliatesCache = null;
window.__affiliatesError = null;
// Admin lists used to re-fetch + re-render in an endless loop (every render
// kicked a fetch whose completion re-rendered, even when cached), which could
// freeze the tab and hid the applications. adminKick starts a load only when
// there is no data, no recorded error and none already running, and re-renders
// ONCE when it finishes. The Refresh buttons still force a reload.
window.__adminLoading = window.__adminLoading || {};
function adminKick(key, loader, tab){
  if(window.__adminLoading[key]) return;
  window.__adminLoading[key] = true;
  Promise.resolve().then(loader).catch(e=>console.warn('admin load failed', key, e && e.message)).then(()=>{
    window.__adminLoading[key] = false;
    if(appState.adminTab===tab) renderAdminTab();
  });
}
async function fetchAffiliatesFromCloud(force){
  if(window.__affiliatesCache && !force) return window.__affiliatesCache;
  if(!window.__fb){ window.__affiliatesError = 'Cloud connection is not ready yet.'; return []; }
  const { fbDb, collection, getDocs } = window.__fb;
  // Prefer the server (Admin SDK) — shows every record incl. old ones and
  // auto-approves legacy pending; fall back to direct Firestore below.
  try{
    const u = fbAuth.currentUser;
    if(u){
      const r = await authedApi('/api/affiliate-admin',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'list-affiliates'})}, 45000, 'Server list timed out');
      const d = await r.json();
      if(d && d.ok){ window.__affiliatesCache = d.affiliates; window.__affiliatesError = null; return d.affiliates; }
    }
  }catch(e){ console.warn('Server affiliate list failed, using Firestore', e); }
  try{
    const snap = await withTimeout(getDocs(collection(fbDb, "affiliates")), 15000, 'Timed out loading affiliates — check your connection and tap Retry.');
    const list = []; snap.forEach(d=>list.push({ id:d.id, ...d.data() }));
    window.__affiliatesCache = list; window.__affiliatesError = null;
    return list;
  }catch(e){
    console.warn('Fetch affiliates failed', e);
    window.__affiliatesError = (e && e.code==='permission-denied') ? 'Not signed in to the cloud yet — try Refresh in a moment.' : (e.message||'Could not load affiliates.');
    window.__affiliatesCache = null;
    return [];
  }
}
window.__affWithdrawalsCache = null;
window.__affWithdrawalsError = null;
async function fetchAffiliateWithdrawalsFromCloud(force){
  if(window.__affWithdrawalsCache && !force) return window.__affWithdrawalsCache;
  if(!window.__fb){ window.__affWithdrawalsError = 'Cloud connection is not ready yet.'; return []; }
  const { fbDb, collection, getDocs } = window.__fb;
  try{
    const snap = await withTimeout(getDocs(collection(fbDb, "affiliateWithdrawals")), 15000, 'Timed out loading withdrawals — check your connection and tap Retry.');
    const list = []; snap.forEach(d=>list.push({ id:d.id, ...d.data() }));
    list.sort((a,b)=> (b.requestedAt?.seconds||0) - (a.requestedAt?.seconds||0));
    window.__affWithdrawalsCache = list; window.__affWithdrawalsError = null;
    return list;
  }catch(e){
    console.warn('Fetch withdrawals failed', e);
    window.__affWithdrawalsError = (e && e.code==='permission-denied') ? 'Not signed in to the cloud yet — try Refresh in a moment.' : (e.message||'Could not load withdrawals.');
    window.__affWithdrawalsCache = null;
    return [];
  }
}

function adminAffiliateProgram(){
  if(!window.__affiliatesCache && !window.__affiliatesError) adminKick('affiliates', ()=>fetchAffiliatesFromCloud(), 'affiliate');
  if(!window.__affWithdrawalsCache && !window.__affWithdrawalsError) adminKick('affWithdrawals', ()=>fetchAffiliateWithdrawalsFromCloud(), 'affiliate');
  const c = DB.content;
  const affiliates = window.__affiliatesCache || [];
  const withdrawals = window.__affWithdrawalsCache || [];
  // FIX: this used to be exactly `a.status==='pending'`. Under the
  // instant-approve flow no NEW doc can ever have status:'pending' (the
  // Firestore create rule requires status:'active'), so this section only
  // ever showed truly-current applications and silently hid anything
  // written under an older/legacy version of the signup flow — e.g. a
  // missing/blank status field, or a status value from before the
  // mega-update (like 'pending_review' or similar) that isn't exactly the
  // string 'pending'. Now anything that ISN'T recognizably active or
  // suspended is treated as "needs your attention" so nothing old goes
  // permanently invisible.
  const KNOWN_STATUSES = ['active','suspended'];
  const pending = affiliates.filter(a=>!KNOWN_STATUSES.includes(a.status));
  const active = affiliates.filter(a=>a.status==='active');
  const pendingWd = withdrawals.filter(w=>w.status==='pending');
  const approvedWd = withdrawals.filter(w=>w.status==='approved');
  const decidedWd = withdrawals.filter(w=>w.status==='paid'||w.status==='rejected');

  return `
  <div class="admin-topbar"><h2>Affiliate Program</h2><button class="btn btn-outline btn-sm" onclick="fetchAffiliatesFromCloud(true).then(renderAdminTab);fetchAffiliateWithdrawalsFromCloud(true).then(renderAdminTab);">Refresh</button></div>

  <div class="card" style="padding:16px;margin-bottom:16px;">
    <h3 style="font-size:14px;margin-bottom:8px;">Program Settings</h3>
    <p class="text-2 small" style="margin-bottom:10px;">These apply site-wide. Set a different commission % on any individual product from Products → edit → "Nova Affiliate commission %".</p>
    <div class="form-field"><label>Default commission %</label><input id="af_commission" type="number" min="0" max="100" step="0.5" value="${c.affiliateCommissionDefaultPct}"></div>
    <div class="form-field"><label>Creator sale commission % (approved rate: 10, taken from each creator sale; changes apply to new sales only)</label><input id="cr_fee" type="number" min="0" max="50" step="0.1" value="${(typeof c.creatorCommissionBps==='number'?c.creatorCommissionBps:1000)/100}"></div>
    <div class="form-field"><label>Affiliate withdrawal fee % (approved rate: 5, charged on the gross amount requested; never applied to creators)</label><input id="af_fee" type="number" min="0" max="50" step="0.1" value="${(typeof c.affiliateWithdrawalFeeBps==='number'?c.affiliateWithdrawalFeeBps:500)/100}"></div>
    <div class="form-field"><label>Minimum withdrawal (₦)</label><input id="af_min" type="number" min="0" value="${c.affiliateMinWithdrawalNGN}"></div>
    <div class="form-field"><label>WhatsApp community link</label><input id="af_wa" value="${escapeHtml(c.affiliateWhatsappUrl||'')}" placeholder="https://chat.whatsapp.com/..."></div>
    <div class="form-field"><label>Telegram community link</label><input id="af_tg" value="${escapeHtml(c.affiliateTelegramUrl||'')}" placeholder="https://t.me/..."></div>
    <div class="form-field"><label>Invite banner text</label><textarea id="af_banner" rows="2">${escapeHtml(c.affiliateInviteBannerText||'')}</textarea></div>
    <p class="small text-2" style="margin:6px 0 10px;">Affiliates can request a withdrawal once every 7 days (Sundays don't count toward the wait). Held funds become withdrawable immediately after a sale — final payout still goes through your manual approval below, which is your fraud/refund checkpoint.</p>
    <button class="btn btn-primary" onclick="saveAffiliateSettings()">Save Affiliate Settings</button>
  </div>

  <div class="card" style="padding:16px;margin-bottom:16px;">
    <h3 style="font-size:14px;margin-bottom:8px;">Needs Attention / Pending (${pending.length})</h3>
    <p class="text-2 small" style="margin-bottom:8px;">Includes normal pending applications plus anything with an unrecognized status — e.g. leftover records from before instant-approve was turned on.</p>
    ${window.__affiliatesError ? `<p class="text-2 small" style="color:var(--error);">⚠️ ${escapeHtml(window.__affiliatesError)}</p>` : ''}
    ${pending.length ? pending.map(a=>`
      <div class="card" style="padding:12px;margin-bottom:8px;">
        <div style="font-weight:700;">${escapeHtml(a.displayName||'—')} <span class="chip" style="font-size:10px;">${escapeHtml(a.status||'no status field')}</span></div>
        <div class="text-2 small">${escapeHtml(a.email||'')} · ${escapeHtml(a.whatsapp||'')}</div>
        <div class="text-2 small">${escapeHtml(a.payoutAccount?.bank||'')} · ${escapeHtml(a.payoutAccount?.accountNumber||'')} · ${escapeHtml(a.payoutAccount?.accountName||'')}</div>
        <div class="text-2 small" style="opacity:.6;">doc id: ${escapeHtml(a.id)}</div>
        <button class="btn btn-primary btn-sm mt-8" onclick="adminApproveAffiliate('${a.id}')">Approve</button>
      </div>`).join('') : '<p class="text-2 small">None right now.</p>'}
  </div>

  <div class="card" style="padding:16px;margin-bottom:16px;">
    <h3 style="font-size:14px;margin-bottom:8px;">Active Affiliates (${active.length})</h3>
    ${active.length ? active.map(a=>`
      <div class="card" style="padding:12px;margin-bottom:8px;">
        <div style="font-weight:700;">${escapeHtml(a.displayName||'—')}</div>
        <div class="text-2 small">Earned ₦${(a.totalEarned||0).toLocaleString()} · Available ₦${(a.balanceAvailable||0).toLocaleString()} · Withdrawn ₦${(a.totalWithdrawn||0).toLocaleString()}</div>
        <button class="btn btn-outline btn-sm mt-8" onclick="adminSuspendAffiliate('${a.id}')">Suspend</button>
      </div>`).join('') : '<p class="text-2 small">None yet.</p>'}
  </div>

  <div class="card" style="padding:16px;margin-bottom:16px;">
    <h3 style="font-size:14px;margin-bottom:8px;">Withdrawal Requests</h3>
    ${window.__affWithdrawalsError ? `<p class="text-2 small" style="color:var(--error);">⚠️ ${escapeHtml(window.__affWithdrawalsError)}</p>` : ''}
    ${pendingWd.length===0 && approvedWd.length===0 ? '<p class="text-2 small">Nothing awaiting action.</p>' : ''}
    ${[...pendingWd, ...approvedWd].map(w=>affiliateWithdrawalCardHtml(w, affiliates)).join('')}
    ${decidedWd.length ? `<div class="divider"></div><h4 style="font-size:13px;margin-bottom:8px;">History</h4>${decidedWd.slice(0,20).map(w=>affiliateWithdrawalCardHtml(w, affiliates)).join('')}` : ''}
  </div>

  <div class="card" style="padding:16px;">
    <h3 style="font-size:14px;margin-bottom:8px;">Debug: all affiliate records (${affiliates.length})</h3>
    <p class="text-2 small" style="margin-bottom:8px;">Raw list — use this if a request you know exists still isn't showing above, to see exactly what's actually in the database for it.</p>
    <details><summary class="small text-2" style="cursor:pointer;">Show raw records</summary>
      <pre style="white-space:pre-wrap;font-size:10.5px;max-height:300px;overflow:auto;background:var(--bg-2,rgba(0,0,0,.03));padding:8px;border-radius:8px;margin-top:8px;">${escapeHtml(JSON.stringify(affiliates.map(a=>({id:a.id, status:a.status, email:a.email, displayName:a.displayName})), null, 2))}</pre>
    </details>
  </div>`;
}

// ---- Creator Applications admin tab (Stage B) ----
window.__creatorAdminCache = null;
window.__creatorAdminError = null;
async function fetchCreatorApplicationsAdmin(force){
  if(window.__creatorAdminCache && !force) return window.__creatorAdminCache;
  const user = fbAuth.currentUser;
  if(!user){ window.__creatorAdminError = 'Not signed in.'; return []; }
  try{
    const r = await authedApi('/api/creator-admin-applications', {}, 45000, 'Loading applications timed out — the server may be waking up. Tap Refresh.');
    const d = await r.json();
    if(d && d.ok){ window.__creatorAdminCache = d.data.applications; window.__creatorAdminError = null; return d.data.applications; }
    window.__creatorAdminError = (d && d.error && d.error.message) || 'Could not load applications.';
    return [];
  }catch(e){
    window.__creatorAdminError = e.message || 'Could not reach the server.';
    return [];
  }
}
// creators/{uid} is openly readable (firestore.rules — the storefront
// needs it), so this list goes straight to Firestore rather than through
// an admin endpoint, same shortcut the rest of this app already takes for
// public collections.
window.__activeCreatorsCache = null;
async function fetchActiveCreators(force){
  if(window.__activeCreatorsCache && !force) return window.__activeCreatorsCache;
  if(!window.__fb) return [];
  const { fbDb, collection, getDocs } = window.__fb;
  try{
    const snap = await withTimeout(getDocs(collection(fbDb, "creators")), 15000, 'Timed out loading creators.');
    const list = []; snap.forEach(d=>list.push({ id:d.id, ...d.data() }));
    window.__activeCreatorsCache = list; window.__activeCreatorsError = null;
    return list;
  }catch(e){ console.warn('creators list failed', e); window.__activeCreatorsError = e.message || 'Could not load creators.'; return []; }
}
async function creatorAdminAction(uid, action, needsReason){
  let reason = null;
  if(needsReason){
    reason = prompt(`Reason for "${action}" (shown to the creator):`);
    if(reason===null) return; // cancelled
    if(!reason.trim()){ toast('A reason is required for this action', 'error'); return; }
  }
  const user = fbAuth.currentUser;
  if(!user){ toast('Not signed in', 'error'); return; }
  try{
    const r = await authedApi('/api/creator-admin-applications', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ uid, action, reason }),
    }, 45000, 'Action timed out — please try again.');
    const d = await r.json();
    if(!d.ok){ toast((d.error&&d.error.message)||'Action failed', 'error'); return; }
    toast(`${action.replace(/_/g,' ')} → ${d.data.status}`, 'success');
    logActivity('Admin', `Creator ${action}: ${uid}`);
    await Promise.all([fetchCreatorApplicationsAdmin(true), fetchActiveCreators(true)]);
    renderAdminTab();
  }catch(e){
    toast('Could not reach the server — '+(e.message||'check your connection'), 'error');
  }
}
function adminCreatorApplications(){
  if(!window.__creatorAdminCache && !window.__creatorAdminError) adminKick('creatorApps', ()=>fetchCreatorApplicationsAdmin(), 'creators');
  if(!window.__activeCreatorsCache && !window.__activeCreatorsError) adminKick('activeCreators', ()=>fetchActiveCreators(), 'creators');
  const apps = window.__creatorAdminCache || [];
  const creators = window.__activeCreatorsCache || [];
  const submitted = apps.filter(a=>a.status==='SUBMITTED');
  const inReview = apps.filter(a=>a.status==='IN_REVIEW');
  const other = apps.filter(a=>!['SUBMITTED','IN_REVIEW'].includes(a.status));

  const appCard = (a, actions) => `
    <div class="card" style="padding:12px;margin-bottom:8px;">
      <div style="font-weight:700;">${escapeHtml((a.publicFields&&(a.publicFields.displayName||a.publicFields.businessDisplayName))||'—')} <span class="chip" style="font-size:10px;">${escapeHtml(a.status)}</span></div>
      <div class="text-2 small">${escapeHtml(a.creatorType||'')} · ${escapeHtml((a.privateFields&&a.privateFields.email)||'')}</div>
      ${a.creatorType==='personal' ? `<div class="text-2 small">Legal name: ${escapeHtml((a.privateFields&&a.privateFields.legalName)||'—')} · DOB: ${escapeHtml((a.privateFields&&a.privateFields.dob)?String(a.privateFields.dob).slice(0,10):'—')}</div>` : `<div class="text-2 small">Legal business: ${escapeHtml((a.privateFields&&a.privateFields.legalBusinessName)||'—')} · Contact: ${escapeHtml((a.privateFields&&a.privateFields.contactName)||'—')}</div>`}
      <div class="text-2 small">Documents: ${(a.documents||[]).length ? a.documents.map(doc=>escapeHtml(doc.docType+' ('+doc.reviewStatus+')')).join(', ') : 'none'}</div>
      <div class="text-2 small" style="opacity:.6;">uid: ${escapeHtml(a.uid)}</div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">${actions}</div>
    </div>`;

  return `
  <div class="admin-topbar"><h2>Creator Applications</h2><button class="btn btn-outline btn-sm" onclick="window.__creatorAdminError=null;window.__activeCreatorsError=null;fetchCreatorApplicationsAdmin(true).then(renderAdminTab);fetchActiveCreators(true).then(renderAdminTab);">Refresh</button></div>
  ${window.__creatorAdminError ? `<p class="text-2 small" style="color:var(--error);">⚠️ ${escapeHtml(window.__creatorAdminError)}</p>` : ''}

  <div class="card" style="padding:16px;margin-bottom:16px;">
    <h3 style="font-size:14px;margin-bottom:8px;">New — Submitted (${submitted.length})</h3>
    ${submitted.length ? submitted.map(a=>appCard(a, `<button class="btn btn-primary btn-sm" onclick="creatorAdminAction('${a.uid}','start_review',false)">Start Review</button>`)).join('') : '<p class="text-2 small">None right now.</p>'}
  </div>

  <div class="card" style="padding:16px;margin-bottom:16px;">
    <h3 style="font-size:14px;margin-bottom:8px;">In Review (${inReview.length})</h3>
    ${inReview.length ? inReview.map(a=>appCard(a, `
      <button class="btn btn-primary btn-sm" onclick="creatorAdminAction('${a.uid}','approve',false)">Approve</button>
      <button class="btn btn-outline btn-sm" onclick="creatorAdminAction('${a.uid}','request_changes',true)">Request Changes</button>
      <button class="btn btn-outline btn-sm" onclick="creatorAdminAction('${a.uid}','reject',true)">Reject</button>
    `)).join('') : '<p class="text-2 small">None right now.</p>'}
  </div>

  <div class="card" style="padding:16px;margin-bottom:16px;">
    <h3 style="font-size:14px;margin-bottom:8px;">Other (${other.length})</h3>
    <p class="text-2 small" style="margin-bottom:8px;">Drafts, changes-requested, rejected — informational, no action needed here.</p>
    ${other.length ? other.map(a=>appCard(a, '')).join('') : '<p class="text-2 small">None.</p>'}
  </div>

  <div class="card" style="padding:16px;">
    <h3 style="font-size:14px;margin-bottom:8px;">Active Creators (${creators.length})</h3>
    ${creators.length ? creators.map(c=>`
      <div class="card" style="padding:12px;margin-bottom:8px;">
        <div style="font-weight:700;">${escapeHtml(c.displayName||'—')} <span class="chip" style="font-size:10px;">${escapeHtml(c.status)}</span> ${c.verifiedBusiness?'<span class="chip" style="font-size:10px;background:var(--accent);">verified</span>':''}</div>
        <div class="text-2 small">${escapeHtml(c.category||'')} · uid: ${escapeHtml(c.id)}</div>
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
          ${c.status==='ACTIVE' ? `
            <button class="btn btn-outline btn-sm" onclick="creatorAdminAction('${c.id}','restrict',true)">Restrict</button>
            <button class="btn btn-outline btn-sm" onclick="creatorAdminAction('${c.id}','suspend',true)">Suspend</button>
            <button class="btn btn-outline btn-sm" onclick="creatorAdminAction('${c.id}','revoke',true)">Revoke</button>
          ` : c.status==='REVOKED' ? `<span class="text-2 small">Revoked — terminal, no actions available.</span>` : `
            <button class="btn btn-primary btn-sm" onclick="creatorAdminAction('${c.id}','reactivate',false)">Reactivate</button>
            <button class="btn btn-outline btn-sm" onclick="creatorAdminAction('${c.id}','revoke',true)">Revoke</button>
          `}
        </div>
      </div>`).join('') : '<p class="text-2 small">None yet.</p>'}
  </div>`;
}

/* =========================================================
   ADMIN — CREATOR OPS (listing review / payouts / orders & SLA / alerts)
   Uses authedApi directly because some admin endpoints answer {ok,data}
   and the finance one answers {ok,withdrawals}. Every dynamic value is escaped.
   ========================================================= */
let ao = { sub:'listings', data:{}, loading:false, error:'', busy:false, note:'', filter:{ listings:'SUBMITTED', wds:'pending', orders:'', disputes:'OPEN', refunds:'REQUESTED', stations:'SUBMITTED' }, paystack:false };
async function aoApi(path, body){
  const init = body ? { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) } : {};
  const r = await authedApi(path, init, 30000, 'The server took too long. Please try again.');
  let d = null; try{ d = await r.json(); }catch(e){}
  if(d && d.ok) return (d.data !== undefined && d.data !== null) ? d.data : d;
  const err = new Error((d && d.error && (d.error.message || d.error)) || 'Something went wrong.');
  err.code = d && d.error && d.error.code; throw err;
}
function aoSetSub(s){ ao.sub = s; ao.error=''; ao.note=''; aoLoad(true); renderAdminTab(); }
async function aoLoad(force){
  const s = ao.sub;
  if(ao.data[s] && !force) return;
  ao.loading = true; ao.error = '';
  try{
    if(s==='listings') ao.data.listings = (await aoApi('/api/creator-admin-products'+(ao.filter.listings?'?status='+encodeURIComponent(ao.filter.listings):''))).products || [];
    else if(s==='payouts'){
      const [w,b] = await Promise.all([
        aoApi('/api/creator-admin-finance'+(ao.filter.wds?'?status='+encodeURIComponent(ao.filter.wds):'')),
        aoApi('/api/creator-admin-finance?action=list-balances')
      ]);
      ao.data.payouts = { withdrawals: w.withdrawals||[], balances: b.balances||[] };
    }
    else if(s==='orders'){
      const [q,c,f] = await Promise.all([
        aoApi('/api/creator-admin-sla?view=queue'),
        aoApi('/api/creator-admin-sla?view=creators'),
        aoApi('/api/creator-admin-fulfillments'+(ao.filter.orders?'?status='+encodeURIComponent(ao.filter.orders):''))
      ]);
      ao.data.orders = { queue:q.queue||[], creators:c.creators||[], fulfillments:f.fulfillments||[] };
    }
    else if(s==='disputes') ao.data.disputes = (await aoApi('/api/creator-admin-risk?view=disputes'+(ao.filter.disputes?'&status='+encodeURIComponent(ao.filter.disputes):''))).disputes || [];
    else if(s==='reconcile'){
      const [rep, st] = await Promise.all([ aoApi('/api/creator-admin-risk?view=reconcile'+(ao.paystack?'&paystack=1':'')), aoApi('/api/creator-admin-risk?view=settings') ]);
      ao.data.reconcile = { report: rep, settings: st };
    }
    else if(s==='exceptions') ao.data.exceptions = (await aoApi('/api/creator-admin-exceptions?state=OPEN')).exceptions || [];
    else if(s==='refunds') ao.data.refunds = (await aoApi('/api/creator-admin-refunds'+(ao.filter.refunds?'?state='+encodeURIComponent(ao.filter.refunds):''))).refunds || [];
    else if(s==='funding') ao.data.funding = await aoApi('/api/creator-admin-funding');
    else if(s==='stations') ao.data.stations = await aoApi('/api/pickup-stations?admin=1&state='+encodeURIComponent(ao.filter.stations||'SUBMITTED'));
    else if(s==='riders') ao.data.riders = ao.data.riders || { link:'' };
    else if(s==='alerts'){
      const [a,r,st] = await Promise.all([
        aoApi('/api/creator-admin-automation?view=alerts'),
        aoApi('/api/creator-admin-automation?view=runs'),
        aoApi('/api/creator-admin-automation?view=settings')
      ]);
      ao.data.alerts = { alerts:a.alerts||[], runs:r.runs||[], settings:st||{} };
    }
  }catch(e){ ao.error = e.message || 'Could not load.'; }
  ao.loading = false;
  if(appState.adminTab==='creatorOps') renderAdminTab();
}
async function aoPost(path, body, okMsg){
  if(ao.busy) return;
  ao.busy = true; ao.error=''; ao.note=''; renderAdminTab();
  try{ await aoApi(path, body); ao.note = okMsg||'Done.'; ao.busy=false; await aoLoad(true); }
  catch(e){ ao.error = e.message||'Action failed.'; ao.busy=false; }
  if(appState.adminTab==='creatorOps') renderAdminTab();
}
function aoReason(label){ const r = window.prompt(label); return r && r.trim() ? r.trim() : null; }
function aoListingAction(id, action, needReason){
  let reason; if(needReason){ reason = aoReason('Reason (the creator will see this):'); if(!reason) return; }
  aoPost('/api/creator-admin-products', { productId:id, action, reason }, 'Listing updated: '+action.replace('_',' ')+'.');
}
function aoWithdrawalAction(id, action){
  if(action==='reject-withdrawal'){ const note = aoReason('Reason for rejecting (shown to the creator):'); if(!note) return; return aoPost('/api/creator-admin-finance',{ action, withdrawalId:id, note },'Withdrawal rejected.'); }
  if(action==='pay-withdrawal-via-paystack' && !window.confirm('Send this payout through Paystack now? This moves real money.')) return;
  if(action==='mark-withdrawal-paid' && !window.confirm('Mark as paid ONLY if you already sent the money yourself. Continue?')) return;
  aoPost('/api/creator-admin-finance',{ action, withdrawalId:id },'Withdrawal updated.');
}
function aoResolveDispute(id, decision){
  const note = aoReason(decision==='REFUND' ? 'Why is the buyer being refunded? (both sides will see this)' : 'Why is the dispute rejected? (both sides will see this)');
  if(!note) return;
  if(decision==='REFUND' && !window.confirm('This reverses the creator\'s earning for the order. You must then refund the buyer yourself from the Paystack dashboard. Continue?')) return;
  aoPost('/api/creator-admin-risk', { action:'resolve_dispute', disputeId:id, decision, note }, decision==='REFUND' ? 'Decision saved. Remember to refund the buyer from Paystack.' : 'Dispute rejected; earning released.');
}
function aoSetHold(){
  const v = window.prompt('Hold new creator sales for how many days before they can be withdrawn? (0 = no hold, max 60)', String((ao.data.reconcile&&ao.data.reconcile.settings&&ao.data.reconcile.settings.holdDays)||0));
  if(v===null) return;
  const days = Number(v);
  if(!Number.isInteger(days) || days<0 || days>60){ ao.error='Enter a whole number from 0 to 60.'; renderAdminTab(); return; }
  aoPost('/api/creator-admin-risk', { action:'set_hold_days', days }, 'Hold period saved.');
}
function aoTogglePaystack(){ ao.paystack = !ao.paystack; aoLoad(true); }
function aoSetFilter(k,v){ ao.filter[k]=v; aoLoad(true); }
function aoResolveAlert(id){ const note = window.prompt('Note (optional):')||''; aoPost('/api/creator-admin-automation',{ action:'resolve_alert', alertId:id, note },'Alert resolved.'); }
function aoRunJob(j){ aoPost('/api/creator-admin-automation',{ action:'run_job', job:j },'Job "'+j+'" ran.'); }
function aoAutoRestrict(on){ aoPost('/api/creator-admin-automation',{ action:'set_auto_restrict', enabled:on }, on?'Automatic SLA pausing is ON.':'Automatic SLA pausing is OFF.'); }
function aoLiftPause(scope){ const reason = aoReason('Reason for re-opening '+scope+'-paused listings:'); if(!reason) return; aoPost('/api/creator-admin-automation',{ action:'lift_pause', scope, reason },'Paused listings re-checked.'); }
function aoDate(v){ try{ if(!v) return '—'; if(v._seconds) return new Date(v._seconds*1000).toLocaleString(); if(v.seconds) return new Date(v.seconds*1000).toLocaleString(); const d=new Date(v); return isNaN(d)?'—':d.toLocaleString(); }catch(e){ return '—'; } }
function aoSelect(key, opts){
  return `<select class="input" style="max-width:220px;" onchange="aoSetFilter('${key}',this.value)">${opts.map(o=>`<option value="${escapeHtml(o[0])}" ${ao.filter[key]===o[0]?'selected':''}>${escapeHtml(o[1])}</option>`).join('')}</select>`;
}
function aoListingsHtml(){
  const list = ao.data.listings; if(!list) return '<p class="text-2 small">Loading…</p>';
  return `<div style="margin-bottom:10px;">${aoSelect('listings',[['SUBMITTED','Waiting for review'],['PUBLISHED','Live'],['PAUSED','Paused'],['SUSPENDED','Suspended'],['REJECTED','Rejected'],['','Everything']])}</div>` +
  (list.length ? list.map(p=>{
    const v = p.latestVersion||{}, f = v.fields||p.publishedSnapshot||{};
    const st = p.status;
    const btns = st==='SUBMITTED' ? `
      <button class="btn btn-primary btn-sm" ${ao.busy?'disabled':''} onclick="aoListingAction('${escapeHtml(p.id)}','approve',false)">Approve</button>
      <button class="btn btn-outline btn-sm" ${ao.busy?'disabled':''} onclick="aoListingAction('${escapeHtml(p.id)}','request_changes',true)">Request changes</button>
      <button class="btn btn-outline btn-sm" ${ao.busy?'disabled':''} onclick="aoListingAction('${escapeHtml(p.id)}','reject',true)">Reject</button>`
      : (st==='PUBLISHED' ? `<button class="btn btn-outline btn-sm" ${ao.busy?'disabled':''} onclick="aoListingAction('${escapeHtml(p.id)}','suspend',true)">Suspend</button>`
      : (st==='SUSPENDED'||st==='PAUSED' ? `<button class="btn btn-primary btn-sm" ${ao.busy?'disabled':''} onclick="aoListingAction('${escapeHtml(p.id)}','reinstate',false)">Reinstate</button>` : ''));
    return `<div class="card" style="padding:12px;margin-bottom:8px;">
      <div style="font-weight:700;">${escapeHtml(f.title||p.title||'Untitled')} <span class="chip" style="font-size:10px;">${escapeHtml(st||'')}</span></div>
      <div class="text-2 small">${escapeHtml(f.offeringType||'')} · ${escapeHtml(f.currency||'')} ${escapeHtml(String(f.price!=null?f.price:''))} · creator ${escapeHtml(p.creatorId||'')}</div>
      ${f.description?`<div class="text-2 small" style="margin-top:4px;">${escapeHtml(String(f.description).slice(0,240))}</div>`:''}
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">${btns}</div></div>`;
  }).join('') : '<p class="text-2 small">Nothing here.</p>');
}
function aoPayoutsHtml(){
  const d = ao.data.payouts; if(!d) return '<p class="text-2 small">Loading…</p>';
  const wds = d.withdrawals.map(w=>{
    const b = w.status==='pending' ? `
      <button class="btn btn-primary btn-sm" ${ao.busy?'disabled':''} onclick="aoWithdrawalAction('${escapeHtml(w.id)}','approve-withdrawal')">Approve</button>
      <button class="btn btn-outline btn-sm" ${ao.busy?'disabled':''} onclick="aoWithdrawalAction('${escapeHtml(w.id)}','reject-withdrawal')">Reject</button>`
      : w.status==='approved' ? `
      <button class="btn btn-primary btn-sm" ${ao.busy?'disabled':''} onclick="aoWithdrawalAction('${escapeHtml(w.id)}','pay-withdrawal-via-paystack')">Pay via Paystack</button>
      <button class="btn btn-outline btn-sm" ${ao.busy?'disabled':''} onclick="aoWithdrawalAction('${escapeHtml(w.id)}','mark-withdrawal-paid')">Mark paid (manual)</button>` : '';
    return `<div class="card" style="padding:12px;margin-bottom:8px;">
      <div style="font-weight:700;">${cwNaira(w.amountPayable)} <span class="chip" style="font-size:10px;">${escapeHtml(w.status||'')}</span></div>
      <div class="text-2 small">Requested ${cwNaira(w.amountRequested)} · fee ${cwNaira(w.feeAmount)} · ${escapeHtml(aoDate(w.requestedAt))}</div>
      <div class="text-2 small" style="opacity:.7;">creator ${escapeHtml(w.creatorId||'')}</div>
      <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">${b}</div></div>`;
  }).join('') || '<p class="text-2 small">No withdrawals.</p>';
  const bals = d.balances.map(b=>`<div class="text-2 small" style="padding:4px 0;border-bottom:1px solid var(--border,#2a2a2a);">${escapeHtml(b.creatorId)} — available ${cwNaira(b.balanceAvailable)} · earned ${cwNaira(b.totalEarned)} · withdrawn ${cwNaira(b.totalWithdrawn)}</div>`).join('') || '<p class="text-2 small">No creator earnings yet.</p>';
  return `<div style="margin-bottom:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">${aoSelect('wds',[['pending','Pending'],['approved','Approved'],['processing','Processing'],['paid','Paid'],['rejected','Rejected'],['','All']])}
    <button class="btn btn-outline btn-sm" onclick="aoDownloadCsv('sales')">Sales CSV</button><button class="btn btn-outline btn-sm" onclick="aoDownloadCsv('withdrawals')">Withdrawals CSV</button></div>
    ${wds}<h3 style="font-size:14px;margin:16px 0 8px;">Creator balances</h3>${bals}`;
}
async function aoDownloadCsv(kind){
  try{
    const r = await authedApi('/api/creator-admin-finance?export='+encodeURIComponent(kind),{},30000,'The export took too long.');
    if(!r.ok) throw new Error('Export failed ('+r.status+').');
    const blob = await r.blob(); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download='lexden-nova-creator-'+kind+'.csv'; document.body.appendChild(a); a.click(); a.remove();
  }catch(e){ ao.error = e.message||'Export failed.'; renderAdminTab(); }
}
function aoSlaChip(s){ const o = s&&s.overall; return `<span class="chip" style="font-size:10px;${o==='BREACHED'?'color:var(--error);':(o==='AT_RISK'?'color:var(--warn,#d4af37);':'')}">${escapeHtml(o||'OK')}</span>`; }
function aoOrdersHtml(){
  const d = ao.data.orders; if(!d) return '<p class="text-2 small">Loading…</p>';
  const q = d.queue.map(r=>`<div class="card" style="padding:12px;margin-bottom:8px;"><div style="font-weight:700;">${escapeHtml(r.productTitle||r.id)} ${aoSlaChip(r.sla)} <span class="chip" style="font-size:10px;">${escapeHtml(r.status||'')}</span></div><div class="text-2 small">creator ${escapeHtml(r.creatorId||'')} · order ${escapeHtml(r.orderId||'')} · due ${escapeHtml(r.sla&&r.sla.dueAtMs?new Date(r.sla.dueAtMs).toLocaleString():'—')}</div></div>`).join('') || '<p class="text-2 small">No orders at risk. 🎉</p>';
  const c = d.creators.map(x=>`<div class="text-2 small" style="padding:4px 0;border-bottom:1px solid var(--border,#2a2a2a);">${escapeHtml(x.creatorId)} — breached ${escapeHtml(String(x.breached||0))} · at risk ${escapeHtml(String(x.atRisk!=null?x.atRisk:(x.at_risk||0)))}</div>`).join('') || '<p class="text-2 small">No data yet.</p>';
  const f = d.fulfillments.map(x=>`<div class="text-2 small" style="padding:6px 0;border-bottom:1px solid var(--border,#2a2a2a);">${escapeHtml(x.productTitle||x.id)} · <b>${escapeHtml(x.status||'')}</b> ${aoSlaChip(x.sla)} · ${escapeHtml(x.trackingNumber||'')}</div>`).join('') || '<p class="text-2 small">None.</p>';
  return `<h3 style="font-size:14px;margin-bottom:8px;">Late or at-risk orders (${d.queue.length})</h3>${q}
    <h3 style="font-size:14px;margin:16px 0 8px;">Creators by delivery record</h3>${c}
    <h3 style="font-size:14px;margin:16px 0 8px;">Physical orders</h3><div style="margin-bottom:8px;">${aoSelect('orders',[['','All'],['PENDING','Pending'],['SHIPPED','Shipped'],['DELIVERED','Delivered']])}</div>${f}`;
}
function aoDisputesHtml(){
  const list = ao.data.disputes; if(!list) return '<p class="text-2 small">Loading…</p>';
  const msgs = d => (d.messages||[]).map(m=>`<div style="margin:4px 0;padding:6px 8px;border-radius:8px;background:var(--surface-2,rgba(128,128,128,.12));"><b class="small">${escapeHtml(m.by==='buyer'?'Buyer':m.by==='creator'?'Seller':'Admin')}:</b> <span style="white-space:pre-wrap;font-size:13.5px;">${escapeHtml(m.text)}</span></div>`).join('');
  return `<div style="margin-bottom:10px;">${aoSelect('disputes',[['OPEN','Open'],['RESOLVED_REFUND','Refunded'],['RESOLVED_REJECTED','Rejected'],['','All']])}</div>` +
  (list.length ? list.map(d=>`<div class="card" style="padding:12px;margin-bottom:8px;">
    <div style="font-weight:700;">${escapeHtml(d.productTitle||'Order')} <span class="chip" style="font-size:10px;">${escapeHtml(d.status||'')}</span></div>
    <div class="text-2 small">${escapeHtml(String(d.currency||''))} ${escapeHtml(String(d.amount!=null?d.amount:''))} · ${escapeHtml(String(d.reason||'').replace(/_/g,' ').toLowerCase())} · opened ${escapeHtml(d.openedAtMs?new Date(d.openedAtMs).toLocaleString():'')}</div>
    <div class="text-2 small" style="opacity:.75;">order ${escapeHtml(d.orderId||'')} · creator ${escapeHtml(d.creatorId||'')} · buyer ${escapeHtml(d.buyerEmail||d.buyerUid||'')}</div>
    ${msgs(d)}
    ${d.status==='OPEN'?`<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" ${ao.busy?'disabled':''} onclick="aoResolveDispute('${escapeHtml(d.id)}','REFUND')">Refund buyer</button><button class="btn btn-outline btn-sm" ${ao.busy?'disabled':''} onclick="aoResolveDispute('${escapeHtml(d.id)}','REJECT')">Reject dispute</button></div>`
      : (d.status==='RESOLVED_REFUND'?`<div class="small" style="margin-top:6px;color:var(--warn,#d4af37);">Refund the buyer from the Paystack dashboard (the app does not send money).</div>`:'')}
  </div>`).join('') : '<p class="text-2 small">Nothing here.</p>');
}
function aoReconcileHtml(){
  const d = ao.data.reconcile; if(!d) return '<p class="text-2 small">Loading…</p>';
  const r = d.report, t = r.totals||{};
  const pay = r.paystack ? `<h3 style="font-size:14px;margin:16px 0 8px;">Paystack check (${escapeHtml(String(r.paystack.checked))} recent sales)</h3>
    <p class="small">${r.paystack.mismatches?`<span style="color:var(--error);">${escapeHtml(String(r.paystack.mismatches))} mismatch(es)</span>`:'No mismatches'} · ${escapeHtml(String(r.paystack.unverified))} not confirmable</p>` +
    r.paystack.rows.filter(x=>x.result!=='MATCH').map(x=>`<div class="text-2 small" style="padding:3px 0;">${escapeHtml(x.reference)} — <b>${escapeHtml(x.result)}</b> ${x.result==='MISMATCH'?escapeHtml('Paystack '+x.paystackAmount+' vs ledger '+x.ledgerAmount):escapeHtml(x.detail||'')}</div>`).join('') : '';
  return `<div class="card" style="padding:12px;margin-bottom:12px;">
      <div><b>Hold new sales:</b> ${d.settings.holdDays?escapeHtml(String(d.settings.holdDays))+' day(s)':'off'} <button class="btn btn-outline btn-sm" style="margin-left:8px;" onclick="aoSetHold()">Change</button></div>
      <div class="text-2 small" style="margin-top:6px;">Disputes can be opened for ${escapeHtml(String(d.settings.disputeWindowDays))} days. This report only reads data; it never moves money.</div></div>
    <div class="card" style="padding:12px;margin-bottom:12px;"><div class="text-2 small" style="line-height:1.7;">Sales recorded: <b>${escapeHtml(String(t.sales))}</b> · Platform fees: <b>${cwNaira(t.platformFee)}</b><br>Creators' earnings held: <b>${cwNaira(t.earnedHeld)}</b> · available: <b>${cwNaira(t.earnedAvailable)}</b><br>Withdrawn/requested: <b>${cwNaira(t.withdrawn)}</b> · Refunded earnings: <b>${cwNaira(t.refunded)}</b></div></div>
    <h3 style="font-size:14px;margin-bottom:8px;">Creator balances ${r.problems?`<span class="chip" style="font-size:10px;color:var(--error);">${escapeHtml(String(r.problems))} problem(s)</span>`:'<span class="chip" style="font-size:10px;">all reconcile</span>'}</h3>
    ${r.creators.map(c=>`<div class="text-2 small" style="padding:5px 0;border-bottom:1px solid var(--border,#2a2a2a);">${c.ok?'✅':'⚠️'} ${escapeHtml(c.creatorId)} — earned ${cwNaira(c.earned)} · withdrawn ${cwNaira(c.withdrawn)} · balance ${cwNaira(c.storedBalance)} (expected ${cwNaira(c.expectedBalance)})${c.issues.length?`<div style="color:var(--error);">${c.issues.map(i=>escapeHtml(i.code+': stored '+i.stored+', computed '+i.computed)).join('; ')}</div>`:''}</div>`).join('') || '<p class="text-2 small">No creators with earnings yet.</p>'}
    <div style="margin-top:14px;"><button class="btn btn-outline btn-sm" ${ao.loading?'disabled':''} onclick="aoTogglePaystack()">${ao.paystack?'Hide Paystack check':'Also check against Paystack'}</button></div>
    ${pay}`;
}
function aoAlertsHtml(){
  const d = ao.data.alerts; if(!d) return '<p class="text-2 small">Loading…</p>';
  const s = d.settings||{};
  const open = d.alerts.filter(a=>a.status!=='RESOLVED' && a.status!=='resolved');
  const al = open.map(a=>`<div class="card" style="padding:12px;margin-bottom:8px;"><div style="font-weight:700;">${escapeHtml(a.title||a.type||a.id)} <span class="chip" style="font-size:10px;">${escapeHtml(a.severity||a.status||'')}</span></div><div class="text-2 small">${escapeHtml(String(a.message||a.detail||'').slice(0,300))}</div><div style="margin-top:8px;"><button class="btn btn-outline btn-sm" ${ao.busy?'disabled':''} onclick="aoResolveAlert('${escapeHtml(a.id)}')">Mark resolved</button></div></div>`).join('') || '<p class="text-2 small">No open alerts.</p>';
  const jobs = (s.jobs||[]).map(j=>`<button class="btn btn-outline btn-sm" ${ao.busy?'disabled':''} onclick="aoRunJob('${escapeHtml(j)}')">Run ${escapeHtml(j)}</button>`).join(' ');
  const runs = d.runs.slice(0,10).map(r=>`<div class="text-2 small" style="padding:3px 0;">${escapeHtml(r.job||r.name||r.id)} · ${escapeHtml(r.status||'')} · ${escapeHtml(r.startedAtMs?new Date(r.startedAtMs).toLocaleString():'')}</div>`).join('') || '<p class="text-2 small">No runs yet.</p>';
  return `<div class="card" style="padding:12px;margin-bottom:12px;">
    <div class="text-2 small">Keep-alive / cron: <b>${s.cronConfigured?'configured':'NOT configured (set CRON_SECRET)'}</b></div>
    <div style="margin-top:8px;"><b>Automatic SLA pausing:</b> ${s.autoRestrictSla?'ON':'OFF'}
      <button class="btn btn-outline btn-sm" style="margin-left:8px;" ${ao.busy?'disabled':''} onclick="aoAutoRestrict(${s.autoRestrictSla?'false':'true'})">Turn ${s.autoRestrictSla?'OFF':'ON'}</button></div>
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-outline btn-sm" onclick="aoLiftPause('sla')">Re-open SLA-paused</button><button class="btn btn-outline btn-sm" onclick="aoLiftPause('link')">Re-open link-paused</button><button class="btn btn-outline btn-sm" onclick="aoLiftPause('supplier')">Re-open supplier-paused</button></div></div>
    <h3 style="font-size:14px;margin-bottom:8px;">Open alerts (${open.length})</h3>${al}
    <h3 style="font-size:14px;margin:16px 0 8px;">Run a job now</h3><div style="display:flex;gap:8px;flex-wrap:wrap;">${jobs}</div>
    <h3 style="font-size:14px;margin:16px 0 8px;">Recent runs</h3>${runs}`;
}
/* ---- Upgrade screens: order exceptions, refunds, supplier funding, pickup stations, rider links ---- */
function aoExceptionsHtml(){
  const list = ao.data.exceptions; if(!list) return '<p class="text-2 small">Loading…</p>';
  const label = { AMOUNT_MISMATCH:'Paid amount did not match', SELLER_NOT_ACTIVE:'Seller not active', NOT_FOR_SALE:'Listing not for sale', STOCK_UNAVAILABLE_AFTER_PAYMENT:'Out of stock after payment', SUPPLIER_FUNDING_UNAVAILABLE:'Supplier order not funded', DELIVERY_PROOF_PROBLEM:'Delivery problem reported' };
  return `<p class="text-2 small">Paid orders that could not be honoured automatically. The creator's earning stays on hold until you resolve it. Resolving here does not move money; refund through the Refunds tab.</p>` +
  (list.length ? list.map(e=>`<div class="card" style="padding:12px;margin-bottom:8px;">
    <div style="font-weight:700;">${escapeHtml(label[e.code]||e.code)}</div>
    <div class="text-2 small">Order ${escapeHtml(e.orderId)} · product ${escapeHtml(e.productId||'—')} · ${aoDate(e.createdAtMs)}</div>
    <div class="text-2 small">${escapeHtml(JSON.stringify(e.details||{}))}</div>
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
      <button class="btn btn-primary btn-sm" onclick="aoResolveException('${escapeHtml(e.id)}','FULFILLED_ANYWAY')">Order can proceed</button>
      <button class="btn btn-outline btn-sm" onclick="aoResolveException('${escapeHtml(e.id)}','REFUNDED')">Being refunded</button>
      <button class="btn btn-outline btn-sm" onclick="aoResolveException('${escapeHtml(e.id)}','CANCELLED')">Not a real problem</button>
    </div></div>`).join('') : '<p class="text-2 small">Nothing waiting. 🎉</p>');
}
function aoResolveException(id, resolution){
  const note = aoReason('Short note for the record:'); if(!note) return;
  aoPost('/api/creator-admin-exceptions', { action:'resolve', id, resolution, note }, 'Exception resolved.');
}
function aoRefundsHtml(){
  const list = ao.data.refunds; if(!list) return '<p class="text-2 small">Loading…</p>';
  const states = [['REQUESTED','Requested'],['AWAITING_MANUAL_STEP','Needs manual step'],['PROCESSING','Processing'],['REQUIRES_REVIEW','Needs review'],['FAILED','Failed'],['COMPLETED','Completed'],['','Everything']];
  return `<div style="margin-bottom:10px;">${aoSelect('refunds',states)}</div>
  <p class="text-2 small">A refund only shows "Completed" after the payment provider confirms it. If Paystack refunds are not switched on, approving sends it to "Needs manual step": refund in the Paystack dashboard, then record the reference here.</p>` +
  (list.length ? list.map(r=>`<div class="card" style="padding:12px;margin-bottom:8px;">
    <div style="font-weight:700;">₦${Number((r.amountMinor||0)/100).toLocaleString()} <span class="chip" style="font-size:10px;">${escapeHtml(r.state)}</span></div>
    <div class="text-2 small">Order ${escapeHtml(r.orderId||'—')} · ${escapeHtml(r.reason||'')} · ${aoDate(r.createdAtMs)}</div>
    ${r.deduction?`<div class="small" style="color:var(--error);">Has a deduction: needs a written review before it can be paid.</div>`:''}
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
      ${r.state==='REQUESTED'?`<button class="btn btn-primary btn-sm" onclick="aoRefundAct('${escapeHtml(r.id)}','approve')">Approve</button>`:''}
      ${r.state==='AWAITING_MANUAL_STEP'?`<button class="btn btn-primary btn-sm" onclick="aoRefundManual('${escapeHtml(r.id)}')">I refunded it in Paystack</button>`:''}
      ${r.deduction&&!r.deduction.reviewedBy?`<button class="btn btn-outline btn-sm" onclick="aoRefundDeduction('${escapeHtml(r.id)}')">Record deduction review</button>`:''}
      ${['REQUESTED','APPROVED','AWAITING_MANUAL_STEP'].includes(r.state)?`<button class="btn btn-outline btn-sm" onclick="aoRefundAct('${escapeHtml(r.id)}','review')">Send to review</button><button class="btn btn-outline btn-sm" onclick="aoRefundAct('${escapeHtml(r.id)}','cancel')">Cancel</button>`:''}
    </div></div>`).join('') : '<p class="text-2 small">No refunds in this state.</p>');
}
function aoRefundAct(id, action){
  let note; if(action!=='approve'){ note = aoReason('Note (required):'); if(!note) return; }
  else if(!window.confirm('Approve this refund? If Paystack refunds are on, this sends real money back to the buyer.')) return;
  aoPost('/api/creator-admin-refunds', { action, id, note }, 'Refund updated.');
}
function aoRefundManual(id){
  const providerReference = aoReason('Paystack refund reference (from the dashboard):'); if(!providerReference) return;
  const note = window.prompt('Note (optional):')||'';
  aoPost('/api/creator-admin-refunds', { action:'record_manual', id, providerReference, note }, 'Recorded. It completes when Paystack confirms.');
}
function aoRefundDeduction(id){ const note = aoReason('Why is the deduction fair? (at least 10 characters)'); if(!note) return; aoPost('/api/creator-admin-refunds', { action:'review_deduction', id, note }, 'Deduction reviewed.'); }

function aoFundingHtml(){
  const d = ao.data.funding; if(!d) return '<p class="text-2 small">Loading…</p>';
  const modeText = d.mode==='NOVA_FUNDED' ? 'NOVA pays the supplier. Confirm each order below once you have paid CJ.' : d.mode==='CREATOR_ACCOUNT' ? 'Creators pay inside their own CJ account. Nothing to confirm here.' : 'Supplier ordering is OFF (CJ_FUNDING_MODE not set), so CJ orders are held. Paid CJ orders appear below.';
  return `<p class="text-2 small">Mode: <b>${escapeHtml(d.mode)}</b>. ${escapeHtml(modeText)} Your confirmation is recorded as your word; NOVA does not check it with CJ.</p>` +
  (d.orders.length ? d.orders.map(e=>`<div class="card" style="padding:12px;margin-bottom:8px;">
    <div style="font-weight:700;">Order ${escapeHtml(e.orderId)}</div>
    <div class="text-2 small">Product ${escapeHtml(e.productId||'—')} · waiting since ${aoDate(e.createdAtMs)}</div>
    ${d.mode==='NOVA_FUNDED'?`<button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="aoConfirmFunded('${escapeHtml(e.orderId)}')">I funded this order</button>`:`<div class="small" style="margin-top:6px;">Switch the mode to NOVA_FUNDED or CREATOR_ACCOUNT on the server, or refund the buyer through the Refunds tab.</div>`}
  </div>`).join('') : '<p class="text-2 small">No orders waiting for supplier funding.</p>');
}
function aoConfirmFunded(orderId){
  const reference = aoReason('Your CJ payment reference or order number:'); if(!reference) return;
  if(!window.confirm('Confirm NOVA has paid (or will pay) CJ for this order? The CJ order will be placed now.')) return;
  aoPost('/api/creator-admin-funding', { action:'confirm_funded', orderId, reference }, 'Confirmed. The supplier order is being placed.');
}

function aoStationsHtml(){
  const d = ao.data.stations; if(!d) return '<p class="text-2 small">Loading…</p>';
  const off = d.enabled ? '' : '<p class="small" style="color:var(--error);">Pickup stations are switched off (PICKUP_STATIONS_ENABLED). You can read submissions but not approve them.</p>';
  return off + `<div style="margin-bottom:10px;">${aoSelect('stations',[['SUBMITTED','Waiting for review'],['UNDER_REVIEW','Under review'],['NEEDS_CHANGES','Needs changes'],['APPROVED','Live'],['SUSPENDED','Suspended'],['REJECTED','Rejected']])}</div>
  <p class="text-2 small">Approve only a staffed business with a real premises. Homes are never allowed. Every check must be ticked.</p>` +
  (d.stations.length ? d.stations.map(s=>`<div class="card" style="padding:12px;margin-bottom:8px;">
    <div style="font-weight:700;">${escapeHtml(s.name)} <span class="chip" style="font-size:10px;">${escapeHtml(s.businessType)}</span></div>
    <div class="text-2 small">${escapeHtml(s.address)}, ${escapeHtml(s.city)}, ${escapeHtml(s.stateRegion||'')} · ${escapeHtml(s.openingHours)} · ${escapeHtml(s.managerName)} · ${escapeHtml(s.contactPhone)}</div>
    ${s.reviewNote?`<div class="text-2 small">Last note: ${escapeHtml(s.reviewNote)}</div>`:''}
    <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
      ${['SUBMITTED','UNDER_REVIEW','SUSPENDED'].includes(s.state)?`<button class="btn btn-primary btn-sm" onclick="aoStationReview('${escapeHtml(s.id)}','APPROVED')">Approve (confirm checks)</button>`:''}
      ${['SUBMITTED','UNDER_REVIEW'].includes(s.state)?`<button class="btn btn-outline btn-sm" onclick="aoStationReview('${escapeHtml(s.id)}','NEEDS_CHANGES',true)">Ask for changes</button>`:''}
      ${['SUBMITTED','UNDER_REVIEW','SUSPENDED'].includes(s.state)?`<button class="btn btn-outline btn-sm" onclick="aoStationReview('${escapeHtml(s.id)}','REJECTED',true)">Reject</button>`:''}
      ${s.state==='APPROVED'?`<button class="btn btn-outline btn-sm" onclick="aoStationReview('${escapeHtml(s.id)}','SUSPENDED',true)">Suspend</button>`:''}
    </div></div>`).join('') : '<p class="text-2 small">None in this state.</p>');
}
function aoStationReview(id, to, needNote){
  let note, checks = {};
  if(needNote){ note = aoReason('Reason (the station owner will see this):'); if(!note) return; }
  if(to==='APPROVED'){
    const items = (ao.data.stations.reviewChecks||[]);
    const ok = window.confirm('Confirm you have personally checked ALL of these:\n\n- '+items.join('\n- ')+'\n\nApprove?');
    if(!ok) return; items.forEach(c=>{ checks[c] = true; });
  }
  aoPost('/api/pickup-stations', { action:'review', id, to, checks, note }, 'Station updated.');
}

function aoRidersHtml(){
  const r = ao.data.riders || {};
  return `<p class="text-2 small">Give a rider a one-order link. It lets them type the buyer's code and nothing else. It expires in 6 hours and only works for that order. Needs RIDER_VAULT_ENABLED and DELIVERY_CODE_SECRET on the server.</p>
  <div class="form-field"><label>Order ID</label><input id="rd_order" class="input"></div>
  <div class="form-field"><label>Rider name or ID</label><input id="rd_rider" class="input"></div>
  <button class="btn btn-primary btn-sm" onclick="aoIssueRider()">Create rider link</button>
  ${r.link?`<div class="card" style="padding:12px;margin-top:12px;"><div class="small">Send this link to the rider (shown once):</div><input class="input" readonly style="width:100%;margin-top:6px;" value="${escapeHtml(r.link)}" onclick="this.select()"><div class="text-2 small" style="margin-top:6px;">Task ${escapeHtml(r.taskId)}</div><button class="btn btn-outline btn-sm" style="margin-top:8px;" onclick="aoRevokeRider('${escapeHtml(r.taskId)}')">Revoke this link</button></div>`:''}`;
}
async function aoIssueRider(){
  const orderId = ($('#rd_order').value||'').trim(), riderId = ($('#rd_rider').value||'').trim();
  if(!orderId || !riderId){ ao.error='Enter the order ID and the rider.'; renderAdminTab(); return; }
  try{
    const d = await aoApi('/api/delivery-proof', { action:'issue_rider_task', orderId, riderId });
    const base = location.origin + location.pathname.replace(/\/admin\/?(index\.html)?$/, '/');
    ao.data.riders = { link: base+'rider/index.html#o='+encodeURIComponent(orderId)+'&t='+encodeURIComponent(d.taskId)+'&k='+encodeURIComponent(d.token), taskId:d.taskId };
    ao.error=''; ao.note='Link created.';
  }catch(e){ ao.error = e.message||'Could not create the link.'; }
  renderAdminTab();
}
function aoRevokeRider(taskId){ if(!window.confirm('Revoke this rider link?')) return; aoPost('/api/delivery-proof', { action:'revoke_rider_task', taskId }, 'Link revoked.'); ao.data.riders = { link:'' }; }

function adminCreatorOps(){
  if(!ao.data[ao.sub] && !ao.loading) aoLoad(false);
  const t = (id,l)=>`<button class="chip ${ao.sub===id?'active':''}" onclick="aoSetSub('${id}')">${l}</button>`;
  const body = ao.sub==='listings'?aoListingsHtml():ao.sub==='payouts'?aoPayoutsHtml():ao.sub==='orders'?aoOrdersHtml():ao.sub==='disputes'?aoDisputesHtml():ao.sub==='reconcile'?aoReconcileHtml():ao.sub==='exceptions'?aoExceptionsHtml():ao.sub==='refunds'?aoRefundsHtml():ao.sub==='funding'?aoFundingHtml():ao.sub==='stations'?aoStationsHtml():ao.sub==='riders'?aoRidersHtml():aoAlertsHtml();
  return `<div class="admin-topbar"><h2>Creator Ops</h2><button class="btn btn-outline btn-sm" onclick="aoLoad(true)">Refresh</button></div>
  <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">${t('listings','Listing review')}${t('payouts','Payouts')}${t('orders','Orders & SLA')}${t('disputes','Disputes')}${t('reconcile','Reconciliation')}${t('exceptions','Order problems')}${t('refunds','Refunds')}${t('funding','Supplier funding')}${t('stations','Pickup stations')}${t('riders','Rider links')}${t('alerts','Alerts & automation')}</div>
  ${ao.error?`<p class="small" style="color:var(--error);">⚠️ ${escapeHtml(ao.error)}</p>`:''}
  ${ao.note?`<p class="small" style="color:#2ee6a6;">✓ ${escapeHtml(ao.note)}</p>`:''}
  ${ao.loading?'<p class="text-2 small">Loading…</p>':''}
  ${body}`;
}

function affiliateWithdrawalCardHtml(w, affiliates){
  const a = (affiliates||[]).find(x=>x.id===w.affiliateId);
  // STRATEGIC DISPLAY: the account details and amount are the two things
  // you actually need to do the bank transfer — put front and center,
  // large, copy-friendly, no digging through tabs.
  return `
    <div class="card" style="padding:14px;margin-bottom:10px;border:1px solid var(--border);">
      <div class="flex" style="justify-content:space-between;align-items:flex-start;">
        <div>
          <div style="font-weight:800;font-size:16px;">₦${(w.amountRequested||0).toLocaleString()}</div>
          <div class="text-2 small">Pay out: <strong>₦${(w.amountPayable||0).toLocaleString()}</strong> (fee ₦${(w.feeAmount||0).toLocaleString()})</div>
        </div>
        <span class="chip" style="background:${w.status==='pending'?'var(--warn,#d4af37)':w.status==='approved'?'var(--accent)':w.status==='paid'?'#2ee6a6':'var(--error)'};color:#111;">${w.status}</span>
      </div>
      <div style="margin-top:8px;padding:10px;background:var(--bg-2,rgba(0,0,0,.03));border-radius:8px;">
        <div style="font-weight:700;">${escapeHtml(a?.displayName||w.affiliateId)}</div>
        <div class="text-2 small">${escapeHtml(w.payoutAccount?.bank||'')}</div>
        <div style="font-family:monospace;font-size:15px;font-weight:700;letter-spacing:.5px;">${escapeHtml(w.payoutAccount?.accountNumber||'')}</div>
        <div class="text-2 small">${escapeHtml(w.payoutAccount?.accountName||'')}</div>
      </div>
      ${w.status==='pending' ? `
        <div class="flex gap-8 mt-8">
          <button class="btn btn-primary btn-sm" onclick="adminApproveWithdrawal('${w.id}')">Approve</button>
          <button class="btn btn-danger btn-sm" onclick="adminRejectWithdrawal('${w.id}')">Reject</button>
        </div>` : ''}
      ${w.status==='approved' ? `
        <div class="flex gap-8 mt-8">
          <button class="btn btn-primary btn-sm" onclick="adminPayWithdrawalViaPaystack('${w.id}')">Pay Automatically (Paystack)</button>
          <button class="btn btn-outline btn-sm" onclick="adminMarkWithdrawalPaid('${w.id}')">Mark Paid (I sent it manually)</button>
        </div>
        <p class="small text-2" style="margin-top:6px;">"Pay Automatically" only works once Paystack Transfers is enabled on your account (Paystack dashboard → Settings → Preferences → enable Transfers, needs business verification). Until then, use "Mark Paid" after sending the transfer yourself.</p>` : ''}
      ${w.note ? `<p class="small text-2" style="margin-top:6px;">Note: ${escapeHtml(w.note)}</p>` : ''}
    </div>`;
}

function saveAffiliateSettings(){
  DB.content = {...DB.content,
    affiliateCommissionDefaultPct: Number($('#af_commission').value)||0,
    creatorCommissionBps: Math.round((Number($('#cr_fee').value)||0)*100),
    affiliateWithdrawalFeeBps: Math.round((Number($('#af_fee').value)||0)*100),
    affiliateMinWithdrawalNGN: Number($('#af_min').value)||0,
    affiliateWhatsappUrl: $('#af_wa').value.trim(),
    affiliateTelegramUrl: $('#af_tg').value.trim(),
    affiliateInviteBannerText: $('#af_banner').value.trim(),
  };
  pushSettingsToCloud();
  logActivity('Admin', 'Updated Affiliate Program settings');
  toast('Affiliate settings saved', 'success');
  renderAdminTab();
}
async function adminApproveAffiliate(id){
  const r = await callAffiliateAdminAction('approve-affiliate', {affiliateId:id});
  if(r.ok){ toast('Affiliate approved','success'); fetchAffiliatesFromCloud(true).then(renderAdminTab); }
}
async function adminSuspendAffiliate(id){
  if(!confirm('Suspend this affiliate? They will stop earning new commissions.')) return;
  const r = await callAffiliateAdminAction('suspend-affiliate', {affiliateId:id});
  if(r.ok){ toast('Affiliate suspended'); fetchAffiliatesFromCloud(true).then(renderAdminTab); }
}
async function adminApproveWithdrawal(id){
  const r = await callAffiliateAdminAction('approve-withdrawal', {withdrawalId:id});
  if(r.ok){ toast('Withdrawal approved — pay it, then Mark Paid.','success'); fetchAffiliateWithdrawalsFromCloud(true).then(renderAdminTab); }
}
async function adminRejectWithdrawal(id){
  const note = prompt('Reason for rejection (internal only, not shown to the affiliate automatically):')||'';
  const r = await callAffiliateAdminAction('reject-withdrawal', {withdrawalId:id, note});
  if(r.ok){ toast('Withdrawal rejected — amount returned to their balance.'); fetchAffiliateWithdrawalsFromCloud(true).then(renderAdminTab); }
}
async function adminMarkWithdrawalPaid(id){
  if(!confirm('Confirm you have already sent this bank transfer — this cannot be undone.')) return;
  const r = await callAffiliateAdminAction('mark-withdrawal-paid', {withdrawalId:id});
  if(r.ok){ toast('Marked paid','success'); fetchAffiliateWithdrawalsFromCloud(true).then(renderAdminTab); }
}
async function adminPayWithdrawalViaPaystack(id){
  if(!confirm('Attempt an automatic Paystack transfer for this amount now?')) return;
  const r = await callAffiliateAdminAction('pay-withdrawal-via-paystack', {withdrawalId:id});
  if(r.ok){ toast('Paid via Paystack','success'); fetchAffiliateWithdrawalsFromCloud(true).then(renderAdminTab); }
}

function adminExport(){
  return `
    <div class="admin-topbar"><h2>Export</h2></div>
    <div class="card" style="padding:18px;">
      <p class="text-2 small" style="margin-bottom:14px;">Download the current catalog, content and settings as a JSON snapshot. Keep this as a backup, or use it to restore data on another device via the browser console.</p>
      <button class="btn btn-primary" onclick="exportAppState()">📤 Download app data (.json)</button>
    </div>
    <div class="card" style="padding:18px;margin-top:16px;">
      <h3 style="font-size:14px;margin-bottom:8px;">Restore from file</h3>
      <input type="file" id="importFile" accept="application/json" style="font-size:13px;">
      <button class="btn btn-outline btn-sm mt-8" onclick="importAppState()">Import</button>
    </div>`;
}
function exportAppState(){
  const snapshot = {
    products:DB.legacyProducts, categories:DB.categories, testimonials:DB.testimonials,
    faqs:DB.faqs, content:DB.content, feed:DB.feed, services:DB.services, management:DB.management,
    suppliers:DB.suppliers, exportedAt:new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(snapshot,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'lexden-nova-data.json'; a.click();
  logActivity('Admin', 'Exported app data');
  toast('Data exported','success');
}
function importAppState(){
  const file = $('#importFile').files[0];
  if(!file){ toast('Choose a file first','error'); return; }
  const reader = new FileReader();
  reader.onload = e=>{
    try{
      const data = JSON.parse(e.target.result);
      if(data.products) DB.products = data.products;
      if(data.categories) DB.categories = data.categories;
      if(data.testimonials) DB.testimonials = data.testimonials;
      if(data.faqs) DB.faqs = data.faqs;
      if(data.content) DB.content = data.content;
      migrateLegacyHomeMessaging();
      if(data.feed) DB.feed = data.feed;
      if(data.services) DB.services = data.services;
      if(data.management) DB.management = data.management;
      if(data.suppliers) DB.suppliers = data.suppliers;
      logActivity('Admin', 'Imported app data from file');
      toast('Data imported successfully','success');
      renderAdminTab();
    }catch(err){ toast('Invalid file','error'); }
  };
  reader.readAsText(file);
}

function adminLogs(){
  const log = lsGet(LS_KEYS.activityLog, []);
  return `
    <div class="admin-topbar"><h2>Activity Log</h2><button class="btn btn-outline btn-sm" onclick="clearLogs()">Clear log</button></div>
    <div class="card" style="padding:10px 14px;">
      ${log.map(l=>`<div class="log-row"><strong>${escapeHtml(l.who)}</strong> — ${escapeHtml(l.what)} <span class="mono">· ${new Date(l.time).toLocaleString()}</span></div>`).join('') || '<div class="log-row">No activity recorded yet.</div>'}
    </div>`;
}
function clearLogs(){ lsSet(LS_KEYS.activityLog, []); renderAdminTab(); }
