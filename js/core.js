'use strict';

/* ---------------- HELPERS ---------------- */
function $(sel, root){ return (root||document).querySelector(sel); }
function $all(sel, root){ return Array.from((root||document).querySelectorAll(sel)); }
function escapeHtml(str){ return String(str||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
// Turns bare URLs in already-escaped text into clickable links. Runs
// AFTER escapeHtml, so it matches against entity-encoded text (e.g. a
// query string "&" is by then "&amp;") — that's fine, since the browser
// decodes entities inside the href attribute the same way it does in text.
function linkifyText(escapedText){
  const urlRe = /((https?:\/\/|www\.)[^\s<]+[^\s<.,;:!?'"”’)\]])/gi;
  return escapedText.replace(urlRe, (m)=>{
    const href = /^https?:\/\//i.test(m) ? m : 'https://'+m;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="color:var(--accent);word-break:break-all;">${m}</a>`;
  });
}
// Renders admin-pasted feed body text so it actually reads the way it was
// written: blank lines become real paragraph breaks, single line breaks
// are preserved, and any bare URL becomes a tappable link. Without this,
// a plain <p>${escapeHtml(text)}</p> collapses every blank line pasted
// from elsewhere into one run-on blob, since HTML ignores whitespace by
// default — that's the "feed text not well formatted" bug.
function formatFeedText(text){
  const raw = String(text||'').trim();
  if(!raw) return '';
  return raw.split(/\n\s*\n/).map(para=>{
    const esc = escapeHtml(para.trim()).replace(/\n/g,'<br>');
    return `<p style="margin:0 0 14px;">${linkifyText(esc)}</p>`;
  }).join('');
}
function currentCurrency(){ return lsGet(LS_KEYS.currency, DB.content.displayCurrency || 'NGN'); }
function setCurrency(code){ lsSet(LS_KEYS.currency, code); render(); }
// Small shared helpers so every place that needs "the shopper's current
// currency's rate/symbol" (product prices, and the custom price-range
// inputs) reads it the exact same way instead of re-deriving it locally.
function currentRate(){ const c = DB.content; return (c.exchangeRates && c.exchangeRates[currentCurrency()]) || 1; }
function currentCurrencySymbol(){ const c = DB.content; return (c.currencySymbols && c.currencySymbols[currentCurrency()]) || currentCurrency()+' '; }
function round2(n){ return Math.round(n*100)/100; }
function fmtPrice(usdAmount){
  const c = DB.content;
  const code = currentCurrency();
  const rate = (c.exchangeRates && c.exchangeRates[code]) || 1;
  const symbol = (c.currencySymbols && c.currencySymbols[code]) || code+' ';
  const converted = Number(usdAmount) * rate;
  // Whole-number currencies (e.g. Naira) read oddly with decimals for small demo prices,
  // but we keep 2dp for anything under 100 units so cheap items don't round to 0/1.
  const decimals = converted >= 100 ? 0 : 2;
  return symbol + converted.toLocaleString(undefined,{minimumFractionDigits:decimals,maximumFractionDigits:decimals});
}
// A product with no price, or a price of 0, is treated as Free everywhere —
// storefront cards, the product page, and NOVA AI's own understanding of the catalog.
function isFreeProduct(p){ return !p || p.price===null || p.price===undefined || Number(p.price)<=0; }
function migrateLegacyHomeMessaging(){
  const c = DB.content || {};
  const next = {...c};
  if(c.heroTag === 'New drops every week') next.heroTag = 'Free tools, ideas & digital services';
  if(c.heroTitle === 'Digital tools worth your money.') next.heroTitle = 'One home for your digital needs.';
  if(c.heroSub === 'Hand-picked courses, templates & software — reviewed honestly, no filler.') next.heroSub = 'Explore free resources alongside apps, courses, templates, eBooks, software, services and selected physical products.';
  if(c.heroCta === 'Browse Products') next.heroCta = 'Explore Lexden Nova';
  DB.content = next;
}
// The badge is a disclosure for products that actually route through an
// admin-supplied affiliate/purchase URL. Empty values and the old '#' form
// placeholder must never make an ordinary Lexden product look affiliated.
function hasAdminAffiliateLink(p){
  const link = String(p && p.affiliateLink || '').trim();
  if(!/^https?:\/\//i.test(link)) return false;
  try { const url = new URL(link); return url.protocol === 'https:' || url.protocol === 'http:'; }
  catch(_){ return false; }
}
function productKind(p){
  if(!p) return 'product';
  if(String(p.productType||'').toUpperCase()==='PHYSICAL') return 'physical';
  const category = (DB.categories||[]).find(c=>c.id===p.categoryId);
  const text = [category&&category.name, category&&category.label, p.categoryName, p.format, ...(p.tags||[])].join(' ').toLowerCase();
  if(/\b(apps?|mobile apps?|applications?)\b/.test(text)) return 'app';
  if(/software|saas/.test(text)) return 'software';
  if(/\b(courses?|classes|masterclasses?)\b/.test(text)) return 'course';
  if(/\b(e-books?|ebooks?|books?)\b/.test(text)) return 'ebook';
  if(/\btemplates?\b/.test(text)) return 'template';
  if(/\bservices?\b|consult|design|writing/.test(text)) return 'service';
  return 'product';
}
function productActionLabel(p){
  const kind = productKind(p);
  if(kind==='app') return 'Install';
  if(kind==='software') return 'Download';
  if(kind==='course') return 'Start learning';
  if(kind==='ebook') return isFreeProduct(p) ? 'Read now' : 'Get eBook';
  if(kind==='template') return 'Use template';
  if(kind==='service') return 'Book service';
  if(kind==='physical') return 'Buy now';
  return isFreeProduct(p) ? 'Get it free' : (DB.content.buyButtonText||'Buy now');
}
function productExperiencePanel(p){
  const kind = productKind(p);
  if(kind==='physical' || kind==='product') return '';
  const specs = p.specs || {};
  const valueFor = (...keys) => {
    const key = Object.keys(specs).find(name=>keys.some(wanted=>name.toLowerCase().includes(wanted)));
    return key ? specs[key] : '';
  };
  let title = '', eyebrow = '', note = '', rows = [];
  if(kind==='app'){
    title = 'About this app'; eyebrow = 'APP OVERVIEW';
    note = 'Check compatibility and key details, then install when you are ready.';
    rows = [['Platform', valueFor('platform','operating system','os')], ['Version', valueFor('version')], ['App size', valueFor('size')], ['Developer', valueFor('developer','publisher')]];
  }else if(kind==='software'){
    title = 'Software details'; eyebrow = 'SOFTWARE';
    note = 'Review supported devices, license terms and included features before downloading.';
    rows = [['Compatibility', valueFor('compatibility','platform','operating system')], ['License', valueFor('license')], ['Version', valueFor('version')], ['Includes', valueFor('includes','features')]];
  }else if(kind==='course'){
    title = 'Course overview'; eyebrow = 'LEARNING';
    note = 'See the learning format and level before you begin.';
    rows = [['Format', p.format || valueFor('format')], ['Level', p.level || valueFor('level')], ['Duration', valueFor('duration','length')], ['Certificate', valueFor('certificate')]];
  }else if(kind==='ebook'){
    title = 'Inside this eBook'; eyebrow = 'READING';
    note = 'Review the format and reading details before opening your copy.';
    rows = [['Format', p.format || valueFor('format')], ['Pages', valueFor('pages','page count')], ['Author', valueFor('author')], ['Language', valueFor('language')]];
  }else if(kind==='template'){
    title = 'Template details'; eyebrow = 'READY TO USE';
    note = 'Check the file format and compatible tools to make sure it fits your workflow.';
    rows = [['Format', p.format || valueFor('format')], ['Works with', valueFor('works with','compatible','platform')], ['Included files', valueFor('files','includes')], ['Use case', valueFor('use case','purpose')]];
  }else if(kind==='service'){
    title = 'Service details'; eyebrow = 'HOW WE CAN HELP';
    note = 'Review what is included and the expected delivery before booking.';
    rows = [['Deliverables', valueFor('deliverable','includes')], ['Turnaround', valueFor('turnaround','delivery time')], ['Revisions', valueFor('revision')], ['Format', p.format || valueFor('format')]];
  }
  const visibleRows = rows.filter(([,value])=>value != null && String(value).trim() !== '');
  return `<div class="detail-block" data-product-experience="${kind}">
    <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:8px;"><h3 style="margin:0;">${title}</h3><span class="chip">${eyebrow}</span></div>
    <p class="text-2 small" style="margin-bottom:10px;">${note}</p>
    ${visibleRows.length ? visibleRows.map(([label,value])=>`<div class="spec-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`).join('') : `<div class="card" style="padding:12px;"><p class="text-2 small">${escapeHtml(p.format || p.level || 'Details are being prepared. Contact us if you need help choosing.')}</p></div>`}
  </div>`;
}
// Matches by the category's NAME (containing "course"), not its id — ids
// are slugified once at creation time and never renamed, but an admin can
// rename the category's display name later, and matching on id alone would
// silently stop working the moment they did. This stays correct either way.
function isCourseProduct(p){
  if(!p || !p.category) return false;
  const cat = DB.categories.find(c=>c.id===p.category);
  return !!(cat && /course/i.test(cat.name||''));
}
function discountPercent(p){
  if(!p || isFreeProduct(p) || !p.salePrice || Number(p.salePrice)>=Number(p.price)) return 0;
  return Math.round((1 - (Number(p.salePrice)/Number(p.price))) * 100);
}
function priceLabel(p){
  if(isFreeProduct(p) && !(p.variants||[]).length) return 'Free';
  const variants=(p.variants||[]).filter(v=>isVariantPurchasable(v)).sort((a,b)=>effectiveVariantPrice(p,a)-effectiveVariantPrice(p,b));
  const variant=variants[0];
  const current=variant?effectiveVariantPrice(p,variant):effectiveVariantPrice(p,null);
  const label=current===0?'Free':fmtPrice(current);
  return variants.length>1?`From ${label}`:label;
}
function effectiveVariantPrice(p,variant){
  const base=variant&&typeof variant.price==='number'?variant.price:(p&&p.price);
  if(typeof base!=='number'||!Number.isFinite(base)||base<0)return null;
  const sale=variant&&typeof variant.salePrice==='number'?variant.salePrice:(!variant&&p&&p.salePrice);
  return typeof sale==='number'&&Number.isFinite(sale)&&sale>=0&&sale<base?sale:base;
}
function isVariantPurchasable(variant){return !!variant&&variant.active!==false&&variant.available!==false&&!(variant.stock!==undefined&&variant.stock!==null&&variant.stock!==''&&Number.isFinite(Number(variant.stock))&&Number(variant.stock)<=0);}
function variantLabel(p,variant){
  if(!variant)return '';
  const values=variant.optionValues||{};
  return (p.options||[]).map(option=>{const value=(option.values||[]).find(item=>String(item.id)===String(values[option.id]));return value?value.label:values[option.id];}).filter(Boolean).join(' • ')||variant.title||variant.name||'';
}
function getSelectedProductVariant(p){
  const variants=(p&&Array.isArray(p.variants)?p.variants:[]);
  if(!variants.length)return null;
  let variant=variants.find(v=>String(v.id)===String(appState.selectedVariants[p.id]||''));
  if(!variant){variant=variants.find(isVariantPurchasable)||null;if(variant)appState.selectedVariants[p.id]=variant.id;}
  return variant;
}
function productVariantSelector(p){
  const variants=(p.variants||[]); if(!variants.length)return '';
  const selected=getSelectedProductVariant(p); if(!selected)return `<div class="variant-unavailable" role="status">No options are currently available. Please contact us for help.</div>`;
  const options=Array.isArray(p.options)?p.options:[];
  if(!options.length)return `<div class="variant-choice-group" id="variantSelector-${escapeHtml(p.id)}"><label for="variantChoice-${escapeHtml(p.id)}">Choose an option</label><select id="variantChoice-${escapeHtml(p.id)}" onchange="selectProductVariant('${jsStr(p.id)}',this.value)">${variants.map(v=>`<option value="${escapeHtml(v.id)}" ${String(v.id)===String(selected.id)?'selected':''} ${isVariantPurchasable(v)?'':'disabled'}>${escapeHtml(v.title||v.name||v.sku||'Option')} · ${priceLabel({...p,variants:[],price:effectiveVariantPrice(p,v),salePrice:null})}${v.stock===0?' · Out of stock':''}</option>`).join('')}</select><div class="small text-2" id="pdVariantAvailability" aria-live="polite">${selected.stock===0?'Out of stock':selected.stock!=null?`${selected.stock} available`:'Available'}</div></div>`;
  return `<div class="variant-selector" id="variantSelector-${escapeHtml(p.id)}">${options.map(option=>`<fieldset class="variant-choice-group"><legend>${escapeHtml(option.name)}</legend><div class="variant-choice-list">${(option.values||[]).map(value=>{
    const active=String((selected.optionValues||{})[option.id])===String(value.id);
    const available=variants.some(variant=>isVariantPurchasable(variant)&&String((variant.optionValues||{})[option.id])===String(value.id)&&(p.options||[]).every(other=>other.id===option.id||String((variant.optionValues||{})[other.id])===String((selected.optionValues||{})[other.id])));
    return `<button type="button" class="variant-choice ${active?'selected':''}" aria-pressed="${active}" ${available?'':'disabled'} onclick="selectProductOption('${jsStr(p.id)}','${jsStr(option.id)}','${jsStr(value.id)}')">${escapeHtml(value.label||value.id)}</button>`;
  }).join('')}</div></fieldset>`).join('')}
  <div class="selected-variant-summary" aria-live="polite"><span id="pdVariantSummary">${escapeHtml(variantLabel(p,selected))}</span><strong id="pdVariantPrice">${priceLabel({...p,variants:[],price:effectiveVariantPrice(p,selected),salePrice:null})}</strong><span id="pdVariantAvailability">${selected.stock===0?'Out of stock':(p.productType==='PHYSICAL'?'Availability confirmed when ordered':'Available')}</span></div></div>`;
}
function selectProductVariant(productId,variantId){
  const p=findProduct(productId);const variant=(p&&p.variants||[]).find(v=>String(v.id)===String(variantId));
  if(!isVariantPurchasable(variant)){toast('That option is not available right now.','info');return;}
  appState.selectedVariants[productId]=variant.id;updateSelectedVariantUI(p,variant);
}
function selectProductOption(productId,optionId,valueId){
  const p=findProduct(productId);if(!p)return;
  const current=getSelectedProductVariant(p);const values={...(current&&current.optionValues||{}),[optionId]:valueId};
  const variant=(p.variants||[]).find(v=>isVariantPurchasable(v)&&(p.options||[]).every(option=>String((v.optionValues||{})[option.id])===String(values[option.id])));
  if(!variant){toast('That combination is not available. Choose another option.','info');return;}
  selectProductVariant(productId,variant.id);
}
function updateSelectedVariantUI(p,variant){
  const selector=document.getElementById(`variantSelector-${p.id}`);
  if(selector){const replacement=productVariantSelector(p);selector.outerHTML=replacement;}
  const current=effectiveVariantPrice(p,variant);
  const main=$('#pdCurrentPrice');if(main)main.textContent=current===0?'Free':fmtPrice(current);
  const sticky=$('#pdStickyPrice');if(sticky)sticky.textContent=current===0?'Free':fmtPrice(current);
  const action=$('#pdStickyAction');if(action)action.innerHTML=stickyPurchaseActionHtml(p,variant);
  const base=typeof variant.price==='number'?variant.price:p.price;
  const sale=typeof variant.salePrice==='number'&&variant.salePrice<base?variant.salePrice:null;
  const priceRow=main&&main.parentElement;
  let old=$('#pdOldPrice');
  if(sale!==null&&!old&&priceRow){old=document.createElement('span');old.id='pdOldPrice';old.className='pd-old';priceRow.appendChild(old);}
  if(old){old.textContent=sale!==null?fmtPrice(base):'';old.hidden=sale===null;}
  const discount=sale!==null&&base>0?Math.round((1-sale/base)*100):0;
  let badge=$('#pdDiscountBadge');
  if(discount>0&&!badge&&priceRow){badge=document.createElement('span');badge.id='pdDiscountBadge';badge.className='chip';badge.style.cssText='background:var(--accent-2);color:#fff;';priceRow.appendChild(badge);}
  if(badge){badge.textContent=discount?`-${discount}% OFF`:'';badge.hidden=!discount;}
  const status=$('#pdVariantAvailability');if(status)status.textContent=variant.stock===0?'Out of stock':(variant.stock!=null?`${variant.stock} available`:p.productType==='PHYSICAL'?'Availability confirmed when ordered':'Available');
  const media=$('#pdMediaMain');
  if(media){const selectedMedia=variant.image?{url:variant.image,type:'image',alt:variantLabel(p,variant)}:productMedia(p)[0]||{url:p.image,type:'image'};media.innerHTML=mediaHtml(selectedMedia,true);}
}
function deliverFreeProduct(productId){
  const product=findProduct(productId);if(!product)return;
  const variant=getSelectedProductVariant(product);
  const url=variant&&(variant.deliveryLink||variant.fileUrl||variant.affiliateLink||variant.externalPaymentLink)||product.deliveryLink||product.fileUrl||product.affiliateLink||'';
  if(!url||url==='#'){toast('This free resource is not ready yet. Please check back soon.','info');return;}
  logActivity('User',`Opened free ${productKind(product)} resource "${product.name}"`);
  trackProductClick(product.id);
  window.open(url,'_blank','noopener');
}
function stickyPurchaseActionHtml(p,variant){
  if((p.variants||[]).length&&!isVariantPurchasable(variant))return '<button class="btn btn-outline" style="width:100%;" disabled>No options available</button>';
  const amount=variant?effectiveVariantPrice(p,variant):effectiveVariantPrice(p,null);
  const free=variant?amount===0:isFreeProduct(p);
  const actionProduct=variant?{...p,price:amount,salePrice:null}:p;
  const label=productKind(p)==='course'&&!free?'Get Started':productActionLabel(actionProduct);
  const action=free?`deliverFreeProduct('${jsStr(p.id)}')`:`startCheckout('${jsStr(p.id)}')`;
  return `<button class="btn btn-primary" style="width:100%;" onclick="${action}">${escapeHtml(label)} →</button>`;
}
async function tryRefreshExchangeRates(){
  const c = DB.content;
  const last = c.ratesUpdatedAt ? new Date(c.ratesUpdatedAt) : null;
  const dayMs = 24*60*60*1000;
  if(last && (Date.now()-last.getTime()) < dayMs) return; // at most once/day, saves data
  if(!navigator.onLine) return;
  try{
    const res = await fetch('https://open.er-api.com/v6/latest/USD');
    if(!res.ok) return;
    const data = await res.json();
    if(data && data.result==='success' && data.rates){
      const keep = Object.keys(c.exchangeRates);
      const updated = {...c.exchangeRates};
      keep.forEach(code=>{ if(data.rates[code]) updated[code] = data.rates[code]; });
      DB.content = {...c, exchangeRates:updated, ratesUpdatedAt:new Date().toISOString()};
      logActivity('System', 'Auto-updated currency exchange rates');
      render();
    }
  }catch(e){ /* offline or blocked — admin-set rates keep working */ }
}
function starString(rating){
  const full = Math.round(rating);
  return '★★★★★☆☆☆☆☆'.slice(5-full, 10-full) + ' ' + rating.toFixed(1);
}
// The seed catalog originally shipped with made-up rating/reviewCount
// numbers on each product (e.g. "212 reviews" when zero real reviews
// existed). Every rating and review count shown anywhere in the app now
// comes from this function instead — it's computed live from the actual
// reviews people have submitted (DB.testimonials), so the figures shown
// are always real. A product with no submitted reviews yet correctly
// shows 0 reviews rather than an invented number.
function liveRatingStats(p){
  const reviews = DB.testimonials.filter(t=>t.productId===p.id);
  if(!reviews.length) return { rating:0, count:0 };
  const avg = reviews.reduce((s,r)=>s+(r.rating||0),0) / reviews.length;
  return { rating: Math.round(avg*10)/10, count: reviews.length };
}
function toast(msg, type){
  const stack = $('#toast-stack');
  const el = document.createElement('div');
  el.className = 'toast ' + (type||'');
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(()=>{ el.style.transition='opacity .3s'; el.style.opacity='0'; setTimeout(()=>el.remove(),300); }, 2600);
}
function navigate(hash){ if(location.hash === hash){ render(); } else { location.hash = hash; } }
function isWished(id){ return DB.wishlist.includes(id); }
function toggleWish(id){
  let wl = DB.wishlist;
  const adding = !wl.includes(id);
  if(!adding){ wl = wl.filter(x=>x!==id); toast('Removed from wishlist'); }
  else { wl = [...wl, id]; toast('Added to wishlist ❤️','success'); }
  DB.wishlist = wl;
  syncWishIcons();
  pushWishlistToCloud();
  // Feeds dynamic Trending (see computeTrendingProducts) — a wishlist add
  // is a stronger interest signal than a view, so it's weighted higher.
  const counts = {...DB.productWishlistCounts};
  counts[id] = Math.max(0, (counts[id]||0) + (adding?1:-1));
  DB.productWishlistCounts = counts;
  pushProductWishlistCountToCloud(id, adding?1:-1);
}
function syncWishIcons(){
  $all('[data-wish-id]').forEach(btn=>{
    const id = btn.getAttribute('data-wish-id');
    const wished = isWished(id);
    btn.classList.toggle('active', wished);
    btn.innerHTML = icon(wished?'heartFill':'heart');
  });
}
function findProduct(id){ return DB.products.find(p=>p.id===id); }

/* ---------------- AI/SEO STRUCTURED DATA ----------------
   Keeps <title>, meta description/OG/Twitter tags, canonical URL, and
   JSON-LD in sync with whatever screen is showing. This is what lets an
   external AI (or a search crawler) given just the page URL understand
   the site: product name, price, currency, discount, availability
   (including "free"), ratings, and a machine-readable catalog summary —
   without scraping visual HTML.

   BUGFIX (indexing): this used to only touch <title> and the meta
   description. Google generally treats a #hash fragment as part of the
   SAME url as the page without it — the fragment is never even sent to
   the server — so no matter how good the per-product JS-set tags were,
   the whole site could only ever earn ONE indexed result: the homepage.
   Individual products/feed posts could never rank on their own.
   NOVA_LINKS_BASE (below) already serves a real, distinct, crawlable
   page per product/feed post — it was only ever wired up for share
   links. Pointing the canonical link + og:url + twitter:url at THAT url
   instead of the bare homepage whenever a product/feed post is open is
   what actually gives each item a shot at being indexed and found
   separately — the rest of this block (title/description/OG/JSON-LD)
   is what makes that page worth ranking once it's crawled. */
function setMeta(name, content, isProperty){
  const attr = isProperty ? 'property' : 'name';
  let tag = document.querySelector(`meta[${attr}="${name}"]`);
  if(!tag){ tag = document.createElement('meta'); tag.setAttribute(attr, name); document.head.appendChild(tag); }
  tag.setAttribute('content', content);
}
function setCanonical(url){
  const link = document.getElementById('canonicalLink');
  if(link) link.setAttribute('href', url);
  setMeta('og:url', url, true);
  setMeta('twitter:url', url);
}
function setJsonLd(id, obj){
  let tag = document.getElementById(id);
  if(!obj){ if(tag) tag.remove(); return; }
  if(!tag){ tag = document.createElement('script'); tag.type = 'application/ld+json'; tag.id = id; document.head.appendChild(tag); }
  tag.textContent = JSON.stringify(obj);
}
const SITE_URL = 'https://lexdendigital.github.io/LEXDEN-NOVA/index.html';
function productToSchema(p){
  const stats = liveRatingStats(p);
  return {
    '@type':'Product', name:p.name, sku:p.itemCode, description:p.description,
    image:p.image, category:p.category,
    aggregateRating: stats.count ? {'@type':'AggregateRating', ratingValue:stats.rating, reviewCount:stats.count} : undefined,
    offers:{
      '@type':'Offer',
      price: isFreeProduct(p) ? '0.00' : (p.salePrice||p.price).toFixed(2),
      priceCurrency:'USD',
      availability: isFreeProduct(p) ? 'https://schema.org/InStock' : 'https://schema.org/InStock',
      url: NOVA_LINKS_BASE+'/product/'+p.id,
    },
  };
}
// Standard "you are here" trail — Google shows this instead of the raw URL
// in results, and it's a ranking signal for how the page fits the site.
function breadcrumbSchema(crumbs){
  return {
    '@context':'https://schema.org', '@type':'BreadcrumbList',
    itemListElement: crumbs.map((c,i)=>({'@type':'ListItem', position:i+1, name:c.name, item: c.url})),
  };
}
function updateSeoForRoute(hash){
  const c = DB.content;
  const appName = c.appName||'LEXDEN NOVA';
  const defaultImg = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';

  if(hash.startsWith('#product/')){
    const p = findProduct(hash.split('/')[1]);
    if(p){
      const desc = (p.metaDescription || p.shortDescription || p.description || '').slice(0,160);
      const seoTitle = (p.seoTitle || p.name || '').trim();
      const url = NOVA_LINKS_BASE+'/product/'+p.id;
      const cat = DB.categories.find(x=>x.id===p.category);
      document.title = seoTitle ? `${seoTitle} — ${appName}` : appName;
      setMeta('description', desc);
      setMeta('og:title', seoTitle ? `${seoTitle} — ${appName}` : appName, true);
      setMeta('og:description', desc, true);
      if(p.image) setMeta('og:image', p.image, true);
      setMeta('twitter:title', seoTitle ? `${seoTitle} — ${appName}` : appName);
      setMeta('twitter:description', desc);
      if(p.image) setMeta('twitter:image', p.image);
      setCanonical(url);
      setJsonLd('productSchema', {'@context':'https://schema.org', ...productToSchema(p)});
      setJsonLd('breadcrumbSchema', breadcrumbSchema([
        {name:'Home', url: SITE_URL+'#home'},
        {name:'Products', url: SITE_URL+'#products'},
        ...(cat?[{name:cat.name, url: SITE_URL+'#products'}]:[]),
        {name:p.name, url},
      ]));
      if(Array.isArray(p.productFaqs) && p.productFaqs.length){
        setJsonLd('faqSchema', {
          '@context':'https://schema.org', '@type':'FAQPage',
          mainEntity:p.productFaqs.filter(f=>f&&f.q&&f.a).map(f=>({'@type':'Question',name:f.q,acceptedAnswer:{'@type':'Answer',text:f.a}})),
        });
      } else setJsonLd('faqSchema', null);
      return;
    }
  }
  if(hash.startsWith('#feed/')){
    const post = DB.feed.find(x=>x.id===hash.split('/')[1]);
    if(post){
      const desc = firstParagraph(post.body||'', 160);
      const url = NOVA_LINKS_BASE+'/feed/'+post.id;
      const img = (post.media && post.media[0] && post.media[0].url) || defaultImg;
      document.title = `${post.title} — ${appName}`;
      setMeta('description', desc);
      setMeta('og:title', `${post.title} — ${appName}`, true);
      setMeta('og:description', desc, true);
      if(img) setMeta('og:image', img, true);
      setMeta('twitter:title', `${post.title} — ${appName}`);
      setMeta('twitter:description', desc);
      if(img) setMeta('twitter:image', img);
      setCanonical(url);
      setJsonLd('productSchema', null);
      setJsonLd('breadcrumbSchema', breadcrumbSchema([
        {name:'Home', url: SITE_URL+'#home'},
        {name:post.title, url},
      ]));
      setJsonLd('faqSchema', null);
      return;
    }
  }
  if(hash === '#service'){
    document.title = `Services & FAQ — ${appName}`;
    setMeta('description', `What we can build for you, plus answers to common questions about ${appName}.`);
    setMeta('og:title', `Services & FAQ — ${appName}`, true);
    setMeta('og:description', `What we can build for you, plus answers to common questions about ${appName}.`, true);
    if(defaultImg) setMeta('og:image', defaultImg, true);
    setMeta('twitter:title', `Services & FAQ — ${appName}`);
    setMeta('twitter:description', `What we can build for you, plus answers to common questions about ${appName}.`);
    // Query-string (not hash) so this is at least a distinct, crawlable
    // URL for the FAQ content, even though it's the same static file.
    setCanonical(SITE_URL+'?service=1');
    setJsonLd('productSchema', null);
    setJsonLd('breadcrumbSchema', breadcrumbSchema([{name:'Home', url: SITE_URL+'#home'},{name:'Service & FAQ', url: SITE_URL+'?service=1'}]));
    if(DB.faqs && DB.faqs.length){
      setJsonLd('faqSchema', {
        '@context':'https://schema.org', '@type':'FAQPage',
        mainEntity: DB.faqs.map(f=>({'@type':'Question', name:f.q, acceptedAnswer:{'@type':'Answer', text:f.a}})),
      });
    } else setJsonLd('faqSchema', null);
    return;
  }
  document.title = appName;
  setMeta('description', c.heroSub||'');
  setMeta('og:title', appName, true);
  setMeta('og:description', c.heroSub||'', true);
  if(defaultImg) setMeta('og:image', defaultImg, true);
  setMeta('twitter:title', appName);
  setMeta('twitter:description', c.heroSub||'');
  setCanonical(SITE_URL);
  setJsonLd('productSchema', null);
  setJsonLd('breadcrumbSchema', null);
  setJsonLd('faqSchema', null);
}
// A standing, always-current catalog summary an AI agent can read straight
// from the page source (window.NOVA_CATALOG) or from the #catalogSchema
// JSON-LD block, without needing to click through every product page.
function updateCatalogSchema(){
  const products = DB.products.filter(p=>p.status!=='draft');
  window.NOVA_CATALOG = {
    organization:{name:DB.content.appName, email:DB.content.contactEmail, whatsapp:DB.content.whatsappDisplay},
    productCount: products.length,
    categories: DB.categories.filter(c=>c.id!=='all').map(c=>c.name),
    products: products.map(p=>{
      const stats = liveRatingStats(p);
      return {
        id:p.id, name:p.name, category:p.category, itemCode:p.itemCode,
        priceUSD: isFreeProduct(p) ? 0 : (p.salePrice||p.price),
        free: isFreeProduct(p), discountPercent: discountPercent(p),
        rating:stats.rating, reviewCount:stats.count, url:`#product/${p.id}`,
      };
    }),
  };
  setJsonLd('catalogSchema', {
    '@context':'https://schema.org', '@type':'ItemList',
    itemListElement: products.slice(0,50).map((p,i)=>({'@type':'ListItem', position:i+1, item:productToSchema(p)})),
  });
}
function applyTheme(){
  document.documentElement.setAttribute('data-theme', appState.theme);
  lsSet(LS_KEYS.theme, appState.theme);
}

/* ---------------- ROUTER ---------------- */
const ROUTES = ['#home','#products','#service','#feed','#wishlist','#profile','#menu','#orders'];
function currentRoute(){ return location.hash || '#home'; }

window.addEventListener('hashchange', render);
// NOTE: layout adapts purely via CSS media queries, so a full re-render on
// resize is never needed and was the cause of the keyboard closing / the
// app appearing to "refresh itself" whenever the on-screen keyboard opened
// (which fires a resize event) or the address bar hid/showed on scroll.
// We only need to (re)spawn the desktop ambient particles on resize.
window.addEventListener('resize', debounce(function(){ if(typeof spawnParticles === 'function') spawnParticles(); }, 250)); // wrapped: spawnParticles lives in a later script file
function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a),ms); }; }

/* ============ SKELETON LOADER UTILITIES ============ */
function createSkeletonProductCard(){
  return `
    <div class="skeleton-product-card skeleton" style="margin:8px 4px;">
      <div class="skeleton-product-image"></div>
      <div class="skeleton-product-content">
        <div class="skeleton-text" style="height:14px; margin-bottom:8px;"></div>
        <div class="skeleton-text short" style="height:12px; margin-bottom:6px;"></div>
        <div class="skeleton-text short" style="height:12px;"></div>
      </div>
    </div>
  `;
}

function renderSkeletonCatalog(count = 8){
  let html = '<div style="display:grid; grid-template-columns:repeat(auto-fill, minmax(140px, 1fr)); gap:8px; width:100%;">';
  for(let i=0;i<count;i++) html += createSkeletonProductCard();
  html += '</div>';
  return html;
}

function renderSkeletonFeed(count = 6){
  let html = '';
  for(let i=0;i<count;i++){
    html += `
      <div class="card skeleton" style="padding:16px; margin-bottom:12px;">
        <div style="display:flex; gap:12px;">
          <div class="skeleton-avatar" style="flex-shrink:0; width:40px; height:40px; border-radius:50%;"></div>
          <div style="flex:1; min-width:0;">
            <div class="skeleton-text short" style="height:14px; margin-bottom:8px;"></div>
            <div class="skeleton-text" style="height:12px; margin-bottom:6px;"></div>
            <div class="skeleton-text medium" style="height:12px;"></div>
          </div>
        </div>
      </div>
    `;
  }
  return html;
}

// BUGFIX ("page keeps jumping to the top / blinking on its own"): render()
// used to unconditionally scroll to top and rebuild #app every single time
// it ran — but render() isn't only called on navigation. Background events
// (an order-status Firestore listener, the once-a-day exchange-rate
// refresh, auth-state changes, a currency switch) all call render() too,
// on whatever screen the shopper currently has open. Because those fired
// on a timer/listener rather than a tap, the shopper would suddenly get
// yanked to the top of the page — and because #app was torn down and
// rebuilt from a string every time, images/inputs would flash. The fix:
// only actually scroll to top (and treat this as a "hard" navigation) when
// the route genuinely changed since the last render. A same-route render
// (background data refresh) rebuilds the content but leaves scroll position
// and focus alone.
let __lastRenderedRoute = null;
function render(){
  const hash = currentRoute();
  // The admin portal and the creator workspace are their own pages (admin/, creator/).
  // Anything that is not their own screen belongs to the storefront, so hand it over.
  if(window.__PAGE === 'admin'   && hash !== '#admin'){ goToPage('', hash); return; }
  if(window.__PAGE === 'creator' && hash !== '#creator'){ goToPage('', hash); return; }
  const isNavigation = hash !== __lastRenderedRoute;
  appState.route = hash;
  // Keep NOVA's quick-reply chips in sync with wherever the shopper just
  // navigated to, even if the panel stays open across the page change.
  if(appState.novaOpen) renderQuickReplies();
  const app = $('#app');
  if(isNavigation){
    window.scrollTo({top:0, behavior:'auto'});
    __lastRenderedRoute = hash;
    app.classList.remove('no-anim');
  } else {
    app.classList.add('no-anim');
  }

  if(hash === '#debuglog'){ app.innerHTML = screenDebugLog(); afterDebugLogRender(); return; }
  if(hash === '#admin'){
    if(typeof renderAdmin === 'function'){ renderAdmin(); } else { goToPage('admin/','#admin'); }
    return;
  }
  if(hash === '#login'){ app.innerHTML = screenLogin(); afterAuthRender(); return; }
  if(hash === '#signup'){ app.innerHTML = screenSignup(); afterAuthRender(); return; }

  let body = '';
  if(hash.startsWith('#product/')){
    const __pid = hash.split('/')[1];
    if(isNavigation){ trackProductView(__pid); logAffiliateProductView(__pid); }
    body = screenProductDetail(__pid);
  } else if(hash.startsWith('#feed/')){
    const __fpid = hash.split('/')[1];
    if(isNavigation) trackFeedView(__fpid);
    body = screenFeedDetail(__fpid);
  } else if(hash === '#feed'){
    if(isNavigation) appState.feedShownCount = 12;
    body = screenFeedList();
  } else if(hash === '#products'){
    body = screenProducts();
  } else if(hash === '#service'){
    body = screenService();
  } else if(hash === '#creator'){
    if(typeof screenCreator !== 'function'){ goToPage('creator/','#creator'); return; }
    body = screenCreator();
  } else if(hash.startsWith('#seller/')){
    body = screenSeller(hash.slice(8));
  } else if(hash === '#library'){
    body = screenLibrary();
  } else if(hash === '#wishlist'){
    body = screenWishlist();
  } else if(hash === '#profile'){
    body = screenProfile();
  } else if(hash === '#account'){
    body = screenAccount();
  } else if(hash === '#orders'){
    body = screenOrders();
  } else if(hash === '#menu'){
    body = screenMenu();
  } else if(hash === '#settings'){
    body = screenSettings();
  } else if(hash === '#about'){
    body = screenAbout();
  } else {
    body = screenHome();
  }

  app.innerHTML = topBanner() + shellHeader() + body + shellBottomNav() + '<div class="status-fill" style="display:none"></div>';
  afterRender(hash);
}

/* ---------------- ON-DEVICE DEBUG LOG ----------------
   Type /#debuglog onto the end of the site URL, on the phone itself, to
   read back everything window.__novaLog() has recorded — newest first —
   with a one-tap Copy so it can be pasted into a message. No computer,
   no cable, no chrome://inspect required. */
function screenDebugLog(){
  let list = [];
  try{ list = JSON.parse(localStorage.getItem('ln_debug_log') || '[]'); }catch(e){}
  const rows = list.slice().reverse().map(e=>{
    const d = new Date(e.t);
    const time = d.toLocaleString();
    return `<div style="padding:10px 12px;border-bottom:1px solid var(--border,#e5e5e5);font-family:monospace;font-size:12px;line-height:1.5;">
      <div style="opacity:.6;">${time}</div>
      <div>${(e.msg||'').replace(/</g,'&lt;')}</div>
    </div>`;
  }).join('') || `<div style="padding:20px;text-align:center;opacity:.6;">No log entries yet.</div>`;
  return `
  <div style="min-height:100vh;background:var(--bg,#fff);">
    <div style="position:sticky;top:0;background:var(--card,#fff);padding:14px 16px;border-bottom:1px solid var(--border,#e5e5e5);display:flex;align-items:center;gap:10px;z-index:5;">
      <button onclick="navigate('#home')" style="border:none;background:none;font-size:20px;">←</button>
      <div style="font-weight:700;flex:1;">Debug Log (${list.length})</div>
      <button id="dbgCopyBtn" style="border:1px solid var(--border,#ccc);background:none;border-radius:8px;padding:6px 10px;font-size:13px;">Copy</button>
      <button id="dbgClearBtn" style="border:1px solid var(--border,#ccc);background:none;border-radius:8px;padding:6px 10px;font-size:13px;">Clear</button>
    </div>
    <div>${rows}</div>
  </div>`;
}
function afterDebugLogRender(){
  const copyBtn = $('#dbgCopyBtn');
  const clearBtn = $('#dbgClearBtn');
  if(copyBtn) copyBtn.onclick = async ()=>{
    let list = [];
    try{ list = JSON.parse(localStorage.getItem('ln_debug_log') || '[]'); }catch(e){}
    const text = list.map(e=> new Date(e.t).toLocaleString() + '  ' + e.msg).join('\n');
    try{ await navigator.clipboard.writeText(text || '(empty)'); toast('Log copied','success'); }
    catch(e){ toast('Could not copy — long-press to select text manually','error'); }
  };
  if(clearBtn) clearBtn.onclick = ()=>{
    localStorage.removeItem('ln_debug_log');
    render();
  };
}

/* ---------------- SHELL: headers & nav ---------------- */
/* ---------------- ICON SYSTEM ----------------
   Shared inline-SVG icons (24x24, currentColor) used across the app's
   chrome — nav, header, profile, menu — in place of emoji, so they scale
   crisply, inherit theme color, and don't render inconsistently across
   devices the way emoji fonts do. */
const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/>',
  shop: '<path d="M4 8h16l-1 12H5L4 8Z"/><path d="M8 8V6a4 4 0 0 1 8 0v2"/>',
  heart: '<path d="M12 20.5s-7.2-4.6-9.8-9A5.6 5.6 0 0 1 12 5.4 5.6 5.6 0 0 1 21.8 11.5c-2.6 4.4-9.8 9-9.8 9Z"/>',
  heartFill: '<path d="M12 20.5s-7.2-4.6-9.8-9A5.6 5.6 0 0 1 12 5.4 5.6 5.6 0 0 1 21.8 11.5c-2.6 4.4-9.8 9-9.8 9Z" fill="currentColor"/>',
  // Feed "Like" uses thumbs-up rather than a heart specifically so it can
  // never be mistaken for the wishlist heart on a product card — same
  // gesture family (tap to react), visually distinct meaning.
  thumbUp: '<path d="M7 11v9H4v-9h3Zm3.5 9h6.7c.9 0 1.7-.6 1.9-1.5l1.6-6.6a2 2 0 0 0-2-2.5H14l.6-3.5c.2-1-.6-1.9-1.6-1.9-.5 0-1 .3-1.3.7L8.5 10.2c-.3.4-.5.9-.5 1.4V18c0 1.1.9 2 2 2Z"/>',
  thumbUpFill: '<path d="M7 11v9H4v-9h3Zm3.5 9h6.7c.9 0 1.7-.6 1.9-1.5l1.6-6.6a2 2 0 0 0-2-2.5H14l.6-3.5c.2-1-.6-1.9-1.6-1.9-.5 0-1 .3-1.3.7L8.5 10.2c-.3.4-.5.9-.5 1.4V18c0 1.1.9 2 2 2Z" fill="currentColor"/>',
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c1.2-4 4-6 7.5-6s6.3 2 7.5 6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.6-3.6"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 3v2.2M12 18.8V21M4.4 4.4l1.6 1.6M18 18l1.6 1.6M3 12h2.2M18.8 12H21M4.4 19.6l1.6-1.6M18 6l1.6-1.6"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"/>',
  package: '<path d="M21 8 12 3 3 8v8l9 5 9-5V8Z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 13a7.6 7.6 0 0 0 .1-2l2-1.5-2-3.4-2.4.6a7.7 7.7 0 0 0-1.7-1L15 3h-4l-.4 2.7a7.7 7.7 0 0 0-1.7 1l-2.4-.6-2 3.4L6.5 11a7.6 7.6 0 0 0 0 2l-2 1.5 2 3.4 2.4-.6a7.7 7.7 0 0 0 1.7 1L11 21h4l.4-2.7a7.7 7.7 0 0 0 1.7-1l2.4.6 2-3.4-2.1-1.5Z"/>',
  bell: '<path d="M6 10a6 6 0 0 1 12 0c0 4 1.5 5.5 1.5 5.5H4.5S6 14 6 10Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.4 3.8 5.4 3.8 8.5s-1.3 6.1-3.8 8.5c-2.5-2.4-3.8-5.4-3.8-8.5S9.5 5.9 12 3.5Z"/>',
  currency: '<circle cx="12" cy="12" r="8.5"/><path d="M14.5 9.3a2.6 2.6 0 0 0-2.5-1.8c-1.6 0-2.8 1-2.8 2.3 0 3 5.3 1.7 5.3 4.6 0 1.4-1.3 2.4-2.9 2.4a2.9 2.9 0 0 1-2.9-2M12 6.5v11"/>',
  doc: '<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M9.5 12h5M9.5 15.5h5"/>',
  scroll: '<path d="M6 4h11a2 2 0 0 1 2 2v13a1.5 1.5 0 0 1-1.5 1.5H8A2 2 0 0 1 6 18.5V4Z"/><path d="M6 4a2 2 0 0 0-2 2v12.5A1.5 1.5 0 0 0 5.5 20M9 8h7M9 11.5h7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  dashboard: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.3"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.3"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.3"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.3"/>',
  folder: '<path d="M3.5 7a1.5 1.5 0 0 1 1.5-1.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8A1.5 1.5 0 0 1 19 18.5H5A1.5 1.5 0 0 1 3.5 17Z"/>',
  edit: '<path d="M4.5 19.5h4L19 9a2 2 0 0 0-3-3L5.5 15.5Z"/><path d="M13.5 7l3 3"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 1 0 0 17c1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.4-1.2-.3-.4-.5-.8-.5-1.3 0-.9.8-1.7 1.7-1.7H16a3.7 3.7 0 0 0 3.7-3.7c0-4-3.4-7.3-7.7-7.3Z"/><circle cx="7.8" cy="11" r="1"/><circle cx="9.6" cy="7.7" r="1"/><circle cx="14.4" cy="7.7" r="1"/><circle cx="16.2" cy="11" r="1"/>',
  layers: '<path d="m12 3 8 4.5-8 4.5-8-4.5Z"/><path d="m4 12 8 4.5 8-4.5"/><path d="m4 16.5 8 4.5 8-4.5"/>',
  newspaper: '<rect x="4" y="5.5" width="16" height="13" rx="1.5"/><path d="M8 9.5h8M8 12.5h8M8 15.5h5"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.2a2.5 2.5 0 0 1 4.9.7c0 1.7-2.4 1.9-2.4 3.6"/><path d="M12 17v.01"/>',
  phone: '<path d="M7 3.5h10a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z"/><path d="M11 18h2"/>',
  sparkle: '<path d="M12 3.5 13.6 9 19 10.6 13.6 12.2 12 17.7 10.4 12.2 5 10.6 10.4 9Z"/>',
  card: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10.5h18M7 15h4"/>',
  download: '<path d="M12 3.5v11M8 11l4 4 4-4"/><path d="M4.5 17.5v2a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2"/>',
  receipt: '<path d="M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3Z"/><path d="M9 8h6M9 11.5h6M9 15h4"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  logout: '<path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
  code: '<path d="m9 8-5 4 5 4"/><path d="m15 8 5 4-5 4"/>',
  mobile: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 19h2"/>',
  brain: '<path d="M9.5 4.5a2.5 2.5 0 0 0-2.5 2.5v.3A2.7 2.7 0 0 0 5.5 9.7 2.6 2.6 0 0 0 5 12a2.7 2.7 0 0 0-.5 4.5A2.6 2.6 0 0 0 7 20a2.5 2.5 0 0 0 2.5-2.5v-10A2.5 2.5 0 0 0 9.5 4.5Z"/><path d="M14.5 4.5a2.5 2.5 0 0 1 2.5 2.5v.3a2.7 2.7 0 0 1 1.5 2.4A2.6 2.6 0 0 1 19 12a2.7 2.7 0 0 1 .5 4.5A2.6 2.6 0 0 1 17 20a2.5 2.5 0 0 1-2.5-2.5v-10A2.5 2.5 0 0 1 14.5 4.5Z"/>',
  shield: '<path d="M12 3.5 5 6v5.5c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6Z"/>',
  graduation: '<path d="M3 9.5 12 5l9 4.5-9 4.5-9-4.5Z"/><path d="M7 12v4.5c0 1.4 2.2 2.5 5 2.5s5-1.1 5-2.5V12"/>',
  target: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
  chat: '<path d="M4 5.5h16v10.5H8.5L4 19.5Z"/>',
  send: '<path d="m4 4 16 8-16 8 4-8Z"/>',
  building: '<rect x="5" y="3.5" width="14" height="17"/><path d="M9 7.5h1.5M13.5 7.5H15M9 11h1.5M13.5 11H15M9 14.5h1.5M13.5 14.5H15"/><path d="M10 20.5v-3.5h4v3.5"/>',
  bug: '<path d="M9 8.5V7a3 3 0 0 1 6 0v1.5"/><rect x="6.5" y="8.5" width="11" height="10" rx="4"/><path d="M3.5 12h3M17.5 12h3M5 8l2.5 1.5M19 8l-2.5 1.5M5 17l2.5-1.5M19 17l-2.5-1.5"/>',
  refresh: '<path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5"/><path d="M4 4v4.5h4.5"/><path d="M4 13a8 8 0 0 0 13.7 4.7L20 15.5"/><path d="M20 20v-4.5h-4.5"/>',
  check: '<path d="M5 13l4.5 4.5L19.5 7"/>',
  warning: '<path d="M12 3.5 21 19.5H3Z"/><path d="M12 9.5v5"/><path d="M12 17v.01"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  trash: '<path d="M4.5 7h15"/><path d="M9 7V4.7a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V7"/><path d="M6.5 7l1 12.3a1 1 0 0 0 1 1h6.9a1 1 0 0 0 1-1L17.5 7"/>',
  share: '<circle cx="18" cy="5.5" r="2.2"/><circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="18.5" r="2.2"/><path d="M8 10.7l8-4M8 13.3l8 4"/>',
  cloud: '<path d="M7 18a4.2 4.2 0 0 1-.5-8.4A5.5 5.5 0 0 1 17.3 8 4 4 0 0 1 17 18Z"/>',
  star: '<path d="m12 3.5 2.6 5.5 5.9.8-4.3 4.2 1 6-5.2-2.9-5.2 2.9 1-6-4.3-4.2 5.9-.8Z"/>',
};
function icon(name, cls){
  const d = ICONS[name] || '';
  return `<svg class="ic-svg${cls?' '+cls:''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}
function navLinks(activeHash){
  const items = [
    {href:'#home', ic:'home', label:'Home'},
    {href:'#products', ic:'shop', label:'Products'},
    {href:'#feed', ic:'newspaper', label:'Feed'},
    {href:'#profile', ic:'user', label:'Profile'},
    {href:'#menu', ic:'menu', label:'Menu'},
  ];
  return items.map(it=>{
    const active = activeHash===it.href ? ' active' : '';
    return `<a class="nav-item${active}" href="${it.href}"><span class="ic">${icon(it.ic)}</span><span>${it.label}</span></a>`;
  }).join('');
}
function topNavLinks(activeHash){
  const items = [
    {href:'#home', label:'Home'},{href:'#products', label:'Products'},{href:'#service', label:'Service'},
    {href:'#feed', label:'Feed'},{href:'#profile', label:'Profile'},{href:'#menu', label:'Menu'},
  ];
  return items.map(it=>`<a class="${activeHash===it.href?'active':''}" href="${it.href}">${it.label}</a>`).join('');
}
function isStandalone(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
// PHASE 3: one banner slot, two possible occupants. An update takes
// priority over an install nudge — if both are true, getting the person
// onto the latest code matters more than the install pitch.
function topBanner(){
  if(appState.updateAvailable){
    return `<div class="top-banner">
      <span class="ic">${icon('refresh')}</span>
      <span class="msg">A new version of NOVA is ready.</span>
      <button class="btn btn-primary btn-sm" onclick="applyUpdate()">Refresh</button>
    </div>`;
  }
  if(appState.canInstall && !isStandalone() && !lsGet(LS_KEYS.installDismissed, false)){
    return `<div class="top-banner">
      <span class="ic">${icon('download')}</span>
      <span class="msg">Install NOVA for faster, offline-ready access.</span>
      <button class="btn btn-primary btn-sm" onclick="handleInstallAction()">Install</button>
      <button class="icon-btn" onclick="dismissInstallBanner()" aria-label="Dismiss">${icon('close')}</button>
    </div>`;
  }
  return '';
}
let deferredInstallPrompt = null;
function triggerInstallPrompt(){
  if(!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.then(choice=>{
    logActivity('User', `Install prompt outcome: ${choice.outcome}`);
    deferredInstallPrompt = null;
    appState.canInstall = false;
    render();
  });
}
// Single entry point for every "Install App" affordance in the app (Profile
// menu row, NOVA's own answer, anywhere else). Always tries the browser's
// real native install prompt FIRST; the manual step-by-step instructions
// only ever show as a fallback, and only when the native prompt genuinely
// isn't available or didn't fire — never as the first thing shown.
function handleInstallAction(){
  if(isStandalone()){
    toast('You already have NOVA installed on this device', 'info');
    return;
  }
  if(deferredInstallPrompt){
    // Native path — the real browser install prompt.
    triggerInstallPrompt();
    return;
  }
  // Native prompt unavailable on this browser (iOS Safari, desktop
  // Safari/Firefox, or a Chromium browser that hasn't fired
  // beforeinstallprompt yet) — this is the ONLY path that reaches the
  // manual instructions, i.e. exactly the "only when it fails" behavior.
  showInstallInstructions();
}
// There is no browser API that can silently trigger "add to home screen" —
// only the browser's own beforeinstallprompt flow (handled above) can do
// that, and only where the browser supports it. Where it isn't available
// (iOS Safari, desktop Safari/Firefox, or Chrome/Edge before the prompt has
// fired), the closest honest equivalent is a button that opens the exact
// steps for the device we detect, so shoppers aren't stuck reading generic
// text — this replaces the old plain-text fallback.
function detectInstallPlatform(){
  const ua = navigator.userAgent || '';
  const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS|EdgiOS/.test(ua);
  const isAndroid = /Android/.test(ua);
  const isFirefox = /Firefox/.test(ua) && !isAndroid;
  if(isIOS && isSafari) return 'ios-safari';
  if(isIOS) return 'ios-other';
  if(isAndroid) return 'android';
  if(isFirefox) return 'desktop-firefox';
  if(/Edg\//.test(ua)) return 'desktop-edge';
  if(/Chrome/.test(ua)) return 'desktop-chrome';
  if(isSafari) return 'desktop-safari';
  return 'other';
}
const INSTALL_STEPS = {
  'ios-safari': ['Tap the <strong>Share</strong> icon (square with an arrow) in the toolbar.', 'Scroll down and tap <strong>Add to Home Screen</strong>.', 'Tap <strong>Add</strong> in the top-right corner.'],
  'ios-other': ['Open this page in <strong>Safari</strong> — other iOS browsers can\'t install apps to the Home Screen.', 'Tap the <strong>Share</strong> icon, then <strong>Add to Home Screen</strong>.'],
  'android': ['Tap the <strong>⋮</strong> menu in your browser (top-right).', 'Tap <strong>Install app</strong> or <strong>Add to Home screen</strong>.', 'Confirm by tapping <strong>Install</strong>.'],
  'desktop-chrome': ['Click the <strong>install icon</strong> (⊕ or a small monitor) at the right edge of the address bar.', 'Or open the <strong>⋮</strong> menu → <strong>Install NOVA…</strong>'],
  'desktop-edge': ['Click the <strong>⋯</strong> menu (top-right).', 'Choose <strong>Apps → Install this site as an app</strong>.'],
  'desktop-firefox': ['Firefox on desktop doesn\'t support installing sites as apps yet.', 'You can still bookmark this page (Ctrl/Cmd+D) for quick access.'],
  'desktop-safari': ['In the menu bar, choose <strong>File → Add to Dock</strong> (Safari 17+), or bookmark this page (Cmd+D).'],
  'other': ['Look for an <strong>Install</strong>, <strong>Add to Home Screen</strong>, or <strong>Add to Dock</strong> option in your browser\'s menu.'],
};
function showInstallInstructions(){
  const platform = detectInstallPlatform();
  const steps = INSTALL_STEPS[platform] || INSTALL_STEPS.other;
  const existing = $('#installStepsModal'); if(existing) existing.remove();
  const overlay = document.createElement('div');
  overlay.id = 'installStepsModal';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:360px;width:100%;padding:20px;">
      <h3 style="margin-bottom:10px;">Install NOVA</h3>
      <ol style="margin:0 0 16px;padding-left:20px;color:var(--text-2);font-size:13.5px;line-height:1.6;">
        ${steps.map(s=>`<li>${s}</li>`).join('')}
      </ol>
      <button class="btn btn-primary" style="width:100%;" onclick="$('#installStepsModal').remove()">Got it</button>
    </div>`;
  overlay.addEventListener('click', (e)=>{ if(e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  logActivity('User', 'Viewed install instructions ('+platform+')');
}
function dismissInstallBanner(){
  lsSet(LS_KEYS.installDismissed, true);
  appState.canInstall = false;
  render();
}
function applyUpdate(){
  // The service worker already holds the newest files (it takes over by itself),
  // so applying the update is just a reload.
  try{ if(window.__swRegistration) window.__swRegistration.update(); }catch(e){}
  location.reload();
}
function shellHeader(){
  const c = DB.content;
  const logo = `<img src="${c.logoUrl}" alt="" class="app-logo-img" onerror="this.style.visibility='hidden'">`;
  return `
  <div class="top-nav">
    <span class="brand logo-press">${logo}<span>${escapeHtml(c.appName||'LEXDEN NOVA')}</span></span>
    <div class="links">${topNavLinks(appState.route)}</div>
    <div class="header-icons">
      <button class="icon-btn" onclick="toggleThemeBtn()" title="Toggle theme">${icon(appState.theme==='dark'?'moon':'sun')}</button>
      <a class="icon-btn" href="#wishlist" title="Wishlist">${icon('heart')}</a>
      <a class="icon-btn" href="#profile" title="Profile">${icon('user')}</a>
    </div>
  </div>
  <div class="app-header">
    <span class="brand logo-press">${logo}<span>${escapeHtml(c.appName||'LEXDEN NOVA')}</span></span>
    <div class="header-icons">
      <button class="icon-btn" onclick="navigate('#products')">${icon('search')}</button>
      <a class="icon-btn" href="#wishlist" style="position:relative">${icon('heart')}<span class="badge-dot" style="display:${DB.wishlist.length?'block':'none'}"></span></a>
    </div>
  </div>`;
}
function shellBottomNav(){
  return `<nav class="bottom-nav" aria-label="Primary">${navLinks(appState.route)}</nav>`;
}
function toggleThemeBtn(){
  appState.theme = appState.theme === 'dark' ? 'light' : 'dark';
  applyTheme();
  render();
}

/* ---------------- PRODUCT CARD (shared) ---------------- */
function productCard(p, opts){
  opts = opts || {};
  const wished = isWished(p.id);
  const hasSale = p.salePrice && p.salePrice < p.price;
  const off = discountPercent(p);
  const stats = liveRatingStats(p);
  const kind = productKind(p);
  const kindLabel = ({physical:'Physical product',app:'App',software:'Software',course:'Course',ebook:'eBook',template:'Template',service:'Service'})[kind] || (p.productType ? String(p.productType).toLowerCase() : 'Digital resource');
  return `
  <div class="product-card ${opts.small?'card-sm':''}" onclick="navigate('#product/${p.id}')" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();navigate('#product/${p.id}')}" role="link" tabindex="0" aria-label="View ${escapeHtml(p.name)} — ${escapeHtml(kindLabel)}, ${priceLabel(p)}">
    <div class="thumb-wrap">
      <img src="${cldOptimize(p.image, 400)}" alt="${escapeHtml(p.name)}" loading="lazy">
      <span class="product-kind-badge">${escapeHtml(kindLabel)}</span>
      <span class="price-badge">${priceLabel(p)}</span>
      ${off>0?`<span class="price-badge" style="left:8px;right:auto;background:var(--accent-4);color:#fff;">-${off}%</span>`:''}
      <button class="wish-btn ${wished?'active':''}" data-wish-id="${p.id}" onclick="event.stopPropagation(); toggleWish('${p.id}')" aria-label="Toggle wishlist">${icon(wished?'heartFill':'heart')}</button>
    </div>
    <div class="info">
      <div class="name">${escapeHtml(p.name)}</div>
      <div class="meta-row">
        <span class="rating">${stats.count ? `★ ${stats.rating}` : 'Explore details'}</span>
        <span class="product-card-action">${escapeHtml(productActionLabel(p))} →</span>
        ${hasSale?`<span class="old-price">${fmtPrice(p.price)}</span>`:''}
      </div>
    </div>
  </div>`;
}
function skeletonCards(n){
  return Array.from({length:n}).map(()=>`<div class="skel skel-card"></div>`).join('');
}
