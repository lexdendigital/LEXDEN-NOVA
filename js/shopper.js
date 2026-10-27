'use strict';

/* ---------------- HOME ---------------- */
function screenHome(){
  const products = DB.products.filter(p=>p.status!=='draft');
  // Dynamic, signal-driven Trending / personalized Featured — see
  // computeTrendingProducts / computeFeaturedForYou. Both gracefully fall
  // back to the admin's static featured:true/trending:true flags until
  // enough real activity (views, wishlist adds, feed likes) has accumulated.
  const featured = computeFeaturedForYou(products, shopperProfile(), 8);
  const trending = computeTrendingProducts(products, 3);
  const c = DB.content;
  const freeResources = products.filter(isFreeProduct).slice(0, 4);
  const categoryLinks = (DB.categories||[]).filter(cat=>cat.id && cat.id!=='all').slice(0, 6);
  return `
  <div class="screen">
    <div class="hero">
      <div class="htag">✨ ${escapeHtml(c.heroTag)}</div>
      <h1>${escapeHtml(c.heroTitle)}</h1>
      <p>${escapeHtml(c.heroSub)}</p>
      <button class="btn btn-primary" onclick="navigate('#products')">${escapeHtml(c.heroCta)} →</button>
    </div>

    <div class="section" aria-labelledby="freeStartHeading">
      <div class="section-head"><h2 id="freeStartHeading">Start with something free</h2><a class="see-all" href="#products">Explore the library</a></div>
      <p class="text-2 small" style="margin:-4px 0 12px;">Useful digital tools and learning resources are available at no cost. Browse first; choose a paid option only when it fits your need.</p>
      ${freeResources.length
        ? `<div class="hscroll">${freeResources.map(p=>productCard(p,{small:true})).join('')}</div>`
        : `<div class="card" style="padding:16px;"><strong>Free resources are being prepared.</strong><p class="text-2 small" style="margin-top:4px;">Explore tools, courses, books and templates across the Lexden Nova library.</p></div>`}
    </div>

    ${categoryLinks.length ? `<div class="section">
      <div class="section-head"><h2>Explore by what you need</h2><a class="see-all" href="#products">All categories</a></div>
      <p class="text-2 small" style="margin:-4px 0 12px;">Find digital tools, apps, courses and services alongside selected physical products.</p>
      <div class="hscroll">${categoryLinks.map(cat=>`<button class="card card-sm" style="padding:14px 16px;text-align:left;min-width:145px;cursor:pointer;" onclick="appState.productFilters.category=${escapeHtml(JSON.stringify(cat.id))};navigate('#products')"><strong>${escapeHtml(cat.name||cat.label||'Explore')}</strong><span class="text-2 small" style="display:block;margin-top:4px;">Browse ${escapeHtml(cat.name||cat.label||'resources')}</span></button>`).join('')}</div>
    </div>` : ''}

    <div class="section">
      <div class="section-head"><h2>Featured</h2><a class="see-all" href="#products">See all</a></div>
      <div class="hscroll">${featured.length? featured.map(p=>productCard(p,{small:true})).join('') : skeletonCards(4)}</div>
    </div>

    <div class="section">
      <div class="section-head"><h2>Trending now</h2><a class="see-all" href="#products">See all</a></div>
      <div class="grid-products">${trending.map(p=>productCard(p)).join('')}</div>
    </div>

    <div class="section">
      <div class="section-head"><h2>What we can build for you</h2><a class="see-all" href="#service">See all</a></div>
      <div class="hscroll">
        ${DB.services.slice(0,4).map(s=>`
          <div class="card card-sm" style="padding:16px;cursor:pointer;" onclick="navigate('#service')" role="button">
            <div style="font-size:24px;margin-bottom:8px;">${s.ic}</div>
            <div style="font-weight:700;font-size:13px;margin-bottom:4px;">${escapeHtml(s.title)}</div>
            <div class="text-2" style="font-size:11.5px;line-height:1.5;">${escapeHtml(s.desc)}</div>
          </div>`).join('')}
      </div>
    </div>

    ${heroFeedHtml()}

    <div class="section">
      <div class="section-head"><h2>From the feed</h2><a class="see-all" href="#feed">More feed</a></div>
      <div class="hscroll">
        ${featuredPostsHtml()}
      </div>
    </div>

    <div class="card" style="padding:22px;text-align:center;">
      <h3 style="margin-bottom:6px;">Ready to find your next tool?</h3>
      <p class="text-2 small" style="margin-bottom:14px;">Browse the full catalog with filters, sorting and search.</p>
      <button class="btn btn-primary" onclick="navigate('#products')">Start Exploring</button>
    </div>
  </div>`;
}
// "Important" feed posts get the big Play Store-style hero treatment —
// full-width media (image or video, not a thumbnail), the app/brand row,
// and a prominent action button, exactly like Play Store's "Kimi K3 is
// Live!" style banner. Regular feed posts stay as the small square cards
// below via featuredPostsHtml().
function heroFeedHtml(){
  const posts = DB.feed.filter(p=>p.important);
  if(!posts.length) return '';
  return `
    <div class="hscroll" style="margin-bottom:4px;" id="heroFeedScroll">
      ${posts.map(p=>{
        const cover = (p.media||[])[0];
        const isVideo = cover && cover.type==='video';
        return `
        <div class="feed-hero" onclick="navigate('#feed/${p.id}')" role="button">
          ${cover?(isVideo
            ? `<video src="${cldOptimize(cover.url, 720)}" preload="metadata" muted autoplay loop playsinline class="feed-hero-media"></video>`
            : `<img src="${cldOptimize(cover.url, 600)}" alt="" loading="lazy" class="feed-hero-media">`)
            : `<div class="feed-hero-media" style="background:var(--surface);"></div>`}
          <div class="feed-hero-scrim"></div>
          <div class="feed-hero-title">${escapeHtml(p.title)}</div>
          <div class="feed-hero-row">
            <img src="${DB.content.logoUrl}" class="feed-hero-icon">
            <div class="feed-hero-brand">
              <div class="feed-hero-name">${escapeHtml(DB.content.appName||'LEXDEN NOVA')}</div>
              <div class="feed-hero-sub">${escapeHtml(DB.content.appName||'LEXDEN NOVA')} · Sponsored update</div>
            </div>
            <button class="btn btn-primary btn-sm feed-hero-btn" onclick="event.stopPropagation(); navigate('#feed/${p.id}')">View</button>
          </div>
        </div>`;
      }).join('')}
    </div>`;
}
// Home's "From the feed" preview strip — capped and ranked by feedHotScore
// (via rankedFeed) rather than dumping every post ever created into a
// horizontal scroll. Full list lives at #feed ("More feed" link above).
const FEED_PREVIEW_COUNT = 8;
function featuredPostsHtml(){
  const posts = rankedFeed().filter(p=>!p.important).slice(0,FEED_PREVIEW_COUNT);
  if(!posts.length) return '';
  return posts.map(p=>{
    const cover = (p.media||[])[0];
    const isVideo = cover && cover.type==='video';
    return `
    <div class="card card-sm feed-card" style="overflow:hidden;cursor:pointer;position:relative;" onclick="navigate('#feed/${p.id}')">
      ${cover?(isVideo
        ? `<video src="${cldOptimize(cover.url, 400)}" preload="none" muted playsinline style="width:100%;aspect-ratio:1/1;object-fit:cover;"></video>`
        : `<img src="${cldOptimize(cover.url, 400)}" alt="" loading="lazy" style="width:100%;aspect-ratio:1/1;object-fit:cover;">`)
        : `<div style="width:100%;aspect-ratio:1/1;background:var(--surface);"></div>`}
      <div style="padding:10px;font-size:12px;" class="text-2">${escapeHtml(p.title)}</div>
    </div>`;
  }).join('');
}
// Full "More feed" list (#feed) — every post, ranked by feedHotScore via
// rankedFeed(), with a "Load more" button instead of dumping the entire
// feed into the DOM at once. appState.feedShownCount tracks how many are
// currently visible and is reset to the initial page size on fresh
// navigation (see render()), so returning to #feed later starts fresh
// rather than staying stuck expanded from a previous visit.
const FEED_PAGE_SIZE = 12;
function screenFeedList(){
  const all = rankedFeed();
  const shown = all.slice(0, appState.feedShownCount || FEED_PAGE_SIZE);
  if(!all.length && catalogIsLoading()){
    return `<div class="screen"><h1 class="screen-title">Feed</h1>${skeletonCards(3)}</div>`;
  }
  if(!all.length){
    return `<div class="screen"><h1 class="screen-title">Feed</h1><div class="empty-state"><div class="ic">${icon('newspaper')}</div><h3>Nothing here yet</h3><p>Check back soon for updates and announcements.</p></div></div>`;
  }
  return `
  <div class="screen">
    <h1 class="screen-title">Feed</h1>
    <p class="screen-sub">Ranked by what's actually getting attention right now, newest and most-liked first.</p>
    <div class="section" style="display:flex;flex-direction:column;gap:12px;">
      ${shown.map(p=>{
        const cover = (p.media||[])[0];
        const isVideo = cover && cover.type==='video';
        return `
        <div class="card" style="overflow:hidden;cursor:pointer;display:flex;gap:12px;padding:10px;align-items:center;" onclick="navigate('#feed/${p.id}')">
          <div style="width:72px;height:72px;flex:none;border-radius:10px;overflow:hidden;background:var(--surface);">
            ${cover?(isVideo
              ? `<video src="${cldOptimize(cover.url, 200)}" preload="none" muted playsinline style="width:100%;height:100%;object-fit:cover;"></video>`
              : `<img src="${cldOptimize(cover.url, 200)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;">`)
              : ''}
          </div>
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${p.important?'📌 ':''}${escapeHtml(p.title)}</div>
            <div class="text-2 small">${p.date?new Date(p.date).toLocaleDateString():''}</div>
          </div>
        </div>`;
      }).join('')}
    </div>
    ${shown.length < all.length
      ? `<button class="btn btn-outline btn-block" style="margin-top:14px;" onclick="loadMoreFeed()">Load more</button>`
      : `<p class="text-2 small" style="text-align:center;margin-top:14px;">You've reached the end — ${all.length} post${all.length===1?'':'s'} total.</p>`}
  </div>`;
}
function loadMoreFeed(){
  appState.feedShownCount = (appState.feedShownCount||FEED_PAGE_SIZE) + FEED_PAGE_SIZE;
  render();
}
function screenFeedDetail(id){
  const p = DB.feed.find(x=>x.id===id);
  if(!p){
    return `<div class="screen"><div class="empty-state"><div class="ic">${icon('newspaper')}</div><h3>Post not found</h3><p>It may have been removed.</p><button class="btn btn-primary" onclick="navigate('#home')">Back to Home</button></div></div>`;
  }
  const linkedIds = feedPostProductIds(p);
  const linkedProducts = linkedIds.map(id=>findProduct(id)).filter(Boolean);
  // See relatedFeedPosts() — this is the "read and understand what this
  // post is about, compared against every other post" related-content
  // section, not a manual admin pick.
  const related = relatedFeedPosts(p, 4);
  return `
  <div class="screen">
    <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:10px;">
      <button class="btn btn-ghost btn-sm" onclick="history.back()">← Back</button>
    </div>
    <h1 class="screen-title" style="font-size:21px;">${escapeHtml(p.title)}</h1>
    <p class="screen-sub">${p.date?new Date(p.date).toLocaleDateString():''}</p>
    <div class="section" style="margin:0 -16px;">
      ${(p.media||[]).length > 1 ? `
      <!-- Swipeable media carousel: horizontal scroll-snap instead of a
           stacked vertical list, so multiple images/videos are swiped
           through one at a time like a normal social feed, rather than
           scrolled past vertically. -->
      <div class="feed-media-carousel" style="display:flex;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;gap:0;">
        ${(p.media||[]).map(m=> `<div style="flex:0 0 100%;scroll-snap-align:center;padding:0 16px;">${
          m.type==='video'
            ? `<video src="${cldOptimize(m.url, 960)}" preload="metadata" controls playsinline style="width:100%;border-radius:14px;background:#000;max-height:70vh;"></video>`
            : `<img src="${cldOptimize(m.url, 960)}" alt="" loading="lazy" style="width:100%;border-radius:14px;object-fit:cover;max-height:70vh;">`
        }</div>`).join('')}
      </div>
      <div style="display:flex;justify-content:center;gap:5px;margin-top:8px;">
        ${(p.media||[]).map(()=>`<span style="width:6px;height:6px;border-radius:50%;background:var(--border);"></span>`).join('')}
      </div>
      ` : (p.media||[]).map(m=> `<div style="padding:0 16px;">${
          m.type==='video'
            ? `<video src="${cldOptimize(m.url, 960)}" preload="metadata" controls playsinline style="width:100%;border-radius:14px;background:#000;max-height:70vh;"></video>`
            : `<img src="${cldOptimize(m.url, 960)}" alt="" loading="lazy" style="width:100%;border-radius:14px;object-fit:cover;">`
        }</div>`).join('')}
    </div>
    <div class="flex gap-8" style="margin-top:10px;">
      <span class="feed-like-anim" style="display:inline-flex;">${feedLikeButtonHtml(p.id)}</span>
      <button class="wish-btn feed-share-anim" onclick="event.stopPropagation(); shareFeedPost('${p.id}')" style="position:static;background:var(--card);width:auto;border-radius:16px;padding:6px 12px;display:inline-flex;align-items:center;gap:5px;" aria-label="Share">
        ${icon('share')}<span class="small" style="line-height:1;font-weight:600;">Share</span>
      </button>
    </div>
    <div style="font-size:14px;line-height:1.7;margin-top:6px;">${formatFeedText(p.body)}</div>
    ${linkedProducts.length?`<div class="section" style="margin-top:16px;">
      ${linkedProducts.map(linked=>`<div class="card" style="padding:14px;margin-bottom:10px;cursor:pointer;" onclick="navigate('#product/${linked.id}')">
      <div class="flex gap-8" style="align-items:center;">
        <img src="${cldOptimize(linked.image, 100)}" loading="lazy" style="width:52px;height:52px;border-radius:10px;object-fit:cover;">
        <div><div style="font-weight:600;font-size:13.5px;">${escapeHtml(linked.name)}</div><div class="text-2 small">${fmtPrice(linked.salePrice||linked.price)} · Tap to view →</div></div>
      </div>
    </div>`).join('')}
    </div>`:''}
    ${related.length?`<div class="section" style="margin-top:20px;">
      <div class="section-head"><h2>Related updates</h2></div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${related.map(rp=>{
          const cover = (rp.media||[])[0];
          const isVideo = cover && cover.type==='video';
          return `<div class="card" style="overflow:hidden;cursor:pointer;display:flex;gap:12px;padding:10px;align-items:center;" onclick="navigate('#feed/${rp.id}')">
            <div style="width:56px;height:56px;flex:none;border-radius:9px;overflow:hidden;background:var(--surface);">
              ${cover?(isVideo
                ? `<video src="${cldOptimize(cover.url, 160)}" preload="none" muted playsinline style="width:100%;height:100%;object-fit:cover;"></video>`
                : `<img src="${cldOptimize(cover.url, 160)}" alt="" loading="lazy" style="width:100%;height:100%;object-fit:cover;">`)
                : ''}
            </div>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(rp.title)}</div>
              <div class="text-2 small">${rp.date?new Date(rp.date).toLocaleDateString():''}</div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`:''}
  </div>`;
}

/* ---------------- PRODUCTS (catalog) ---------------- */
function filteredProducts(){
  const f = appState.productFilters;
  let list = DB.products.filter(p=>p.status!=='draft');
  if(f.category !== 'all') list = list.filter(p=>p.categoryId===f.category || p.category===f.category);
  if(f.kind==='digital') list = list.filter(p=>productKind(p)!=='physical');
  if(f.kind==='physical') list = list.filter(p=>productKind(p)==='physical');
  if(f.kind==='free') list = list.filter(isFreeProduct);
  if(f.price==='u10') list = list.filter(p=>(p.salePrice||p.price) < 10);
  if(f.price==='10-50') list = list.filter(p=>{ const pr=p.salePrice||p.price; return pr>=10 && pr<=50; });
  if(f.price==='50p') list = list.filter(p=>(p.salePrice||p.price) > 50);
  if(f.price==='custom'){
    const min = f.priceMin!=null ? Number(f.priceMin) : null;
    const max = f.priceMax!=null ? Number(f.priceMax) : null;
    list = list.filter(p=>{
      const pr = p.salePrice||p.price||0;
      if(min!=null && !isNaN(min) && pr < min) return false;
      if(max!=null && !isNaN(max) && pr > max) return false;
      return true;
    });
  }
  if(f.q) list = list.filter(p=>productSearchText(p).includes(f.q.toLowerCase().trim()));
  if(f.sort==='popular') list = list.sort((a,b)=>b.reviewCount-a.reviewCount);
  if(f.sort==='newest') list = list.slice().reverse();
  if(f.sort==='cheap') list = list.sort((a,b)=>(a.salePrice||a.price)-(b.salePrice||b.price));
  if(f.sort==='rated') list = list.sort((a,b)=>b.rating-a.rating);
  return list;
}
function productSearchText(p){
  const category=(DB.categories||[]).find(c=>c.id===p.categoryId);
  const specs=Object.entries(p.specs||{}).flatMap(([key,value])=>[key,value]);
  const options=Array.isArray(p.options)?p.options.flatMap(option=>[option.name,...(option.values||[]) ]):[];
  const variants=Array.isArray(p.variants)?p.variants.flatMap(variant=>[variant.title,variant.sku,variant.name,...Object.values(variant.options||{})]):[];
  return [p.name,p.shortDescription,p.description,p.heroCopy,p.categoryName,p.format,p.level,p.productType,category&&category.name,productKind(p),...(p.tags||[]),...(p.searchKeywords||[]),...specs,...options,...variants].filter(Boolean).join(' ').toLowerCase();
}
function setDiscoveryKind(kind){appState.productFilters.kind=kind;rerenderProductList();}
function screenProducts(){
  const cats = DB.categories;
  const f = appState.productFilters;
  const list = filteredProducts();
  return `
  <div class="screen">
    <h1 class="screen-title">Find what you need</h1>
    <p class="screen-sub">Browse free resources, digital tools, services and physical products in one clear catalog.</p>
    <div class="header-search" style="margin:0 0 14px;">
      <span>🔍</span>
      <input type="search" aria-label="Search the Lexden Nova catalog" placeholder="Search names, formats, specs and categories..." value="${escapeHtml(f.q)}" oninput="appState.productFilters.q=this.value; rerenderProductList();" id="searchInput">
    </div>
    <div class="filter-bar">
      <div class="chip-row" id="kindChips" aria-label="Filter by product format">
        ${[['all','Everything'],['digital','Digital & services'],['physical','Physical products'],['free','Free']].map(([value,label])=>`<button class="chip ${f.kind===value?'active':''}" aria-pressed="${f.kind===value}" onclick="setDiscoveryKind('${value}')">${label}</button>`).join('')}
      </div>
      <div class="chip-row" id="catChips">
        ${cats.map(c=>`<button class="chip ${f.category===c.id?'active':''}" aria-pressed="${f.category===c.id}" onclick="setCategoryFilter('${c.id}')">${escapeHtml(c.name)}</button>`).join('')}
      </div>
      <div class="filter-row" id="priceFilterRow" style="position:relative;">
        ${priceFilterRowInnerHtml(f)}
      </div>
    </div>
    <div id="productListWrap">${productListOrEmpty(list)}</div>
  </div>`;
}
function priceFilterRowInnerHtml(f){
  return `
        <button class="select-pill" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px;" onclick="event.stopPropagation();togglePriceFilterPopover()">
          ${priceFilterLabel(f)} <span style="font-size:9px;">▾</span>
        </button>
        ${appState.priceFilterOpen ? priceFilterPopoverHtml(f) : ''}
        ${customSelect('sortSelect', f.sort, [
          {value:'popular',label:'Popular'},
          {value:'newest',label:'Newest'},
          {value:'cheap',label:'Cheapest'},
          {value:'rated',label:'Highest rated'}
        ], '', v=>{ appState.productFilters.sort=v; rerenderProductList(); }, true)}
        <span class="text-2 small" style="margin-left:auto;">${filteredProducts().length} items</span>`;
}
// Human-readable label for the price pill button — shows the actual
// custom numbers when a custom range is active, instead of a generic
// "Custom" that hides what's applied.
function priceFilterLabel(f){
  if(f.price==='custom'){
    const min = f.priceMin, max = f.priceMax;
    if(min!=null && max!=null) return `${fmtPrice(min)}–${fmtPrice(max)}`;
    if(min!=null) return `${fmtPrice(min)}+`;
    if(max!=null) return `Under ${fmtPrice(max)}`;
  }
  return 'Any price';
}
// Custom price-range control — built entirely from ordinary divs/buttons/
// number inputs rather than a native <select>/<input type=range>, per
// request, so it can be styled and positioned like the rest of the app's
// UI instead of inheriting the OS/browser's own picker chrome. Simplified
// per request to just Min/Max — the old preset chips (Under $10, $10-$50,
// $50+) are gone; a shopper types their own range instead.
function priceFilterPopoverHtml(f){
  return `
  <div class="card" style="position:absolute;top:calc(100% + 6px);left:0;z-index:60;padding:14px;width:240px;box-shadow:var(--shadow-card);" onclick="event.stopPropagation();">
    <div class="text-2 small" style="font-weight:600;margin-bottom:6px;">Price range <span style="font-weight:400;">(${escapeHtml(currentCurrencySymbol().trim())})</span></div>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;">
      <input type="number" inputmode="decimal" min="0" step="0.01" id="priceMinInput" placeholder="Min ${escapeHtml(currentCurrencySymbol().trim())}" value="${f.priceMin!=null?round2(f.priceMin*currentRate()):''}"
        style="width:0;flex:1;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:8px 10px;color:var(--text);font-size:13px;">
      <span class="text-2">–</span>
      <input type="number" inputmode="decimal" min="0" step="0.01" id="priceMaxInput" placeholder="Max ${escapeHtml(currentCurrencySymbol().trim())}" value="${f.priceMax!=null?round2(f.priceMax*currentRate()):''}"
        style="width:0;flex:1;background:var(--card);border:1px solid var(--border);border-radius:10px;padding:8px 10px;color:var(--text);font-size:13px;">
    </div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-primary btn-sm" style="flex:1;" onclick="applyCustomPriceRange()">Apply</button>
      <button class="btn btn-ghost btn-sm" onclick="clearPriceFilter()">Clear</button>
    </div>
  </div>`;
}
function togglePriceFilterPopover(){
  appState.priceFilterOpen = !appState.priceFilterOpen;
  rerenderProductList();
}
function clearPriceFilter(){
  appState.productFilters.price = 'all';
  appState.productFilters.priceMin = null;
  appState.productFilters.priceMax = null;
  appState.priceFilterOpen = false;
  rerenderProductList();
}
function applyCustomPriceRange(){
  const minEl = $('#priceMinInput'), maxEl = $('#priceMaxInput');
  // Whatever the shopper types is in THEIR current display currency (that's
  // what the input placeholders/label now show) — not USD. Product prices
  // are stored internally in USD (see fmtPrice), so we convert the entered
  // numbers back to USD here using the same rate fmtPrice uses, before
  // comparing/storing. Validate min>max on the raw entered numbers first
  // (same currency, so the ordering is unaffected by the conversion).
  const rate = currentRate();
  const minEntered = minEl && minEl.value!=='' ? parseFloat(minEl.value) : null;
  const maxEntered = maxEl && maxEl.value!=='' ? parseFloat(maxEl.value) : null;
  if(minEntered!=null && maxEntered!=null && minEntered > maxEntered){
    toast('Min price can\'t be higher than max');
    return;
  }
  const min = (minEntered!=null && !isNaN(minEntered)) ? minEntered / rate : null;
  const max = (maxEntered!=null && !isNaN(maxEntered)) ? maxEntered / rate : null;
  appState.productFilters.price = (min==null && max==null) ? 'all' : 'custom';
  appState.productFilters.priceMin = min;
  appState.productFilters.priceMax = max;
  appState.priceFilterOpen = false;
  rerenderProductList();
}
function productListOrEmpty(list){
  if(!list.length && catalogIsLoading() && !DB.products.length){
    return `<div class="grid-products">${skeletonCards(6)}</div>`;
  }
  if(!list.length && window.__catalogFailed && !DB.products.length){
    return `<div class="empty-state"><div class="ic">${icon('search')}</div><h3>Could not load products</h3><p>Check your connection and try again.</p><button class="btn btn-outline" onclick="location.reload()">Try again</button></div>`;
  }
  if(!list.length){
    return `<div class="empty-state"><div class="ic">${icon('search')}</div><h3>No products found</h3><p>Try adjusting your filters or search terms.</p><button class="btn btn-outline" onclick="resetProductFilters()">Reset filters</button></div>`;
  }
  return `<div class="grid-products">${list.map(p=>productCard(p)).join('')}</div>`;
}
function setCategoryFilter(id){ appState.productFilters.category = id; rerenderProductList(); }
function resetProductFilters(){ appState.productFilters = {category:'all',kind:'all',price:'all',priceMin:null,priceMax:null,sort:'popular',q:''}; render(); }
function rerenderProductList(){
  const wrap = $('#productListWrap');
  if(wrap) wrap.innerHTML = productListOrEmpty(filteredProducts());
  const chips = $('#catChips');
  if(chips) chips.innerHTML = DB.categories.map(c=>`<button class="chip ${appState.productFilters.category===c.id?'active':''}" aria-pressed="${appState.productFilters.category===c.id}" onclick="setCategoryFilter('${c.id}')">${escapeHtml(c.name)}</button>`).join('');
  const kinds = $('#kindChips');
  if(kinds) kinds.innerHTML = [['all','Everything'],['digital','Digital & services'],['physical','Physical products'],['free','Free']].map(([value,label])=>`<button class="chip ${appState.productFilters.kind===value?'active':''}" aria-pressed="${appState.productFilters.kind===value}" onclick="setDiscoveryKind('${value}')">${label}</button>`).join('');
  const si = $('#searchInput');
  if(si && document.activeElement !== si) si.value = appState.productFilters.q;
  const priceRow = $('#priceFilterRow');
  if(priceRow) priceRow.innerHTML = priceFilterRowInnerHtml(appState.productFilters);
}
// Downscales + re-encodes a profile-picture file client-side before it's
// uploaded — phone camera photos are routinely several MB, which is why
// avatar uploads kept stalling/"failing" repeatedly on a slow mobile
// connection (visible upload speeds as low as ~2-8 KB/s make an 8MB photo
// take the better part of an hour, well past any sane timeout). Shrinking
// to at most maxDim on the longest side and re-encoding as JPEG typically
// takes a multi-MB photo down to well under 200KB, which uploads reliably
// even on a very slow connection. Falls back to the original, untouched
// file if anything about the resize itself goes wrong (unsupported
// format, canvas failure, etc.) so a resize bug can never be the reason a
// photo doesn't upload at all.
function resizeAvatarImage(file, maxDim, quality){
  maxDim = maxDim || 640; quality = quality || 0.82;
  return new Promise(resolve=>{
    if(!file || !file.type || !file.type.startsWith('image/') || file.type==='image/svg+xml'){ resolve(file); return; }
    const reader = new FileReader();
    reader.onload = e=>{
      const img = new Image();
      img.onload = ()=>{
        try{
          const { width, height } = img;
          if(width<=maxDim && height<=maxDim){ resolve(file); return; }
          const scale = maxDim / Math.max(width, height);
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(width*scale);
          canvas.height = Math.round(height*scale);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(blob=>{
            if(!blob){ resolve(file); return; }
            resolve(new File([blob], (file.name||'avatar').replace(/\.\w+$/,'')+'.jpg', {type:'image/jpeg'}));
          }, 'image/jpeg', quality);
        }catch(e){ console.warn('Avatar resize failed, uploading original', e); resolve(file); }
      };
      img.onerror = ()=>resolve(file);
      img.src = e.target.result;
    };
    reader.onerror = ()=>resolve(file);
    reader.readAsDataURL(file);
  });
}

/* ---------------- PRODUCT DETAIL ---------------- */
// Honest stock messaging for physical products — never claims "In stock"
// unless the admin actually set that status (roadmap/physical-commerce
// doc rule: "Do not falsely display IN STOCK unless stock information
// supports it"). Digital/Service products never call this at all.
function physicalStockBlock(p){
  const ph = p.physical || {};
  const statusMap = {
    in_stock: { label: '✅ In stock', color: 'var(--success, #2ecc71)' },
    low_stock: { label: '⚠️ Low stock', color: '#e2a53a' },
    out_of_stock: { label: '❌ Out of stock', color: '#e05a5a' },
    preorder: { label: '🕒 Available for pre-order', color: 'var(--accent)' },
  };
  const st = statusMap[ph.stockStatus] || statusMap.out_of_stock;
  return `<div class="text-2 small" style="margin-top:8px;display:flex;flex-direction:column;gap:2px;">
    <span style="color:${st.color};font-weight:600;">${st.label}</span>
    ${ph.deliveryEstimate ? `<span>🚚 Estimated delivery: ${escapeHtml(ph.deliveryEstimate)}</span>` : ''}
  </div>`;
}
function formatStructuredProductText(text){
  const raw=String(text||'').trim();
  if(!raw)return '';
  return raw.split(/\n\s*\n/).map(paragraph=>{
    const lines=paragraph.split('\n').map(line=>line.trim()).filter(Boolean);
    if(lines.length>1 && lines.every(line=>/^[-•*]|^\d+[.)]/.test(line))){
      return '<ul style="margin:6px 0 0 18px;">'+lines.map(line=>'<li>'+escapeHtml(line.replace(/^[-•*]\s*|^\d+[.)]\s*/,''))+'</li>').join('')+'</ul>';
    }
    return '<p class="text-2" style="font-size:13.5px;line-height:1.7;margin:0 0 10px;">'+lines.map(escapeHtml).join('<br>')+'</p>';
  }).join('');
}
function structuredProductSections(p){
  const isCourseDetails=isCourseProduct(p) && p.productType!=='PHYSICAL' && p.productType!=='SERVICE';
  const courseOnlyTitles=new Set(['Who this is for','Who this is not for','What you will learn','Course contents','Delivery format','Duration and pace','Requirements','Tools','Assignments and assessment','Capstone / final project','Certificate and completion']);
  const sections=[
    ['Who this is for',p.audienceFor],
    ['Who this is not for',p.audienceNotFor],
    ['What you will learn',p.learningOutcomes],
    ['Course contents',p.courseContents],
    ['Delivery format',p.deliveryFormat],
    ['Duration and pace',p.durationNote],
    ['Requirements',p.requirements],
    ['Tools',p.tools],
    ['Assignments and assessment',p.assignmentsDetails],
    ['Capstone / final project',p.capstoneDetails],
    ['Certificate and completion',p.certificateDetails],
    ['Access and delivery',p.accessDelivery],
    ['Support',p.supportWording],
    ['Refund policy',p.refundPolicy],
    ['Compliance disclaimer',p.complianceDisclaimer],
    ['Earnings / results disclaimer',p.earningsDisclaimer],
  ].filter(([title,value])=>String(value||'').trim() && (isCourseDetails || !courseOnlyTitles.has(title)));
  const body=sections.map(([title,value])=>`<div class="detail-block"><h3>${escapeHtml(title)}</h3>${formatStructuredProductText(value)}</div>`).join('');
  const faqs=Array.isArray(p.productFaqs)?p.productFaqs.filter(f=>f&&f.q&&f.a):[];
  const faqHtml=faqs.length?`<div class="detail-block"><h3>Frequently asked questions</h3>${faqs.map((f,i)=>`<details style="border-top:1px solid var(--border);padding:10px 0;" ${i===0?'open':''}><summary style="cursor:pointer;font-weight:650;font-size:13.5px;">${escapeHtml(f.q)}</summary><div style="margin-top:7px;">${formatStructuredProductText(f.a)}</div></details>`).join('')}</div>`:'';
  return body+faqHtml;
}
function screenProductDetail(id){
  const p = findProduct(id);
  if(!p){
    return `<div class="screen"><div class="empty-state"><div class="ic">${icon('package')}</div><h3>Product not found</h3><p>It may have been removed.</p><button class="btn btn-primary" onclick="navigate('#products')">Back to Products</button></div></div>`;
  }
  const hasSale = p.salePrice && p.salePrice < p.price;
  const related = computeRelatedProducts(p, DB.products, {limit:12, shopperProfile: shopperProfile()})
    .filter(item => item.categoryId === p.categoryId && productKind(item) === productKind(p)).slice(0,6);
  const reviews = DB.testimonials.filter(t=>t.productId===p.id);
  const stats = liveRatingStats(p);
  const c = DB.content;
  const selectedVariant = getSelectedProductVariant(p);
  const selectedBasePrice = selectedVariant&&typeof selectedVariant.price==='number'?selectedVariant.price:p.price;
  const selectedSalePrice = selectedVariant&&typeof selectedVariant.salePrice==='number'&&selectedVariant.salePrice<selectedBasePrice?selectedVariant.salePrice:(selectedVariant?null:(hasSale?p.salePrice:null));
  const selectedEffectivePrice = selectedSalePrice!==null?selectedSalePrice:selectedBasePrice;
  const selectedDiscount = selectedSalePrice!==null&&selectedBasePrice>0?Math.round((1-selectedSalePrice/selectedBasePrice)*100):0;
  const media = productMedia(p);
  if(selectedVariant&&selectedVariant.image&&!media.some(item=>item.url===selectedVariant.image))media.unshift({url:selectedVariant.image,type:'image',alt:variantLabel(p,selectedVariant)});
  const main = media[0] || {url:p.image, type:'image'};
  const descLong = (p.description||'').length > 220;
  const detailSpecs = Object.entries(p.specs||{}).filter(([key])=>{
    const normalizedKey=String(key||'').trim().toLowerCase();
    if(p.productType==='PHYSICAL' && ['format','level'].includes(normalizedKey)) return false;
    if(normalizedKey==='level' && !isCourseProduct(p)) return false;
    if(normalizedKey==='format' && p.productType==='SERVICE') return false;
    if(['condition','warranty'].includes(normalizedKey) && p.productType!=='PHYSICAL') return false;
    return true;
  });
  return `
  <div class="screen" style="position:relative;">
    <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:10px;">
      <button class="btn btn-ghost btn-sm" onclick="history.back()">← Back</button>
      <div class="flex gap-8">
        <button class="wish-btn" onclick="shareProduct('${p.id}')" style="position:static;background:var(--card);" aria-label="Share">${icon('share')}</button>
        <button class="wish-btn ${isWished(p.id)?'active':''}" data-wish-id="${p.id}" onclick="toggleWish('${p.id}')" style="position:static;background:var(--card);">${icon(isWished(p.id)?'heartFill':'heart')}</button>
      </div>
    </div>
    <div class="product-detail-main">
    <div class="pd-gallery-column">
    <div class="pd-media" id="pdMediaMain">${mediaHtml(main, true)}</div>
    ${media.length>1?`<div class="hscroll" style="margin-bottom:16px;">
      ${media.map((m,i)=>`<div class="pd-thumb" onclick="setActiveMedia('${p.id}',${i})">
        ${m.type==='image'?`<img src="${cldOptimize(m.url, 160)}" alt="" loading="lazy">`:`<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;color:#fff;font-size:18px;">▶</div>`}
      </div>`).join('')}
    </div>`:''}
    </div>
    <div class="pd-summary-column">
    <div class="card" style="padding:16px;margin-bottom:4px;">
      <div class="flex" style="align-items:baseline;gap:8px;flex-wrap:wrap;">
        <span class="pd-price" id="pdCurrentPrice">${selectedEffectivePrice===0?'Free':fmtPrice(selectedEffectivePrice)}</span>
        ${selectedSalePrice!==null?`<span class="pd-old" id="pdOldPrice">${fmtPrice(selectedBasePrice)}</span>`:''}
        ${selectedDiscount>0?`<span class="chip" id="pdDiscountBadge" style="background:var(--accent-2);color:#fff;">-${selectedDiscount}% OFF</span>`:''}
      </div>
      <div class="flex gap-8 mt-8" style="align-items:center;">
        ${stats.count
          ? `<span class="stars">${starString(stats.rating)}</span><span class="text-2 small">(${stats.count} review${stats.count===1?'':'s'})</span>`
          : `<span class="text-2 small">No reviews yet — be the first!</span>`}
      </div>
      <h2 style="font-size:19px;margin-top:10px;">${escapeHtml(p.name)}</h2>
      ${p.heroCopy?`<p style="font-size:14.5px;font-weight:650;line-height:1.55;margin-top:6px;">${escapeHtml(p.heroCopy)}</p>`:''}
      ${p.shortDescription?`<p class="text-2" style="font-size:13px;line-height:1.6;margin-top:6px;">${escapeHtml(p.shortDescription)}</p>`:''}
      <p class="text-2 ${descLong?'pd-desc-clamped':''}" id="pdDesc" style="font-size:13.5px;margin-top:6px;">${escapeHtml(p.description)}</p>
      ${descLong?`<button class="btn-sm btn-ghost" id="pdDescToggle" style="padding:2px 0;color:var(--accent);" onclick="toggleDescExpand()">See more</button>`:''}
      <div class="chip-row mt-8">${(p.tags||[]).map(t=>`<span class="chip">${escapeHtml(t)}</span>`).join('')}</div>
      ${productVariantSelector(p)}
      ${p.fileUrl && !isFreeProduct(p) ? `<div class="text-2 small" style="margin-top:8px;">📄 Instant PDF download the moment payment is confirmed</div>` : ''}
      ${p.productType==='PHYSICAL' ? physicalStockBlock(p) : ''}
    </div>

    ${productExperiencePanel(p)}
    </div>
    </div>

    <div class="detail-block">
      <h3>Details</h3>
      ${detailSpecs.map(([k,v])=>`<div class="spec-row"><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></div>`).join('')}
      <div class="spec-row"><span>Item code</span><span class="mono">${p.itemCode} <button class="btn-sm btn-ghost" style="padding:2px 6px;" onclick="copyCode('${p.itemCode}')">copy</button></span></div>
      ${p.productType==='PHYSICAL' && p.physical ? `
        ${p.physical.weight?`<div class="spec-row"><span>Weight</span><span>${escapeHtml(p.physical.weight)}</span></div>`:''}
        ${p.physical.dimensions?`<div class="spec-row"><span>Dimensions</span><span>${escapeHtml(p.physical.dimensions)}</span></div>`:''}
        ${p.physical.returnPolicy?`<div class="spec-row"><span>Returns</span><span>${escapeHtml(p.physical.returnPolicy)}</span></div>`:''}
        ${(p.physical.shippingCountries||[]).length?`<div class="spec-row"><span>Ships to</span><span>${escapeHtml((p.physical.shippingCountries||[]).join(', '))}</span></div>`:''}
      `:''}
    </div>

    ${structuredProductSections(p)}

    <div class="detail-block">
      <h3>About the seller</h3>
      <div class="flex gap-8" style="align-items:center;">
        <div class="avatar">${(p.seller||'LN').slice(0,2).toUpperCase()}</div>
        <div><div style="font-weight:600;font-size:13.5px;">${escapeHtml(p.seller||'Lexden Partner')}</div>${p._creator && sellerHash(p._creator) ? `<a href="${sellerHash(p._creator)}" style="color:var(--accent);font-size:12.5px;">View seller page →</a>` : ''}${hasAdminAffiliateLink(p) ? '<div class="text-2 small">Verified affiliate partner</div>' : ''}</div>
      </div>
    </div>

    ${related.length?`<div class="section" style="margin-top:20px;">
      <div class="section-head"><h2>Related products</h2></div>
      <div class="hscroll">${related.map(r=>productCard(r,{small:true})).join('')}</div>
    </div>`:''}

    <div class="detail-block">
      <div class="flex" style="justify-content:space-between;align-items:center;">
        <h3 style="margin:0;">Reviews (${reviews.length})</h3>
        <button class="btn btn-outline btn-sm" onclick="toggleReviewForm()">Add review</button>
      </div>
      <div id="reviewFormWrap"></div>
      ${reviews.length? reviews.slice(0,3).map(r=>`
        <div class="review-card">
          <div class="avatar">${r.name.slice(0,2).toUpperCase()}</div>
          <div>
            <div class="flex gap-8" style="align-items:center;"><strong style="font-size:13.5px;">${escapeHtml(r.name)}</strong><span class="stars" style="font-size:11px;">${'★'.repeat(r.rating)}${'☆'.repeat(5-r.rating)}</span></div>
            <p class="text-2" style="font-size:13px;margin-top:2px;">${escapeHtml(r.text)}</p>
            <span class="small text-2">${r.date}</span>
          </div>
        </div>`).join('') : `<p class="text-2 small" style="padding:12px 0;">No reviews yet — be the first!</p>`}
    </div>

    <div style="height:70px;"></div>
    <div class="sticky-buy">
      <div style="flex:1;">
        <div class="small text-2">Price</div>
        <div id="pdStickyPrice" style="font-weight:700;font-size:16px;">${selectedVariant?priceLabel({...p,variants:[],price:effectiveVariantPrice(p,selectedVariant),salePrice:null}):priceLabel(p)}</div>
      </div>
      <div id="pdStickyAction" style="flex:2;">${stickyPurchaseActionHtml(p,selectedVariant)}</div>
    </div>
  </div>`;
}
function setActiveMedia(productId, idx){
  const p = findProduct(productId);
  if(!p) return;
  const m = productMedia(p)[idx];
  if(!m) return;
  const wrap = $('#pdMediaMain');
  if(!wrap) return;
  wrap.innerHTML = mediaHtml(m, true);
}
function toggleDescExpand(){
  const desc = $('#pdDesc');
  const btn = $('#pdDescToggle');
  if(!desc || !btn) return;
  const expanded = desc.classList.toggle('pd-desc-clamped') === false;
  btn.textContent = expanded ? 'See less' : 'See more';
}
function copyCode(code){
  navigator.clipboard?.writeText(code).then(()=>toast('Copied to clipboard','success')).catch(()=>toast('Could not copy','error'));
}
function toggleReviewForm(){
  // BUGFIX: this used to check window.__fbUid, which is also set for an
  // anonymous browsing session (the app auto-signs everyone in anonymously
  // on load) — so it let anyone open the form without really being signed
  // in, and then asked them to type their own email to make up for not
  // actually knowing who they were. window.__fbShopper is only ever set
  // for a real Google or email/password account, so checking that both
  // fixes the gate AND gives us the name/email to use automatically.
  const shopper = window.__fbShopper;
  if(!shopper){
    showSignInPromptModal('Sign in to add a review so we know it\'s really you.');
    return;
  }
  const wrap = $('#reviewFormWrap');
  if(!wrap) return;
  if(wrap.innerHTML){ wrap.innerHTML=''; return; }
  wrap.innerHTML = `
    <div class="card" style="padding:14px;margin:10px 0;">
      <div class="text-2 small" style="margin-bottom:8px;">Posting as ${escapeHtml(((shopper.name||'').trim().split(/\s+/)[0]) || shopper.email)}</div>
      <div class="form-field"><label>Rating</label>
        ${customSelect('revRating','5',[
          {value:'5',label:'★★★★★'},{value:'4',label:'★★★★☆'},{value:'3',label:'★★★☆'},{value:'2',label:'★★☆'},{value:'1',label:'★☆'}
        ], '')}
      </div>
      <div class="form-field"><label>Review</label><textarea id="revText" placeholder="Share your experience..."></textarea></div>
      <button class="btn btn-primary btn-sm" onclick="submitReview()">Submit review</button>
    </div>`;
}
function submitReview(){
  const shopper = window.__fbShopper;
  if(!shopper){ showSignInPromptModal('Sign in to add a review so we know it\'s really you.'); return; }
  const text = $('#revText')?.value.trim();
  const rating = Number($('#revRating')?.value||5);
  if(!text){ toast('Please write your review before submitting','error'); return; }
  const pid = location.hash.split('/')[1];
  const list = DB.testimonials;
  // Name/email always come from the signed-in profile now — never typed.
  const name = ((shopper.name||'').trim().split(/\s+/)[0]) || shopper.email.split('@')[0];
  const t = {id:'t'+Date.now(), productId:pid, name, email:shopper.email, rating, text, date:new Date().toISOString().slice(0,10)};
  list.unshift(t);
  DB.testimonials = list;
  pushReviewToCloud(t);
  toast('Review submitted — thank you!','success');
  render();
}

/* ---------------- SERVICE ---------------- */
function screenService(){
  const c = DB.content;
  const services = DB.services;
  const steps = [
    {n:1, title:'Browse', desc:'Explore courses, templates, software & bundles.'},
    {n:2, title:'Choose', desc:'Compare ratings, price and reviews.'},
    {n:3, title:'Pay', desc:'Checkout securely with our partner.'},
    {n:4, title:'Learn', desc:'Get instant access and start using it.'},
  ];
  return `
  <div class="screen">
    <h1 class="screen-title">Our Services</h1>
    <p class="screen-sub">What you get with LEXDEN NOVA</p>
    <div class="section">
      ${services.map(s=>`<div class="card service-card"><div class="sic">${s.ic}</div><div><h3 style="font-size:14.5px;margin-bottom:3px;">${s.title}</h3><p class="text-2 small">${s.desc}</p></div></div>`).join('')}
    </div>
    <div class="section">
      <div class="section-head"><h2>How it works</h2></div>
      <div class="steps-grid">
        ${steps.map(s=>`<div class="card step-card"><div class="step-num">${s.n}</div><h3 style="font-size:13.5px;margin-bottom:4px;">${s.title}</h3><p class="text-2 small">${s.desc}</p></div>`).join('')}
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>FAQ</h2></div>
      <div class="card" style="padding:4px 16px;">
        ${DB.faqs.map(f=>`
          <div class="faq-item" id="faq-${f.id}">
            <div class="faq-q" onclick="toggleFaq('${f.id}')"><span>${escapeHtml(f.q)}</span><span class="chev">⌄</span></div>
            <div class="faq-a">${escapeHtml(f.a)}</div>
          </div>`).join('')}
      </div>
    </div>
    <div class="card" style="padding:22px;text-align:center;">
      <h3 style="margin-bottom:6px;">Still have questions?</h3>
      <p class="text-2 small" style="margin-bottom:14px;">We usually reply within a few hours.</p>
      <a class="btn btn-primary" target="_blank" rel="noopener" href="https://wa.me/${c.whatsappNumber.replace(/^0/,'234')}">Contact us on WhatsApp</a>
    </div>
  </div>`;
}
function toggleFaq(id){
  const el = $('#faq-'+id);
  if(el) el.classList.toggle('open');
}

/* ---------------- WISHLIST ---------------- */
function wishlistProducts(){
  const ids = DB.wishlist;
  let list = DB.products.filter(p=>ids.includes(p.id));
  const s = appState.wishlistSort;
  if(s==='price-low') list = list.sort((a,b)=>(a.salePrice||a.price)-(b.salePrice||b.price));
  if(s==='price-high') list = list.sort((a,b)=>(b.salePrice||b.price)-(a.salePrice||a.price));
  if(s==='rating') list = list.sort((a,b)=>b.rating-a.rating);
  return list;
}
function screenWishlist(){
  const list = wishlistProducts();
  return `
  <div class="screen">
    <div class="flex" style="justify-content:space-between;align-items:center;">
      <h1 class="screen-title">Saved Items</h1>
      ${customSelect('wishlistSortSelect', appState.wishlistSort, [
        {value:'newest',label:'Newest'},
        {value:'price-low',label:'Price: low → high'},
        {value:'price-high',label:'Price: high → low'},
        {value:'rating',label:'Rating'}
      ], '', v=>{ appState.wishlistSort=v; rerenderWishlist(); }, true)}
    </div>
    <div id="wishlistWrap">${wishlistListOrEmpty(list)}</div>
    ${list.length?`
    <div class="flex gap-8 mt-16" style="flex-wrap:wrap;">
      <button class="btn btn-outline btn-sm" onclick="exportWishlist()">💾 Save all to file</button>
      <button class="btn btn-outline btn-sm" onclick="shareWishlist()">🔗 Share wishlist</button>
      <button class="btn btn-danger btn-sm" onclick="clearWishlist()">🗑️ Clear all</button>
    </div>`:''}
  </div>`;
}
function wishlistListOrEmpty(list){
  if(!list.length){
    return `<div class="empty-state"><div class="ic">${icon('heart')}</div><h3>No saved items yet</h3><p>Tap the heart on any product to save it here.</p><button class="btn btn-primary" onclick="navigate('#products')">Browse Products</button></div>`;
  }
  return `<div class="grid-products">${list.map(p=>productCard(p)).join('')}</div>`;
}
function rerenderWishlist(){ const w=$('#wishlistWrap'); if(w) w.innerHTML = wishlistListOrEmpty(wishlistProducts()); }
function exportWishlist(){
  const data = JSON.stringify(wishlistProducts(), null, 2);
  const blob = new Blob([data], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'lexden-nova-wishlist.json'; a.click();
  toast('Wishlist exported','success');
}
function shareWishlist(){
  const ids = DB.wishlist.join(',');
  const url = location.origin + location.pathname + '#wishlist?ids=' + ids;
  navigator.clipboard?.writeText(url).then(()=>toast('Share link copied','success')).catch(()=>toast(url));
}
// Generic share helper backing the Share buttons on product and feed
// pages. navigator.share() hands off to the device's native share sheet —
// WhatsApp, Messages, Email, whatever the person picks — with the message
// text and link bundled together, which is what "send it to whoever I
// want" actually needs; a plain copied link can't carry a message with it.
// Falls back to copying "text + link" to the clipboard on browsers/desktops
// without share-sheet support (e.g. most desktop browsers).
//
// BUGFIX: this used to also attach the product/post image as a File when
// the share target supported it. Most share targets (WhatsApp included)
// then show that raw attached image INSTEAD of a link preview — which
// looks like a random photo landing in the chat with no card, no title,
// no description, nothing tappable. What the app actually wants is the
// rich link-preview card WhatsApp/etc. build themselves from this page's
// og:title/og:description/og:image tags the moment a real URL is present
// in the shared text — exactly what you get sharing the site's own link.
// So `imageUrl` is intentionally unused now; we always share {title, text,
// url} and let the target app generate that preview card.
async function shareContent(title, text, url, imageUrl){
  const shareData = { title, text, url };
  try{
    if(navigator.share && (!navigator.canShare || navigator.canShare(shareData))){
      await navigator.share(shareData);
      return;
    }
  }catch(e){
    if(e && e.name === 'AbortError') return; // person cancelled the share sheet — not an error
  }
  try{
    await navigator.clipboard.writeText(`${text}`);
    toast('Link copied — paste it anywhere to share','success');
  }catch(e){
    toast('Could not open share menu — copy the link from your address bar instead','error');
  }
}
// Best-effort: turns an image URL into a File the native share sheet can
// attach as a thumbnail. Cloudinary's delivery URLs are public/CORS-open so
// this normally succeeds, but it degrades to a text-only share (never a
// failure) if the fetch is blocked or the browser can't share files.
async function urlToShareFile(url, filename){
  if(!url) return null;
  try{
    const res = await fetch(url);
    if(!res.ok) return null;
    const blob = await res.blob();
    return new File([blob], filename || 'share.jpg', { type: blob.type || 'image/jpeg' });
  }catch(e){ return null; }
}
// WhatsApp, Telegram and most chat apps render *text* as bold in plain
// message text (there's no separate "bold" share field to set) — this
// wraps a title so it shows up bold wherever the message lands.
function boldForShare(text){ return `*${String(text||'').replace(/\*/g,'')}*`; }
function shareProduct(id){
  const p = findProduct(id);
  if(!p) return;
  const url = publicProductUrl(p);
  const message = `${boldForShare(p.name)} on ${DB.content.appName||'our store'} — ${priceLabel(p)}\n\nLearn more: ${url}`;
  // Local + shared aggregate counter — feeds trendingScore() below, same
  // pattern as views/wishlists/clicks. Counted on tap (consistent with how
  // trackProductClick counts a tap, not a confirmed downstream action),
  // since navigator.share()'s own promise doesn't reliably resolve/reject
  // the same way across every browser and share target.
  const counts = {...DB.productShareCounts};
  counts[id] = (counts[id]||0) + 1;
  DB.productShareCounts = counts;
  pushProductShareCountToCloud(id);
  shareContent(p.name, message, url, p.image ? cldOptimize(p.image, 800) : null);
}
function shareFeedPost(id){
  const p = DB.feed.find(x=>x.id===id);
  if(!p) return;
  const url = NOVA_LINKS_BASE + '/feed/' + id;
  // Per spec: title (bold), then the first paragraph of the body, then
  // "Learn more: <link>" — and the first image (not just any image) as
  // the attached thumbnail.
  const message = `${boldForShare(p.title)}\n\n${firstParagraph(p.body)}\n\nLearn more: ${url}`;
  const firstImage = (p.media||[]).find(m=>m.type!=='video');
  const counts = {...DB.feedShareCounts};
  counts[id] = (counts[id]||0) + 1;
  DB.feedShareCounts = counts;
  pushFeedShareCountToCloud(id);
  shareContent(p.title, message, url, firstImage ? cldOptimize(firstImage.url, 800) : null);
}

/* ---------------- FEED LIKES ---------------- */
function isPostLiked(id){ return DB.likedPosts.includes(id); }
function likeCountFor(id){ return DB.feedLikeCounts[id] || 0; }
// Instagram/TikTok-style: the exact number stays hidden on a post until it
// has some real momentum, so a brand-new post never LOOKS unpopular next to
// one with hundreds of likes. Below the threshold, only the heart shows.
const LIKE_COUNT_THRESHOLD = 1;
function formatLikeCount(n){
  if(n >= 1000000) return (n/1000000).toFixed(n%1000000===0?0:1)+'m';
  if(n >= 1000) return (n/1000).toFixed(n%1000===0?0:1)+'k';
  return String(n);
}
// A guest tapping the heart never gets silently ignored or just dropped
// into a generic sign-in wall — their intent (which post they wanted to
// like) is remembered here and finished automatically the moment sign-in
// or sign-up succeeds (see applyPendingFeedLikeIfAny(), called from every
// auth-success path), so the like actually lands without the person having
// to remember to come back and tap the heart again.
window.__pendingFeedLikeId = null;
function toggleFeedLike(id){
  if(!window.__fbShopper){
    window.__pendingFeedLikeId = id;
    showSignInPromptModal('Sign in to like posts — we\'ll add your like the moment you\'re in.');
    return;
  }
  applyFeedLikeToggle(id);
}
function applyFeedLikeToggle(id){
  const wasLiked = isPostLiked(id);
  const counts = {...DB.feedLikeCounts};
  const current = counts[id] || 0;
  if(wasLiked){
    DB.likedPosts = DB.likedPosts.filter(x=>x!==id);
    counts[id] = Math.max(0, current - 1);
  } else {
    DB.likedPosts = [...DB.likedPosts, id];
    counts[id] = current + 1;
  }
  DB.feedLikeCounts = counts;
  rerenderFeedLikeButtons(id);
  pushLikedPostsToCloud();
  pushFeedLikeCountToCloud(id, wasLiked ? -1 : 1);
}
// Called right after every sign-in/sign-up success path sets window.__fbShopper.
// Returns true (and jumps straight to the liked post so the person can see
// it land) if there was a pending like to finish; the caller should only
// fall back to its normal navigate('#profile') when this returns false.
function applyPendingFeedLikeIfAny(){
  const id = window.__pendingFeedLikeId;
  if(!id) return false;
  window.__pendingFeedLikeId = null;
  if(!isPostLiked(id)) applyFeedLikeToggle(id);
  navigate('#feed/'+id);
  return true;
}
// Every place a like button can appear for the same post (detail page,
// hero card, grid card) gets updated in place so counts never drift out of
// sync between screens without a full re-render.
function rerenderFeedLikeButtons(id){
  document.querySelectorAll(`[data-like-id="${id}"]`).forEach(el=>{
    el.outerHTML = feedLikeButtonHtml(id);
  });
}
// Uses a thumbs-up (not the wishlist heart) so a shopper glancing at a feed
// post never confuses "like this post" with "add this product to my
// wishlist" — those are two different actions in two different places that
// used to share one icon. Only called with small=true (icon-only, no label)
// from the feed detail page's Like button now — the icon-only overlay
// version used to also sit on preview cards (home hero row, home "From the
// feed" grid, full feed list rows) but was removed from all three per
// request; small stays supported so the detail-page call site is unaffected.
function feedLikeButtonHtml(id, small){
  const liked = isPostLiked(id);
  const count = likeCountFor(id);
  const showCount = count >= LIKE_COUNT_THRESHOLD;
  const showLabel = !small;
  const expand = showCount || showLabel;
  return `<button class="wish-btn ${liked?'active':''}" data-like-id="${id}" onclick="event.stopPropagation(); toggleFeedLike('${id}')" style="position:static;background:var(--card);display:inline-flex;align-items:center;gap:5px;${expand?'width:auto;border-radius:16px;padding:6px 12px;':(small?'width:28px;height:28px;padding:0;border-radius:50%;':'width:32px;height:32px;padding:0;border-radius:50%;')}" aria-label="Like">
    ${icon(liked?'thumbUpFill':'thumbUp')}${showLabel?`<span class="small" style="line-height:1;font-weight:600;">Like</span>`:''}${showCount?`<span class="small" style="line-height:1;">${formatLikeCount(count)}</span>`:''}
  </button>`;
}
function clearWishlist(){
  if(!confirm('Remove all items from your wishlist?')) return;
  DB.wishlist = [];
  toast('Wishlist cleared');
  render();
}

// "productViews/{id}" and "productWishlists/{id}" mirror "feedLikes/{postId}"
// exactly — a shared running count updated with increment() so concurrent
// activity from different shoppers can't clobber each other. These are the
// real, cross-shopper signals that dynamic Trending / Featured For You are
// computed from (see computeTrendingProducts). Both fail silently if the
// matching security rule isn't set up yet, same as every other cloud-count
// push in this file — a shopper's browsing should never break because an
// analytics write failed.
async function pushProductViewToCloud(id){
  if(!window.__fb) return;
  // Same overwrite-on-any-failure fix as pushFeedLikeCountToCloud above.
  const { fbDb, doc, setDoc, increment } = window.__fb;
  try{ await setDoc(doc(fbDb, "productViews", id), { count: increment(1) }, { merge: true }); }
  catch(e){ console.warn("Product view push failed", e); }
}
async function pushProductShareCountToCloud(id){
  if(!window.__fb) return;
  const { fbDb, doc, setDoc, increment } = window.__fb;
  try{ await setDoc(doc(fbDb, "productShares", id), { count: increment(1) }, { merge: true }); }
  catch(e){ console.warn("Product share-count push failed", e); }
}
async function pushFeedShareCountToCloud(id){
  if(!window.__fb) return;
  const { fbDb, doc, setDoc, increment } = window.__fb;
  try{ await setDoc(doc(fbDb, "feedShares", id), { count: increment(1) }, { merge: true }); }
  catch(e){ console.warn("Feed share-count push failed", e); }
}
// Called once per genuine navigation to a product page (see render()) —
// logs locally (feeds shopperProfile()'s recent-activity view) and bumps
// the shared cloud counter (feeds dynamic Trending everywhere else).
function trackProductView(id){
  const p = findProduct(id);
  if(!p) return;
  logActivity('User', `Viewed product ${p.name}`);
  const counts = {...DB.productViewCounts};
  counts[id] = (counts[id]||0) + 1;
  DB.productViewCounts = counts;
  pushProductViewToCloud(id);
}

/* ================== NOVA AFFILIATE PROGRAM ==================
   Attribution model: last-click, per-product, no expiry, until
   overwritten. A product-specific link (?ref=&pid=) always wins over the
   general store link — and keeps paying out the affiliate no matter how
   many OTHER products get bought first, even much later, as long as the
   browser storage isn't cleared. The general link (?ref= only, no pid)
   pays out ONCE — whichever product the shopper buys first — enforced
   authoritatively server-side in verify-paystack.js (a cleared
   localStorage can't be used to re-trigger it). */
function captureAffiliateAttribution(){
  const p = new URLSearchParams(location.search);
  const ref = p.get('ref');
  const pid = p.get('pid');
  if(!ref) return;
  const key = pid ? ('nova_aff_'+pid) : 'nova_aff_general';
  try{ localStorage.setItem(key, JSON.stringify({ref, ts:Date.now()})); }catch(e){}
}
function resolveAffiliateAttribution(productId){
  try{
    const productKey = localStorage.getItem('nova_aff_'+productId);
    if(productKey){ const parsed = JSON.parse(productKey); return { affiliateRef: parsed.ref, affiliateRefSource: 'product' }; }
    const generalKey = localStorage.getItem('nova_aff_general');
    if(generalKey){ const parsed = JSON.parse(generalKey); return { affiliateRef: parsed.ref, affiliateRefSource: 'general' }; }
  }catch(e){}
  return { affiliateRef: null, affiliateRefSource: null };
}
// Abandoned-product-view reminder emails (requirement #14) — only logged
// for a shopper we can actually email (signed in, or gave their email at
// checkout before). One write per product per session (debounced via
// window.__affViewedThisSession) so re-renders/scrolling don't spam
// Firestore. Lives in its own `productViewEvents` collection — NOT the
// existing `productViews` collection, which is already used for the
// public "128 views" aggregate counter and has a different shape.
window.__affViewedThisSession = window.__affViewedThisSession || new Set();
function logAffiliateProductView(productId){
  const p = findProduct(productId);
  if(!p || !window.__fb) return;
  const email = (window.__fbShopper && window.__fbShopper.email) || null;
  if(!email || window.__affViewedThisSession.has(productId)) return;
  window.__affViewedThisSession.add(productId);
  const { fbDb, doc, setDoc, collection } = window.__fb;
  try{
    setDoc(doc(collection(fbDb, "productViewEvents")), {
      uid: window.__fbUid || null, email,
      name: (window.__fbShopper && window.__fbShopper.name) || null,
      productId: p.id, productName: p.name,
      productUrl: location.origin + location.pathname + '#product/' + p.id,
      ts: new Date(), emailed: false,
    }).catch(()=>{});
  }catch(e){ /* non-fatal — worst case, no reminder email for this view */ }
}
// RELATED PRODUCTS — replaces the old "same category, first 6" list with a
// real weighted-similarity score, so "related" actually means "reads like
// the same kind of thing", not just "happens to share a category dropdown
// value". Signals, each 0-1 before weighting:
//   • tag/text overlap (overlapScore over name+description+tags) — the
//     "read and understand what this product is about" piece
//   • same category (still worth a lot — it's a real signal, just not the
//     only one anymore)
//   • price proximity (a $12 template isn't "related" to a $400 bundle
//     just because both are templates)
//   • rating (mild boost — don't surface a 2★ item just because the text
//     matches; global quality still matters)
//   • a shopper-history nudge when their topCategory (see shopperProfile)
//     matches, so returning shoppers get a small personalized boost —
//     this is the "(i) user's own data" half of the algorithm, alongside
//     the global text/price/category signal that applies to everyone.

// Generic lifecycle-event logger used by checkout + sign-up recovery.
// Client can only CREATE these docs; the backend is the only code allowed
// to read, update, suppress, or send from them. Session de-duping prevents
// repeated re-renders / OTP resends from creating a pile of identical events.
window.__novaLifecycleLogged = window.__novaLifecycleLogged || new Set();
window.logLifecycleEvent = function(eventType, email, data){
  try{
    const normalizedEmail = String(email||'').trim().toLowerCase();
    if(!normalizedEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || !window.__fb) return;
    data = data || {};
    const dedupeKey = [eventType, normalizedEmail, data.productId||''].join('|');
    if(window.__novaLifecycleLogged.has(dedupeKey)) return;
    window.__novaLifecycleLogged.add(dedupeKey);
    const { fbDb, doc, setDoc, collection } = window.__fb;
    setDoc(doc(collection(fbDb, "productViewEvents")), {
      eventType: String(eventType||'').slice(0,40),
      uid: window.__fbUid || null,
      email: normalizedEmail,
      name: data.name || (window.__fbShopper && window.__fbShopper.name) || null,
      productId: data.productId || null,
      productName: data.productName || null,
      productUrl: data.productUrl || null,
      checkoutUrl: data.checkoutUrl || null,
      signupUrl: data.signupUrl || null,
      variant: data.variant || null,
      amount: data.amount || null,
      ts: new Date(),
      stage: 0,
      emailed: false,
    }).catch(()=>{ window.__novaLifecycleLogged.delete(dedupeKey); });
  }catch(e){}
};

function computeRelatedProducts(anchor, allProducts, opts){
  opts = opts || {};
  const limit = opts.limit || 6;
  const sp = opts.shopperProfile || null;
  const pool = allProducts.filter(p=>p.id!==anchor.id && p.status!=='draft');
  if(!pool.length) return [];
  const textOf = p => `${p.name} ${p.description||''} ${(p.tags||[]).join(' ')}`;
  const anchorTokens = tokenize(textOf(anchor));
  const allTokenSets = pool.map(p=>tokenize(textOf(p)));
  const corpusFreq = buildCorpusFreq([anchorTokens, ...allTokenSets]);
  const maxPriceDelta = Math.max(...pool.map(p=>Math.abs((p.salePrice||p.price||0) - (anchor.salePrice||anchor.price||0))), 1);
  const scored = pool.map((p, i) => {
    const textScore = overlapScore(anchorTokens, allTokenSets[i], corpusFreq); // 0..~1.5
    const categoryScore = p.category === anchor.category ? 1 : 0;
    const priceDelta = Math.abs((p.salePrice||p.price||0) - (anchor.salePrice||anchor.price||0));
    const priceScore = 1 - Math.min(1, priceDelta / maxPriceDelta); // closer price = higher
    const ratingScore = (p.rating||0) / 5;
    const personalBoost = (sp && sp.topCategory && p.category === sp.topCategory) ? 0.15 : 0;
    const score = textScore*2.2 + categoryScore*1.3 + priceScore*0.5 + ratingScore*0.35 + personalBoost;
    return { p, score };
  }).filter(x => x.score > 0);
  scored.sort((a,b) => b.score - a.score);
  let result = scored.map(x=>x.p);
  // Cold-start / thin-catalog fallback: if similarity scoring came up
  // short (e.g. a brand-new product with a sparse description), backfill
  // with same-category items so the section is never empty, same
  // philosophy as computeTrendingProducts' backfill tiers.
  if(result.length < limit){
    const have = new Set(result.map(p=>p.id));
    pool.filter(p=>p.category===anchor.category && !have.has(p.id))
      .sort((a,b)=>b.rating-a.rating)
      .forEach(p=>{ if(result.length<limit){ result.push(p); have.add(p.id); } });
  }
  return result.slice(0, limit);
}
// RELATED FEED POSTS — the feed-post equivalent: "reading and understanding
// what this post is about, compared to every other post" via the same
// overlapScore engine (title+body, since posts don't have tags), with a
// popularity tiebreak (likes+views) so that among near-equal text matches,
// the one other shoppers actually engaged with globally wins.
function relatedFeedPosts(anchor, limit){
  limit = limit || 4;
  const pool = DB.feed.filter(p=>p.id!==anchor.id);
  if(!pool.length) return [];
  const textOf = p => `${p.title} ${p.body||''}`;
  const anchorTokens = tokenize(textOf(anchor));
  const allTokenSets = pool.map(p=>tokenize(textOf(p)));
  const corpusFreq = buildCorpusFreq([anchorTokens, ...allTokenSets]);
  const scored = pool.map((p,i)=>{
    const textScore = overlapScore(anchorTokens, allTokenSets[i], corpusFreq);
    const anchorIds = feedPostProductIds(anchor);
    const sameProduct = anchorIds.some(id=>feedPostProductIds(p).includes(id)) ? 0.4 : 0;
    const engagement = (DB.feedLikeCounts[p.id]||0) + (DB.feedViewCounts[p.id]||0)*0.33;
    const popularityScore = Math.min(0.3, Math.log2(engagement+1) * 0.06); // small tiebreak, never dominates topic match
    return { p, score: textScore + sameProduct + popularityScore };
  }).filter(x=>x.score > 0.05); // require a real topical connection, not just noise
  scored.sort((a,b)=>b.score-a.score);
  return scored.slice(0,limit).map(x=>x.p);
}
// ---- CONTENT SIMILARITY ENGINE ---------------------------------------
// Shared by computeRelatedProducts() and relatedFeedPosts() below. Since
// this is a static single-file app with no server-side embeddings model,
// "reading and understanding" a feed post/product to find related ones is
// implemented honestly as lightweight lexical similarity — tokenize both
// texts, drop short/common filler words, and score by how much vocabulary
// they share (a bounded Jaccard-style overlap) — rather than pretending to
// run real NLP client-side. This is the same class of technique real
// "related articles" widgets used before embeddings were cheap, and it
// works well here because titles/descriptions/tags are short and topical.
const STOPWORDS = new Set(['the','a','an','and','or','but','for','with','from','this','that','these','those','into','onto','your','you','our','ours','are','was','were','been','has','have','had','not','all','any','can','will','would','should','about','after','before','over','under','than','then','them','they','their','its','it\'s','of','to','in','on','at','is','be','as','by','we','us','i','if','so','how','what','why','when','which']);
function tokenize(str){
  return (str||'').toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w=>w.length>2 && !STOPWORDS.has(w));
}
// Bag-of-words overlap score between two token arrays: counts how many of
// the *rarer, more specific* shared words appear in both (weighted by
// inverse frequency in `corpusFreq` so a word every post shares, like a
// brand name, counts far less than a word only a few posts share), then
// normalizes by the shorter document's length so a short post isn't
// unfairly penalized against a long one.
function overlapScore(tokensA, tokensB, corpusFreq){
  if(!tokensA.length || !tokensB.length) return 0;
  const setB = new Set(tokensB);
  let score = 0;
  const seen = new Set();
  tokensA.forEach(w=>{
    if(setB.has(w) && !seen.has(w)){
      seen.add(w);
      const freq = corpusFreq[w] || 1;
      score += 1 / Math.log2(freq + 2); // rarer shared word = more weight
    }
  });
  return score / Math.min(tokensA.length, tokensB.length || 1, 12);
}
// Word document-frequency across a corpus of token arrays, used to weight
// overlapScore — computed fresh each call since the catalog/feed is small
// enough (dozens to low hundreds of items) that this is cheap, and it
// keeps the weighting accurate as products/posts are added or removed.
function buildCorpusFreq(tokenArrays){
  const freq = {};
  tokenArrays.forEach(tokens=>{
    new Set(tokens).forEach(w=>{ freq[w] = (freq[w]||0) + 1; });
  });
  return freq;
}
// Ranks every feed post (important + regular together) by feedHotScore,
// admin-pinned "important" posts first (they're meant to act like a
// featured banner, not compete on age/likes), then the rest by hot score.
// This is what both the Home "From the feed" preview and the full "More
// feed" list screen use, so the ordering is consistent everywhere.
function rankedFeed(){
  const posts = DB.feed.slice();
  const important = posts.filter(p=>p.important);
  const regular = posts.filter(p=>!p.important).sort((a,b)=>feedHotScore(b)-feedHotScore(a));
  return [...important, ...regular];
}

/* ---------------- PROFILE ---------------- */
function screenProfile(){
  const shopper = window.__fbShopper;
  // On first paint after a page load/refresh, Firebase hasn't told us yet
  // whether anyone's actually signed in (see the BUGFIX note above
  // window.__fbAuthResolved in onAuthStateChanged) — showing "Guest
  // Explorer" during that brief window looked exactly like a signed-in
  // shopper's account had vanished. Show a neutral loading placeholder
  // for the identity card only.
  // BUGFIX (tabs should not disappear behind the loading state): this used
  // to return ONLY the loading placeholder — Wishlist/Order History/
  // Settings were invisible until auth resolved, so a slow connection made
  // the whole Profile tab look empty, not just the identity card. Those
  // rows don't need to know who's signed in to be shown; only what they
  // navigate to does, and each destination screen already handles its own
  // guest/loading state. So the identity card is the only part gated here
  // now — the shortcut list always renders.
  const identityCard = !window.__fbAuthResolved
    ? `<div class="card" style="padding:18px;display:flex;gap:14px;align-items:center;margin-bottom:18px;">
        <div class="profile-avatar-lg" style="opacity:.5;">…</div>
        <div style="flex:1;">
          <div style="font-weight:700;opacity:.5;">Loading…</div>
          <div class="text-2 small">Checking your account…</div>
        </div>
      </div>`
    : !shopper
    ? `<div class="card" style="padding:18px;display:flex;gap:14px;align-items:center;margin-bottom:18px;cursor:pointer;" onclick="navigate('#login')">
        <div class="profile-avatar-lg">G</div>
        <div style="flex:1;">
          <div style="font-weight:700;">Guest Explorer</div>
          <div class="text-2 small">Sign in to sync your wishlist and see order history.</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="event.stopPropagation(); navigate('#login')">Sign In</button>
      </div>`
    : (() => {
        if(!editProfileForm || editProfileForm._uid !== shopper.uid) resetEditProfileForm(shopper);
        return `<div class="card" style="padding:18px;display:flex;gap:14px;align-items:center;margin-bottom:18px;cursor:pointer;" onclick="navigate('#account')">
          <img class="profile-avatar-lg" style="object-fit:cover;" src="${cldOptimize(shopper.photoURL,120) || DEFAULT_LOGO_DATA_URI}" alt="">
          <div style="flex:1;min-width:0;">
            <div style="font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml((shopper.name||'').trim() || 'Member')}</div>
            <div class="text-2 small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(shopper.email)}</div>
          </div>
          <span>${icon('chevron')}</span>
        </div>`;
      })();
  return `
  <div class="screen">
    <h1 class="screen-title">Profile</h1>
    ${identityCard}
    <div class="section">
      <div class="card" style="padding:4px 16px;">
        <div class="list-row" style="cursor:pointer;" onclick="navigate('#orders')"><span class="left"><span class="ic">${icon('package')}</span>Order History</span><span>${icon('chevron')}</span></div>
        <div class="list-row" style="cursor:pointer;" onclick="navigate('#library')"><span class="left"><span class="ic">${icon('download')}</span>My Library</span><span>${icon('chevron')}</span></div>
        <div class="list-row" style="cursor:pointer;" onclick="navigate('#wishlist')"><span class="left"><span class="ic">${icon('heart')}</span>My Wishlist</span><span>${icon('chevron')}</span></div>
        <div class="list-row" style="cursor:pointer;" onclick="navigate('#pickup')"><span class="left"><span class="ic">${icon('package')}</span>Pickup stations</span><span>${icon('chevron')}</span></div>
        <div class="list-row" style="cursor:pointer;" onclick="navigate('#settings')"><span class="left"><span class="ic">${icon('settings')}</span>Settings</span><span>${icon('chevron')}</span></div>
        <div class="list-row" style="cursor:pointer;" onclick="location.href='affiliate/index.html'"><span class="left"><span class="ic">${icon('target')}</span>Nova Affiliate Program</span><span>${icon('chevron')}</span></div>
        <div class="list-row" style="cursor:pointer;" onclick="navigate('#creator')"><span class="left"><span class="ic">${icon('target')}</span>${escapeHtml(creatorRowLabel())}</span><span>${icon('chevron')}</span></div>
      </div>
    </div>
  </div>`;
}
// Dedicated account page — reached by tapping the identity card on the
// Profile tab. Sign out sits right at the top (the ask was specifically
// for it to be immediately visible, not buried under Settings), followed
// by the same editable-fields form that used to live inline on the
// Profile tab. Guests have nothing to view/edit here, so they're sent
// back to the Profile tab (which will show them the Sign In card).
function screenAccount(){
  const shopper = window.__fbShopper;
  if(!window.__fbAuthResolved){
    return `<div class="screen"><h1 class="screen-title">My Account</h1><div class="text-2 small">Checking your account…</div></div>`;
  }
  if(!shopper){
    navigate('#profile');
    return `<div class="screen"></div>`;
  }
  if(!editProfileForm || editProfileForm._uid !== shopper.uid) resetEditProfileForm(shopper);
  const f = editProfileForm;
  const regionList = SIGNUP_REGIONS[f.country];
  return `
  <div class="screen">
    <div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:10px;">
      <button class="btn btn-ghost btn-sm" onclick="navigate('#profile')">← Back</button>
      <button class="btn btn-outline btn-sm" style="color:var(--error);border-color:var(--error);" onclick="handleGoogleSignOut()">${icon('logout')} Sign out</button>
    </div>
    <h1 class="screen-title">My Account</h1>

    <div class="card profile-hero">
      <div class="profile-hero-avatar-wrap">
        <img id="epAvatarPreview" class="profile-hero-avatar" src="${f.avatarPreview || cldOptimize(shopper.photoURL,160) || DEFAULT_LOGO_DATA_URI}" alt="">
        <label class="profile-hero-avatar-edit" for="epAvatarInput" title="Change photo">${icon('edit')}</label>
        <input type="file" id="epAvatarInput" accept="image/*" style="display:none;" onchange="previewEpAvatar(this)">
      </div>
      <div class="profile-hero-name">${escapeHtml((shopper.name||'').trim() || 'Member')}</div>
      <div class="profile-hero-sub">${escapeHtml(shopper.email)}</div>
    </div>

    <div class="section">
      <div class="section-head"><h2>Personal details</h2></div>
      <div class="card" style="padding:16px;">
        <div class="form-field"><label>Full name</label><input type="text" value="${escapeHtml(f.name)}" placeholder="Your name" onchange="editProfileForm.name=this.value.trim();"></div>
        <div class="form-field"><label>Gender</label>${epDropdown('gender', SIGNUP_GENDER_OPTIONS, 'Select gender')}</div>
        <div class="form-field"><label>Date of birth</label><input type="date" value="${escapeHtml(f.dob)}" max="${new Date().toISOString().slice(0,10)}" onchange="editProfileForm.dob=this.value;"></div>
        <div class="form-field"><label>Country</label>${epDropdown('country', SIGNUP_COUNTRIES, 'Select your country')}</div>
        ${f.country?`<div class="form-field"><label>State${regionList?'':' / Region'}</label>${
          regionList
            ? epDropdown('state', regionList, 'Select your state / region')
            : `<input type="text" placeholder="State / region" value="${escapeHtml(f.state)}" onchange="editProfileForm.state=this.value.trim();">`
        }</div>`:''}
        <div class="form-field"><label>Occupation</label>${epDropdown('occupation', SIGNUP_OCCUPATION_OPTIONS, 'Select occupation')}</div>
        ${f.occupation==='Other'?`<div class="form-field"><label>Please specify</label><input type="text" value="${escapeHtml(f.occupationOther)}" onchange="editProfileForm.occupationOther=this.value.trim();"></div>`:''}
        <button class="btn btn-primary btn-block" style="margin-top:6px;" id="epSaveBtn" onclick="saveEditProfile()" ${f.submitting?'disabled':''}>${f.submitting?'Saving…':'Save changes'}</button>
      </div>
    </div>

    <div class="section">
      <div class="section-head"><h2>Account</h2></div>
      <div class="card" style="padding:4px 16px;">
        <div class="list-row"><span class="left"><span class="ic">${icon('mail')}</span>Email</span><span class="text-2 small">${escapeHtml(shopper.email)}</span></div>
        <div class="list-row"><span class="left"><span class="ic">${icon('info')}</span>How you heard about us</span><span class="text-2 small">${escapeHtml(shopper.howHeard || '—')}</span></div>
      </div>
    </div>

  </div>`;
}

// Profile-row wording follows the shopper's creator status, so an approved
// creator never sees "Become a Creator". The status is fetched once, quietly,
// the first time a signed-in shopper opens Profile.
function creatorRowLabel(){
  if(window.__fbShopper && !window.__creatorAppCache && !window.__creatorAppError && !window.__creatorAppFetching){
    window.__creatorAppFetching = true;
    fetchCreatorApplication().then(()=>{ window.__creatorAppFetching = false; render(); }).catch(()=>{ window.__creatorAppFetching = false; });
  }
  const st = window.__creatorAppCache && window.__creatorAppCache.status;
  if(st==='APPROVED') return 'My Creator Account';
  if(st==='SUBMITTED' || st==='IN_REVIEW') return 'Creator Application (In Review)';
  if(st==='APPLICATION_DRAFT' || st==='CHANGES_REQUESTED') return 'Continue Creator Application';
  return 'Become a Creator';
}

/* Always-editable profile form state for the signed-in Profile screen
   above. Kept separate from completeProfileForm (below) — that older
   one-time "finish your profile" card is no longer shown from here (this
   screen replaces it) but its functions are left intact rather than
   deleted, in case that flow gets reused elsewhere later. */
let editProfileForm = null;
function resetEditProfileForm(shopper){
  const knownOccupations = SIGNUP_OCCUPATION_OPTIONS.filter(o=>o!=='Other');
  const occ = shopper.occupation || '';
  editProfileForm = {
    _uid: shopper.uid,
    name: shopper.name || '', gender: shopper.gender || '', dob: shopper.dob || '',
    country: shopper.country || '', state: shopper.state || '',
    occupation: (occ && !knownOccupations.includes(occ)) ? 'Other' : occ,
    occupationOther: (occ && !knownOccupations.includes(occ)) ? occ : '',
    avatarFile: null, avatarPreview: '',
    submitting: false,
  };
}
function epDropdown(field, options, placeholder){
  const val = editProfileForm[field];
  const norm = options.map(o => typeof o === 'string' ? {value:o, label:o} : o);
  const sel = norm.find(o=>o.value===val);
  return `
  <div class="csel" id="csel_ep_${field}">
    <button type="button" class="csel-btn ${sel?'':'placeholder'}" onclick="toggleEpSelect('${field}')">
      <span>${escapeHtml(sel?sel.label:placeholder)}</span><span class="csel-arrow">▾</span>
    </button>
    <div class="csel-panel">
      ${norm.map(o=>`<div class="csel-opt ${o.value===val?'active':''}" onclick="pickEpOption('${field}','${jsStr(o.value)}')">${escapeHtml(o.label)}</div>`).join('')}
    </div>
  </div>`;
}
function toggleEpSelect(field){
  const el = $('#csel_ep_'+field);
  if(!el) return;
  const wasOpen = el.classList.contains('open');
  $all('.csel.open').forEach(o=>o.classList.remove('open'));
  if(!wasOpen) el.classList.add('open');
}
function pickEpOption(field, value){
  editProfileForm[field] = value;
  if(field === 'country') editProfileForm.state = ''; // stale state pick doesn't carry over to a new country
  render();
}
function previewEpAvatar(inputEl){
  const file = inputEl.files && inputEl.files[0];
  if(!file) return;
  if(file.size > 8*1024*1024){ toast('Image too large — 8MB max', 'error'); inputEl.value=''; return; }
  const reader = new FileReader();
  reader.onload = e=>{
    editProfileForm.avatarFile = file;
    editProfileForm.avatarPreview = e.target.result;
    const img = $('#epAvatarPreview');
    if(img) img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
// Any time a shopper wants to save changes to their own profile info,
// confirm it's really them first — but only shoppers who actually HAVE a
// LEXDEN NOVA password (email/password sign-in). Google-signed shoppers
// have no such password, so their save just proceeds. This is separate
// from — and unrelated to — admin portal login, which already has its
// own password gate.
function saveEditProfile(){
  const shopper = window.__fbShopper;
  if(!shopper || !editProfileForm) return;
  if(shopper.provider === 'password'){
    openProfilePasswordConfirm(()=>doSaveEditProfile());
  } else {
    doSaveEditProfile();
  }
}
function openProfilePasswordConfirm(onConfirmed){
  if($('#profilePwOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'profilePwOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:380px;width:100%;padding:20px;">
      <h2 class="font-display" style="margin-bottom:4px;">Confirm your password</h2>
      <p class="text-2 small" style="margin-bottom:14px;">For your security, re-enter your password to save changes to your profile.</p>
      <div class="form-field"><label>Password</label><input type="password" id="profilePwInput" autocomplete="current-password"></div>
      <p class="small text-2" id="profilePwErr" style="color:var(--error);min-height:16px;"></p>
      <div class="flex gap-8">
        <button class="btn btn-primary" id="profilePwBtn" style="flex:1;">Confirm & Save</button>
        <button class="btn btn-outline" onclick="closeProfilePasswordConfirm()">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = $('#profilePwInput');
  input.focus();
  const submit = async ()=>{
    const pw = input.value;
    const errEl = $('#profilePwErr');
    if(!pw){ if(errEl) errEl.textContent = 'Enter your password.'; return; }
    const btn = $('#profilePwBtn');
    if(btn){ btn.disabled = true; btn.textContent = 'Checking…'; }
    try{
      await window.__novaReauth(pw);
      closeProfilePasswordConfirm();
      onConfirmed();
    }catch(e){
      if(errEl) errEl.textContent = 'Incorrect password — try again.';
      if(btn){ btn.disabled = false; btn.textContent = 'Confirm & Save'; }
    }
  };
  $('#profilePwBtn').addEventListener('click', submit);
  input.addEventListener('keydown', e=>{ if(e.key==='Enter') submit(); });
}
function closeProfilePasswordConfirm(){ $('#profilePwOverlay')?.remove(); }
async function doSaveEditProfile(){
  const shopper = window.__fbShopper;
  if(!shopper || !editProfileForm) return;
  const f = editProfileForm;
  f.submitting = true;
  const btn = $('#epSaveBtn'); if(btn){ btn.disabled = true; btn.textContent = 'Saving…'; }
  let photoURL = '';
  if(f.avatarFile){
    try{
      const upFile = await resizeAvatarImage(f.avatarFile);
      photoURL = await withTimeout(cloudinaryUploadFile(upFile, 8), 45000, 'Photo upload is taking too long — try again with a stronger connection.');
    }catch(e){
      // Photo upload failing shouldn't block the rest of the form from
      // saving — the other fields below still get written either way.
      console.warn('Profile photo upload failed', e);
      toast(uploadErrorMessage(e), 'error');
    }
  }
  const finalOccupation = f.occupation==='Other' ? f.occupationOther : f.occupation;
  const address = [f.state, f.country].filter(Boolean).join(', ');
  await window.__novaUpsertUserProfile({
    uid: shopper.uid,
    name: f.name || undefined,
    gender: f.gender || undefined,
    dob: f.dob || undefined,
    country: f.country || undefined,
    state: f.state || undefined,
    occupation: finalOccupation || undefined,
    photoURL: photoURL || undefined,
    address: address || undefined,
    profileSetupDone: true,
  });
  if(f.name) shopper.name = f.name;
  if(f.gender) shopper.gender = f.gender;
  if(f.dob) shopper.dob = f.dob;
  if(f.country) shopper.country = f.country;
  if(f.state) shopper.state = f.state;
  if(finalOccupation) shopper.occupation = finalOccupation;
  if(photoURL) shopper.photoURL = photoURL;
  if(address) shopper.address = address;
  shopper.profileSetupDone = true;
  editProfileForm = null;
  toast('Profile updated ✅', 'success');
  render();
}
/* Preferences (Notifications, Theme, Language, Currency, Install App) now
   live on their own Settings screen (screenSettings / #settings), reached
   only from the Profile tab's "Settings" row — not from the Menu tab —
   Profile is just account + wishlist/orders + a link to Settings. */
function screenSettings(){
  return `
  <div class="screen">
    <h1 class="screen-title">Settings</h1>
    ${preferencesSectionHtml()}
  </div>`;
}
function preferencesSectionHtml(){
  // "on" reflects whether push notifications are actually enabled (real
  // browser permission + FCM token), not just a local preference flag —
  // this one switch now IS the notifications feature (see toggleNotif),
  // so its state has to match reality rather than default to true.
  const notif = window.__notificationsEnabled ? window.__notificationsEnabled() : false;
  return `
    <div class="section">
      <div class="section-head"><h2>Preferences</h2></div>
      <div class="card" style="padding:4px 16px;">
        <div class="list-row"><span class="left"><span class="ic">${icon('bell')}</span>Notifications</span><span class="switch ${notif?'on':''}" onclick="toggleNotif(this)"><span class="knob"></span></span></div>
        <div class="list-row"><span class="left"><span class="ic">${icon(appState.theme==='dark'?'moon':'sun')}</span>Theme</span><span class="switch ${appState.theme==='dark'?'on':''}" onclick="toggleThemeBtn()"><span class="knob"></span></span></div>
        <div class="list-row"><span class="left"><span class="ic">${icon('globe')}</span>Language</span><span class="text-2 small">English</span></div>
        <div class="list-row"><span class="left"><span class="ic">${icon('currency')}</span>Currency</span>
          ${customSelect('currencySelect', currentCurrency(), Object.keys(DB.content.exchangeRates).map(code=>({value:code,label:`${code} ${DB.content.currencySymbols[code]||''}`})), '', v=>setCurrency(v), true)}
        </div>
        ${!PAYSTACK_CHARGEABLE_CURRENCIES.includes(currentCurrency())
          ? `<div class="text-2 small" style="padding:4px 0 10px;">Prices are shown in ${escapeHtml(currentCurrency())} for browsing — checkout currently charges in ${PAYSTACK_FALLBACK_CURRENCY}.</div>`
          : ''}
        ${isStandalone() ? '' : `<div class="list-row" style="cursor:pointer;" onclick="handleInstallAction()"><span class="left"><span class="ic">${icon('download')}</span>Install App</span><span>${icon('chevron')}</span></div>`}
      </div>
    </div>`;
}
/* SUPERSEDED — no longer called from screenProfile(), which now shows an
   always-editable form directly (see editProfileForm above) so a shopper
   can fix any field anytime, not just once on first Google sign-in.
   Left in place, unused, rather than deleted, in case this one-time-nag
   pattern is wanted again for some other flow later.

   Originally: shown on the Profile screen exactly once per account — the
   first time a Google-signed-in shopper's profile wasn't marked complete
   (see profileSetupDone). Asked only for whichever fields Google itself
   never supplies (gender, date of birth, country/state, occupation, how
   they heard about us) plus a photo if Google didn't return one, using
   the same picker fields/options as the email Sign Up wizard for
   consistency. Saving — or explicitly skipping — set profileSetupDone so
   it would never show again, even for fields left blank. */
let completeProfileForm = null;
function resetCompleteProfileForm(shopper){
  completeProfileForm = {
    _uid: shopper.uid,
    gender:'', dob:'', country:'', state:'', occupation:'', occupationOther:'', howHeard:'',
    avatarFile:null, avatarPreview:'',
    submitting:false,
  };
}
function screenCompleteProfileCard(shopper){
  if(!completeProfileForm || completeProfileForm._uid !== shopper.uid) resetCompleteProfileForm(shopper);
  const f = completeProfileForm;
  const regionList = SIGNUP_REGIONS[f.country];
  return `
  <div class="card" style="padding:16px;margin-bottom:18px;border:1px solid var(--accent);">
    <h3 style="margin:0 0 4px;font-size:14px;">Finish setting up your profile</h3>
    <p class="text-2 small" style="margin:0 0 12px;">Google shared your name and email — just need a few more details (one-time):</p>
    ${!shopper.photoURL?`
    <div class="auth-avatar-picker" style="margin-bottom:10px;">
      <img id="cpAvatarPreview" src="${f.avatarPreview || DEFAULT_LOGO_DATA_URI}" alt="">
      <div>
        <label class="btn btn-outline btn-sm" for="cpAvatarInput">Choose profile picture</label>
        <input type="file" id="cpAvatarInput" accept="image/*" style="display:none;" onchange="previewCpAvatar(this)">
      </div>
    </div>`:''}
    ${!shopper.gender?`<div class="form-field"><label>Gender</label>${cpDropdown('gender', SIGNUP_GENDER_OPTIONS, 'Select gender')}</div>`:''}
    ${!shopper.dob?`<div class="form-field"><label>Date of birth</label><input type="date" id="cpDob" value="${escapeHtml(f.dob)}" max="${new Date().toISOString().slice(0,10)}" onchange="completeProfileForm.dob=this.value;"></div>`:''}
    ${!shopper.country?`<div class="form-field"><label>Country</label>${cpDropdown('country', SIGNUP_COUNTRIES, 'Select your country')}</div>`:''}
    ${(!shopper.state && f.country)?`<div class="form-field"><label>State${regionList?'':' / Region'}</label>${
      regionList
        ? cpDropdown('state', regionList, 'Select your state / region')
        : `<input type="text" id="cpStateFree" placeholder="State / region" value="${escapeHtml(f.state)}" onchange="completeProfileForm.state=this.value.trim();">`
    }</div>`:''}
    ${!shopper.occupation?`<div class="form-field"><label>Occupation</label>${cpDropdown('occupation', SIGNUP_OCCUPATION_OPTIONS, 'Select occupation')}</div>`:''}
    ${(!shopper.occupation && f.occupation==='Other')?`<div class="form-field"><label>Please specify</label><input type="text" id="cpOccupationOther" placeholder="Tell us what you do" value="${escapeHtml(f.occupationOther)}" onchange="completeProfileForm.occupationOther=this.value.trim();"></div>`:''}
    ${!shopper.howHeard?`<div class="form-field"><label>How did you hear about us?</label>${cpDropdown('howHeard', SIGNUP_HOW_HEARD_OPTIONS, 'Select an option')}</div>`:''}
    <div class="flex gap-8" style="margin-top:4px;">
      <button class="btn btn-outline btn-sm" style="flex:1;" onclick="skipCompleteProfile()" ${f.submitting?'disabled':''}>Skip for now</button>
      <button class="btn btn-primary btn-sm" style="flex:1;" id="cpSaveBtn" onclick="saveExtraProfile()" ${f.submitting?'disabled':''}>${f.submitting?'Saving…':'Save'}</button>
    </div>
  </div>`;
}
function cpDropdown(field, options, placeholder){
  const val = completeProfileForm[field];
  const norm = options.map(o => typeof o === 'string' ? {value:o, label:o} : o);
  const sel = norm.find(o=>o.value===val);
  return `
  <div class="csel" id="csel_cp_${field}">
    <button type="button" class="csel-btn ${sel?'':'placeholder'}" onclick="toggleCpSelect('${field}')">
      <span>${escapeHtml(sel?sel.label:placeholder)}</span><span class="csel-arrow">▾</span>
    </button>
    <div class="csel-panel">
      ${norm.map(o=>`<div class="csel-opt ${o.value===val?'active':''}" onclick="pickCpOption('${field}','${jsStr(o.value)}')">${escapeHtml(o.label)}</div>`).join('')}
    </div>
  </div>`;
}
function toggleCpSelect(field){
  const el = $('#csel_cp_'+field);
  if(!el) return;
  const wasOpen = el.classList.contains('open');
  $all('.csel.open').forEach(o=>o.classList.remove('open'));
  if(!wasOpen) el.classList.add('open');
}
function pickCpOption(field, value){
  completeProfileForm[field] = value;
  if(field === 'country') completeProfileForm.state = ''; // stale state pick doesn't carry over to a new country
  render();
}
function previewCpAvatar(inputEl){
  const file = inputEl.files && inputEl.files[0];
  if(!file) return;
  if(file.size > 8*1024*1024){ toast('Image too large — 8MB max', 'error'); inputEl.value=''; return; }
  const reader = new FileReader();
  reader.onload = e=>{
    completeProfileForm.avatarFile = file;
    completeProfileForm.avatarPreview = e.target.result;
    const img = $('#cpAvatarPreview');
    if(img) img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
async function saveExtraProfile(){
  const shopper = window.__fbShopper;
  if(!shopper || !completeProfileForm) return;
  const f = completeProfileForm;
  f.submitting = true;
  const btn = $('#cpSaveBtn'); if(btn){ btn.disabled = true; btn.textContent = 'Saving…'; }
  let photoURL = '';
  if(f.avatarFile){
    try{
      const upFile = await resizeAvatarImage(f.avatarFile);
      photoURL = await withTimeout(cloudinaryUploadFile(upFile, 8), 45000, 'Photo upload is taking too long — try again with a stronger connection.');
    }
    catch(e){ console.warn('Avatar upload failed', e); toast(uploadErrorMessage(e), 'error'); }
  }
  const finalOccupation = f.occupation==='Other' ? f.occupationOther : f.occupation;
  const address = [f.state, f.country].filter(Boolean).join(', ');
  await window.__novaUpsertUserProfile({
    uid: shopper.uid,
    gender: f.gender || undefined,
    dob: f.dob || undefined,
    country: f.country || undefined,
    state: f.state || undefined,
    occupation: finalOccupation || undefined,
    howHeard: f.howHeard || undefined,
    photoURL: photoURL || undefined,
    address: address || undefined,
    profileSetupDone: true,
  });
  // Reflect immediately so the card updates without waiting on a re-fetch.
  if(f.gender) shopper.gender = f.gender;
  if(f.dob) shopper.dob = f.dob;
  if(f.country) shopper.country = f.country;
  if(f.state) shopper.state = f.state;
  if(finalOccupation) shopper.occupation = finalOccupation;
  if(f.howHeard) shopper.howHeard = f.howHeard;
  if(photoURL) shopper.photoURL = photoURL;
  if(address) shopper.address = address;
  shopper.profileSetupDone = true;
  completeProfileForm = null;
  toast('Profile updated ✅', 'success');
  render();
}
// "Skip for now" — still marks the account as complete (never asked
// again) but saves nothing beyond that; whatever the shopper had already
// picked in the form before hitting Skip is simply discarded.
async function skipCompleteProfile(){
  const shopper = window.__fbShopper;
  if(!shopper) return;
  await window.__novaUpsertUserProfile({ uid: shopper.uid, profileSetupDone: true });
  shopper.profileSetupDone = true;
  completeProfileForm = null;
  render();
}
// BUGFIX ("Request not valid" from Google, only sometimes): a double-tap
// (very common on touchscreens, especially while the button hasn't visibly
// reacted yet) fired signInWithPopup() twice almost back-to-back. Each call
// opens its own accounts.google.com popup with its own OAuth request, but
// Firebase's popup-auth machinery tracks only one pending attempt at a
// time — the second request can arrive at Google already carrying a
// state/nonce the first request invalidated, which Google's own page
// rejects as invalid_request. That's a Google-side error page, not a
// Firebase error code, so the old code had no way to catch or explain it.
// A simple in-flight guard makes the second tap a no-op instead of a race.
let __googleSignInInFlight = false;
async function handleGoogleSignIn(){
  if(!window.__signInWithGoogle){ toast('Sign-in is not ready yet — try again in a moment.', 'error'); return; }
  if(__googleSignInInFlight) return; // ignore rapid double-taps/double-clicks
  __googleSignInInFlight = true;
  try{
    const user = await window.__signInWithGoogle();
    // A null result means signInWithRedirect kicked in — the page is
    // about to navigate away to Google and back, so there's nothing more
    // to do here; the sign-in itself gets picked up on reload.
    if(!user) return;
    // Build the shopper profile straight from the Google user object
    // instead of waiting on onAuthStateChanged (which sets this too, but
    // fires async and isn't guaranteed to land before we render) — this
    // is what makes the very first paint of the Profile tab already show
    // the right name/email/photo instead of a stale "Guest" flash.
    // onAuthStateChanged still runs afterward and fills in
    // address/occupation from Firestore once that fetch completes.
    window.__fbShopper = { uid:user.uid, name:user.displayName||'', email:user.email||'', photoURL:user.photoURL||'', provider:'google' };
    toast('Signed in!', 'success');
    if(!applyPendingFeedLikeIfAny()) navigate('#profile');
    render();
  }catch(e){
    console.warn('Google sign-in failed', e);
    const code = e && e.code;
    if(code==='auth/popup-closed-by-user' || code==='auth/cancelled-popup-request'){
      // Person closed the popup themselves — no need to scold them with
      // an error toast for that. (Note: some browsers' cross-origin-
      // isolation headers can make Firebase misreport a popup as "closed"
      // even when it wasn't — if Google sign-in seems to silently do
      // nothing rather than show this specific case, that's the likely
      // cause; see the code comment on __signInWithGoogle.)
      return;
    }
    // BUGFIX: this used to show the exact same "Google sign-in was
    // cancelled or failed" message for every single failure reason,
    // which is why it kept showing even when nothing was actually
    // cancelled — there was no way to tell what really went wrong. Now
    // only truly unrecognized codes fall through to a generic message,
    // and even then the real code/message is included so it's actionable
    // instead of a dead end.
    toast(
      (code==='auth/unauthorized-domain') ? 'This site isn\'t authorized for Google sign-in yet — the domain needs to be added in Firebase Console → Authentication → Settings → Authorized domains.'
      : (code==='auth/operation-not-allowed') ? 'Google sign-in isn\'t enabled for this app yet — enable it in Firebase Console → Authentication → Sign-in method.'
      : (code==='auth/network-request-failed') ? 'Network problem — check your connection and try again.'
      : (code==='auth/internal-error') ? 'Google sign-in was blocked — this often happens when the browser blocks third-party cookies/popups. Try allowing pop-ups and cookies for this site.'
      : (code==='auth/web-storage-unsupported') ? 'This browser has cookies/storage disabled, which Google sign-in needs. Enable cookies and try again.'
      : /invalid_request/i.test((e && e.message) || '') ? 'Google rejected that sign-in request. If you tapped the button more than once, try again with a single tap.'
      : `Google sign-in failed: ${code || (e && e.message) || 'unknown error'}.`,
      'error'
    );
  } finally {
    __googleSignInInFlight = false;
  }
}
async function handleGoogleSignOut(){
  if(window.__googleSignOut) await window.__googleSignOut();
  toast('Signed out');
  render();
}

/* ---------------- LOGIN / SIGN UP ---------------- */
const GOOGLE_G_SVG = `<svg class="google-g" viewBox="0 0 48 48"><path fill="#FFC107" d="M43.611,20.083H42V20H24v8h11.303c-1.649,4.657-6.08,8-11.303,8c-6.627,0-12-5.373-12-12s5.373-12,12-12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C12.955,4,4,12.955,4,24s8.955,20,20,20s20-8.955,20-20C44,22.659,43.862,21.35,43.611,20.083z"/><path fill="#FF3D00" d="M6.306,14.691l6.571,4.819C14.655,15.108,18.961,12,24,12c3.059,0,5.842,1.154,7.961,3.039l5.657-5.657C34.046,6.053,29.268,4,24,4C16.318,4,9.656,8.337,6.306,14.691z"/><path fill="#4CAF50" d="M24,44c5.166,0,9.86-1.977,13.409-5.192l-6.19-5.238C29.211,35.091,26.715,36,24,36c-5.202,0-9.619-3.317-11.283-7.946l-6.522,5.025C9.505,39.556,16.227,44,24,44z"/><path fill="#1976D2" d="M43.611,20.083H42V20H24v8h11.303c-0.792,2.237-2.231,4.166-4.087,5.571c0.001-0.001,0.002-0.001,0.003-0.002l6.19,5.238C36.971,39.205,44,34,44,24C44,22.659,43.862,21.35,43.611,20.083z"/></svg>`;
function authLogoBlock(title, sub){
  const c = DB.content;
  return `
    <div class="auth-logo">
      <img src="${c.logoUrl||DEFAULT_LOGO_DATA_URI}" alt="" onerror="this.src='${DEFAULT_LOGO_DATA_URI}'">
      <span class="name">${escapeHtml(c.appName||'LEXDEN NOVA')}</span>
    </div>
    <h1 class="auth-title">${title}</h1>
    <p class="auth-sub">${sub}</p>`;
}
function screenLogin(){
  return `
  <div class="auth-shell">
    <button class="btn btn-ghost btn-sm auth-back" onclick="navigate('#profile')">← Back</button>
    <div class="auth-card">
      ${authLogoBlock('Welcome back', 'Sign in to sync your wishlist, orders and preferences.')}
      <button class="btn btn-google btn-block" onclick="handleGoogleSignIn()">${GOOGLE_G_SVG}<span>Continue with Google</span></button>
      <div class="auth-divider">or sign in with email</div>
      <div id="loginErr" class="text-2 small" style="color:var(--error);margin-bottom:6px;min-height:16px;"></div>
      <div class="form-field"><label>Email</label><input type="email" id="loginEmail" autocomplete="username" placeholder="you@example.com"></div>
      <div class="form-field">
        <label style="display:flex;justify-content:space-between;align-items:center;">
          <span>Password</span>
          <a style="color:var(--accent);font-weight:600;cursor:pointer;font-size:12px;" onclick="handleForgotPassword()">Forgot password?</a>
        </label>
        <input type="password" id="loginPass" autocomplete="current-password" placeholder="••••••••">
      </div>
      <button class="btn btn-primary btn-block" id="loginBtn" onclick="handleEmailLogin()">Sign In</button>
      <p class="auth-switch">New here? <a onclick="startSignupFlow()">Create an account</a></p>
    </div>
  </div>`;
}
/* "Forgot password?" (Login screen) — a small modal (matching the style
   of showSignInPromptModal) asking for the email, then handing it to
   Firebase's own sendPasswordResetEmail. Firebase emails a real, working
   reset link itself; there's no separate reset page to build here. */
function handleForgotPassword(){
  $('#forgotPasswordOverlay')?.remove();
  const prefill = ($('#loginEmail')?.value || '').trim();
  const overlay = document.createElement('div');
  overlay.id = 'forgotPasswordOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:950;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:360px;width:100%;padding:22px;">
      <h2 class="font-display" style="margin-bottom:6px;">Reset your password</h2>
      <p class="text-2 small" style="margin-bottom:14px;">Enter your account email — we'll send a link to reset your password.</p>
      <div id="forgotPassErr" class="text-2 small" style="color:var(--error);margin-bottom:6px;min-height:16px;"></div>
      <div class="form-field"><label>Email</label><input type="email" id="forgotPassEmail" autocomplete="username" placeholder="you@example.com" value="${escapeHtml(prefill)}"></div>
      <div class="flex gap-8" style="margin-top:6px;">
        <button class="btn btn-outline" style="flex:1;" onclick="closeForgotPasswordModal()">Cancel</button>
        <button class="btn btn-primary" style="flex:1;" id="forgotPassBtn" onclick="submitForgotPassword()">Send link</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
function closeForgotPasswordModal(){ $('#forgotPasswordOverlay')?.remove(); }
async function submitForgotPassword(){
  const email = ($('#forgotPassEmail')?.value || '').trim();
  const errEl = $('#forgotPassErr');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ if(errEl) errEl.textContent = 'Enter a valid email address.'; return; }
  if(errEl) errEl.textContent = '';
  const btn = $('#forgotPassBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Sending…'; }
  try{
    if(!window.__sendPasswordReset) throw new Error('Not ready yet — try again in a moment.');
    await withTimeout(window.__sendPasswordReset(email), 15000, 'That took too long — check your connection and try again.');
    closeForgotPasswordModal();
    toast(`Password reset email sent to ${email} — check your inbox (and spam folder).`, 'success');
  }catch(e){
    console.warn('Password reset failed', e);
    const code = e && e.code;
    if(errEl) errEl.textContent =
      (code==='auth/invalid-email') ? 'That email address looks invalid.'
      : (code==='auth/network-request-failed') ? 'Network problem — check your connection and try again.'
      // BUGFIX: deliberately do NOT reveal "no account exists for that
      // email" here — confirming which emails are/aren't registered is
      // exactly the kind of thing a reset flow shouldn't leak. Firebase's
      // own auth/user-not-found case is folded into this same generic,
      // reassuring message.
      : (code==='auth/user-not-found') ? 'If an account exists for that email, a reset link is on its way.'
      : (e && e.message) || 'Could not send the reset email — try again.';
    if(btn){ btn.disabled = false; btn.textContent = 'Send link'; }
    if(code==='auth/user-not-found'){
      // Still close as a "success-looking" outcome so the UI doesn't
      // visibly distinguish this case from a real account.
      setTimeout(()=>{ closeForgotPasswordModal(); toast(`If an account exists for ${email}, a reset link is on its way.`, 'success'); }, 400);
    }
  }
}
/* ---------------- SIGN-UP WIZARD (5 pages) ----------------
   Page 1: first/last name only.
   Page 2: gender + date of birth.
   Page 3: country -> state/region (every country in SIGNUP_COUNTRIES has
           a real region list in SIGNUP_REGIONS; falls back to free text
           if a country is ever added without one) -> the shopper's
           display currency is set from the country picked.
   Page 4: profile picture + email + password.
   Page 5: occupation + "how did you hear about us" -> Create Account.
   All picker fields use the custom .csel dropdown (not a native
   <select>), per spec — no OS/browser picker sheet. Google sign-in lives
   only on the Login screen (#login), not in this wizard. */
let signupWizard = null;
function resetSignupWizard(prefillEmail){
  signupWizard = {
    step:1, submitting:false, error:'',
    firstName:'', lastName:'', email:prefillEmail||'', password:'',
    avatarFile:null, avatarPreview:'', photoURL:'', avatarUploading:false, avatarUploadError:'',
    gender:'', dob:'', country:'', state:'', occupation:'', occupationOther:'', howHeard:'',
    // Legal acceptance is required to create an account. Marketing consent
    // is deliberately separate, optional and never pre-checked.
    legalAccepted:false, marketingConsent:false,
    // Email OTP verification state (step 4) — see sendSignupOtpCode() /
    // verifySignupOtpCode() below. verifiedEmail records exactly WHICH
    // address the token covers, so editing the email after verifying
    // correctly un-verifies it again instead of silently trusting a stale token.
    otpSent:false, otpSending:false, otpCode:'', otpVerifying:false, otpError:'',
    emailVerified:false, verifiedEmail:'', verifiedToken:'', otpCooldownUntil:0,
  };
}
function startSignupFlow(prefillEmail){ resetSignupWizard(prefillEmail); navigate('#signup'); }
function rerenderSignup(){
  const app = $('#app');
  if(!app) return;
  app.innerHTML = screenSignup();
  afterAuthRender();
}
function screenSignup(){
  if(!signupWizard) resetSignupWizard();
  const step = signupWizard.step;
  const backAction = (step===1) ? "navigate('#profile')" : "prevSignupStep()";
  const stepFns = { 1:signupStep1, 2:signupStep2, 3:signupStep3, 4:signupStep4, 5:signupStep5 };
  return `
  <div class="auth-shell">
    <button class="btn btn-ghost btn-sm auth-back" onclick="${backAction}">← Back</button>
    <div class="auth-card">
      ${authLogoBlock('Create your account', 'Join LEXDEN NOVA to save your wishlist and track orders.')}
      <div class="wizard-dots">${[1,2,3,4,5].map(n=>`<span class="${n===step?'active':''}"></span>`).join('')}</div>
      <div id="signupErr" class="text-2 small" style="color:var(--error);margin-bottom:6px;min-height:16px;">${escapeHtml(signupWizard.error||'')}</div>
      ${(stepFns[step]||signupStep1)()}
    </div>
  </div>`;
}
function signupStep1(){
  return `
    <div class="form-field"><label>First name</label><input type="text" id="wzFirstName" autocomplete="given-name" placeholder="Jane" value="${escapeHtml(signupWizard.firstName)}"></div>
    <div class="form-field"><label>Last name</label><input type="text" id="wzLastName" autocomplete="family-name" placeholder="Doe" value="${escapeHtml(signupWizard.lastName)}"></div>
    <button class="btn btn-primary btn-block" onclick="signupStep1Next()">Continue</button>
    <p class="auth-switch">Already have an account? <a onclick="navigate('#login')">Sign in</a></p>`;
}
function signupStep1Next(){
  const first = ($('#wzFirstName')?.value||'').trim();
  const last = ($('#wzLastName')?.value||'').trim();
  const errEl = $('#signupErr');
  if(!first || !last){ if(errEl) errEl.textContent = 'Enter your first and last name.'; return; }
  if(errEl) errEl.textContent = '';
  signupWizard.firstName = first; signupWizard.lastName = last;
  signupWizard.step = 2;
  rerenderSignup();
}
function signupStep2(){
  return `
    <div class="form-field"><label>Gender</label>${wizardDropdown('gender', SIGNUP_GENDER_OPTIONS, 'Select gender')}</div>
    <div class="form-field"><label>Date of birth</label><input type="date" id="wzDob" value="${escapeHtml(signupWizard.dob)}" max="${new Date().toISOString().slice(0,10)}"></div>
    <button class="btn btn-primary btn-block" onclick="signupStep2Next()">Continue</button>`;
}
function signupStep2Next(){
  const dob = $('#wzDob')?.value || '';
  const errEl = $('#signupErr');
  if(!signupWizard.gender){ if(errEl) errEl.textContent = 'Select your gender.'; return; }
  if(!dob){ if(errEl) errEl.textContent = 'Enter your date of birth.'; return; }
  if(errEl) errEl.textContent = '';
  signupWizard.dob = dob;
  signupWizard.step = 3;
  rerenderSignup();
}
function signupStep3(){
  const country = signupWizard.country;
  const regionList = SIGNUP_REGIONS[country];
  const currency = SIGNUP_COUNTRY_CURRENCY[country];
  return `
    <div class="form-field"><label>Country</label>${wizardDropdown('country', SIGNUP_COUNTRIES, 'Select your country')}</div>
    ${country ? `
      <div class="form-field"><label>State${regionList?'':' / Region'}</label>
        ${regionList
          ? wizardDropdown('state', regionList, 'Select your state / region')
          : `<input type="text" id="wzStateFree" placeholder="State / region" value="${escapeHtml(signupWizard.state)}" onchange="signupWizard.state=this.value.trim();">`}
      </div>
      <p class="text-2 small" style="margin:-4px 0 12px;">Prices will show in ${escapeHtml(currency||'NGN')} by default for ${escapeHtml(country)}.</p>
    ` : ''}
    <button class="btn btn-primary btn-block" onclick="signupStep3Next()">Continue</button>`;
}
function signupStep3Next(){
  const errEl = $('#signupErr');
  if(!signupWizard.country){ if(errEl) errEl.textContent = 'Select your country.'; return; }
  if(!signupWizard.state){ if(errEl) errEl.textContent = 'Select your state / region.'; return; }
  if(errEl) errEl.textContent = '';
  signupWizard.step = 4;
  rerenderSignup();
}
function signupStep4(){
  try{ warmApi(); }catch(e){}
  const uploading = signupWizard.avatarUploading;
  const hasPhoto = !!signupWizard.avatarPreview;
  const uploadDone = hasPhoto && !!signupWizard.photoURL;
  const uploadFailed = hasPhoto && !!signupWizard.avatarUploadError;
  return `
    <div class="auth-avatar-picker">
      <img id="signupAvatarPreview" src="${signupWizard.avatarPreview || DEFAULT_LOGO_DATA_URI}" alt="" style="${uploading?'opacity:.55;':''}">
      <div>
        <label class="btn btn-outline btn-sm" for="signupAvatarInput">${hasPhoto?'Choose a different picture':'Choose profile picture'}</label>
        <input type="file" id="signupAvatarInput" accept="image/*" style="display:none;" onchange="previewSignupAvatar(this)">
        ${uploading?`<div class="text-2 small" style="margin-top:6px;display:flex;align-items:center;gap:6px;"><span class="gsi-spinner" style="width:14px;height:14px;border-width:2px;"></span> Uploading photo…</div>`:''}
        ${uploadDone?`<div class="text-2 small" style="margin-top:6px;color:var(--accent);">✓ Photo uploaded</div>`:''}
        ${uploadFailed?`<div class="text-2 small" style="margin-top:6px;color:var(--error);">${escapeHtml(signupWizard.avatarUploadError)} <a style="color:var(--accent);cursor:pointer;font-weight:600;" onclick="retrySignupAvatarUpload()">Retry</a> · <a style="color:var(--accent);cursor:pointer;font-weight:600;" onclick="clearSignupAvatar()">Remove</a></div>`:''}
      </div>
    </div>
    <div class="form-field">
      <label>Email</label>
      <div style="display:flex;gap:8px;align-items:stretch;">
        <input type="email" id="wzEmail" autocomplete="username" placeholder="you@example.com" style="flex:1 1 auto;min-width:0;"
               value="${escapeHtml(signupWizard.email)}" oninput="onSignupEmailInput(this.value)">
        <button type="button" id="wzSendCodeBtn" class="btn btn-outline btn-sm" onclick="sendSignupOtp()"
                style="white-space:nowrap;flex:0 0 auto;min-width:104px;justify-content:center;padding-left:12px;padding-right:12px;display:${(isValidEmailStr(signupWizard.email) && !signupEmailIsVerified())?'inline-flex':'none'};"
                ${signupWizard.otpSending?'disabled':''}>${signupWizard.otpSending?'Sending…':(signupWizard.otpSent?'Resend code':'Send code')}</button>
      </div>
      <div id="wzSendErr" class="text-2 small" style="color:var(--error);margin-top:4px;display:${(signupWizard.otpError && !signupWizard.otpSent)?'block':'none'};">${escapeHtml(signupWizard.otpError||'')}</div>
      <div id="wzEmailVerifiedNote" class="text-2 small" style="color:var(--accent);margin-top:4px;display:${signupEmailIsVerified()?'block':'none'};">✓ Email verified</div>
    </div>
    <div id="wzOtpRow" class="form-field" style="display:${(signupWizard.otpSent && !signupEmailIsVerified())?'block':'none'};">
      <label>Enter the 6-digit code we emailed you</label>
      <div style="display:flex;gap:8px;">
        <input type="text" inputmode="numeric" pattern="[0-9]*" maxlength="6" id="wzOtpCode" placeholder="123456" style="flex:1;letter-spacing:4px;font-weight:700;"
               value="${escapeHtml(signupWizard.otpCode)}" oninput="signupWizard.otpCode=this.value.replace(/\D/g,'').slice(0,6);">
        <button type="button" class="btn btn-primary btn-sm" onclick="verifySignupOtp()" ${signupWizard.otpVerifying?'disabled':''}>${signupWizard.otpVerifying?'Verifying…':'Verify'}</button>
      </div>
      <div id="wzOtpErr" class="text-2 small" style="color:var(--error);min-height:16px;margin-top:4px;">${escapeHtml(signupWizard.otpError||'')}</div>
    </div>
    <div class="form-field"><label>Password</label><input type="password" id="wzPass" autocomplete="new-password" placeholder="At least 6 characters" value="${escapeHtml(signupWizard.password)}" onchange="signupWizard.password=this.value;"></div>
    <button class="btn btn-primary btn-block" id="signupStep4Btn" onclick="signupStep4Next()" ${uploading?'disabled':''}>${uploading?'Uploading photo…':'Continue'}</button>`;
}
function isValidEmailStr(v){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v||'').trim()); }
// True only when the CURRENT email field text is the exact address the
// stored token covers — editing the email after verifying (or after
// requesting a code) must re-lock the Continue button, never trust a stale
// verification against a since-changed address.
function signupEmailIsVerified(){ return !!(signupWizard.emailVerified && signupWizard.verifiedEmail === signupWizard.email); }
// Fires on every keystroke — deliberately does NOT call rerenderSignup()
// (that would blow away the input's focus/caret mid-type). Just keeps
// signupWizard.email in sync and toggles the few bits of UI that depend on
// it, directly, in place.
function onSignupEmailInput(val){
  const v = String(val||'').trim();
  const emailChanged = v !== signupWizard.email;
  signupWizard.email = v;
  if(emailChanged && (signupWizard.emailVerified || signupWizard.otpSent) && signupWizard.verifiedEmail !== v){
    signupWizard.emailVerified = false; signupWizard.verifiedToken = '';
    signupWizard.otpSent = false; signupWizard.otpCode = ''; signupWizard.otpError = '';
  }
  const btn = $('#wzSendCodeBtn');
  if(btn){
    btn.style.display = (isValidEmailStr(v) && !signupEmailIsVerified()) ? 'inline-flex' : 'none';
    btn.textContent = signupWizard.otpSending ? 'Sending…' : (signupWizard.otpSent ? 'Resend code' : 'Send code');
  }
  const note = $('#wzEmailVerifiedNote');
  if(note) note.style.display = signupEmailIsVerified() ? 'block' : 'none';
  const otpRow = $('#wzOtpRow');
  if(otpRow) otpRow.style.display = (signupWizard.otpSent && !signupEmailIsVerified()) ? 'block' : 'none';
}
async function sendSignupOtp(){
  const email = signupWizard.email;
  const errEl = $('#signupErr');
  if(!isValidEmailStr(email)){ if(errEl) errEl.textContent = 'Enter a valid, actual email address.'; return; }
  if(errEl) errEl.textContent = '';
  try{
    window.logLifecycleEvent && window.logLifecycleEvent('signup_started', email, {
      name: [signupWizard.firstName, signupWizard.lastName].filter(Boolean).join(' '),
      signupUrl: location.origin + location.pathname + '#signup'
    });
  }catch(e){}
  if(Date.now() < signupWizard.otpCooldownUntil){
    signupWizard.otpError = `Wait ${Math.ceil((signupWizard.otpCooldownUntil-Date.now())/1000)}s before requesting another code.`;
    rerenderSignup(); return;
  }
  signupWizard.otpSending = true; signupWizard.otpError = '';
  rerenderSignup();
  let result;
  try{
    result = await Promise.race([
      sendSignupOtpCode(email),
      new Promise(res=>setTimeout(()=>res({ ok:false, error:'That took too long. Please tap Send code again. [10s]' }), 10500))
    ]);
  }catch(e){
    result = { ok:false, error:'Could not send the code. Please try again. [' + String(e && e.message || e).slice(0,60) + ']' };
  }
  signupWizard.otpSending = false;
  if(!result.ok){ signupWizard.otpError = result.error; rerenderSignup(); return; }
  signupWizard.otpSent = true; signupWizard.otpCooldownUntil = Date.now() + 60000;
  rerenderSignup();
  // The shopper's very next move is typing the 6 digits Brevo just sent —
  // put the cursor there the instant the box appears.
  setTimeout(()=>{ $('#wzOtpCode')?.focus(); }, 30);
}
async function verifySignupOtp(){
  const email = signupWizard.email;
  const code = ($('#wzOtpCode')?.value||'').trim();
  if(code.length !== 6){ signupWizard.otpError = 'Enter the 6-digit code.'; rerenderSignup(); return; }
  signupWizard.otpVerifying = true; signupWizard.otpError = '';
  rerenderSignup();
  let result;
  try{ result = await verifySignupOtpCode(email, code); }
  catch(e){ result = { ok:false, error:'Could not verify the code. Please try again.' }; }
  signupWizard.otpVerifying = false;
  if(!result.ok){ signupWizard.otpError = result.error; rerenderSignup(); return; }
  signupWizard.emailVerified = true; signupWizard.verifiedEmail = email; signupWizard.verifiedToken = result.verifiedToken;
  signupWizard.otpError = '';
  rerenderSignup();
}
// A photo is optional — Continue only ever waits on an upload that's
// actually in flight. If nothing was chosen, or a chosen photo already
// finished (or was removed after a failure), there's nothing to block on.
function signupStep4Next(){
  const email = ($('#wzEmail')?.value||'').trim();
  const pass = $('#wzPass')?.value||'';
  const errEl = $('#signupErr');
  if(signupWizard.avatarUploading){ if(errEl) errEl.textContent = 'Hang on — your photo is still uploading.'; return; }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ if(errEl) errEl.textContent = 'Enter a valid, actual email address.'; return; }
  if(!signupWizard.emailVerified || signupWizard.verifiedEmail !== email){ if(errEl) errEl.textContent = 'Verify your email address first — tap "Send code" and enter it.'; return; }
  if(pass.length < 6){ if(errEl) errEl.textContent = 'Password must be at least 6 characters.'; return; }
  if(errEl) errEl.textContent = '';
  signupWizard.email = email;
  signupWizard.password = pass;
  signupWizard.step = 5;
  rerenderSignup();
}
function signupUserIsUnder18(){
  if(!signupWizard || !signupWizard.dob) return true;
  const dob = new Date(signupWizard.dob + 'T00:00:00');
  if(Number.isNaN(dob.getTime())) return true;
  const today = new Date();
  let age = today.getFullYear() - dob.getFullYear();
  const monthDelta = today.getMonth() - dob.getMonth();
  if(monthDelta < 0 || (monthDelta === 0 && today.getDate() < dob.getDate())) age--;
  return age < 18;
}
function signupStep5(){
  const under18 = signupUserIsUnder18();
  return `
    <div class="form-field"><label>Occupation</label>${wizardDropdown('occupation', SIGNUP_OCCUPATION_OPTIONS, 'Select occupation')}</div>
    ${signupWizard.occupation==='Other' ? `
    <div class="form-field"><label>Please specify</label><input type="text" id="wzOccupationOther" placeholder="Tell us what you do" value="${escapeHtml(signupWizard.occupationOther)}" onchange="signupWizard.occupationOther=this.value.trim();"></div>
    ` : ''}
    <div class="form-field"><label>How did you hear about us?</label>${wizardDropdown('howHeard', SIGNUP_HOW_HEARD_OPTIONS, 'Select an option')}</div>

    <div style="margin:14px 0 12px;display:grid;gap:12px;">
      <label for="wzLegalConsent" style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:12.5px;line-height:1.5;">
        <input type="checkbox" id="wzLegalConsent" ${signupWizard.legalAccepted?'checked':''}
          onchange="signupWizard.legalAccepted=this.checked;" style="margin-top:3px;flex:none;">
        <span>I agree to the <a href="legal/terms.html" target="_blank" rel="noopener" onclick="event.stopPropagation();" style="color:var(--accent);font-weight:600;">LEXDEN NOVA Terms of Use</a> and acknowledge the <a href="legal/privacy.html" target="_blank" rel="noopener" onclick="event.stopPropagation();" style="color:var(--accent);font-weight:600;">Privacy Notice</a>.</span>
      </label>

      ${under18 ? `
        <div class="text-2 small" style="padding-left:26px;line-height:1.5;">
          Marketing emails are not enabled for accounts under 18 through this signup form. Essential account, security and transaction emails may still be sent when needed.
        </div>
      ` : `
        <label for="wzMarketingConsent" style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;font-size:12.5px;line-height:1.5;">
          <input type="checkbox" id="wzMarketingConsent" ${signupWizard.marketingConsent?'checked':''}
            onchange="signupWizard.marketingConsent=this.checked;" style="margin-top:3px;flex:none;">
          <span>I want to receive LEXDEN NOVA emails about new products, services, offers and updates. I can unsubscribe at any time.</span>
        </label>
      `}
    </div>

    <button class="btn btn-primary btn-block" id="signupFinalBtn" onclick="finishSignup()" ${signupWizard.submitting?'disabled':''}>${signupWizard.submitting?'Creating account…':'Create Account'}</button>`;
}
function prevSignupStep(){
  signupWizard.step = Math.max(1, signupWizard.step - 1);
  rerenderSignup();
}
// Re-query live instead of caching once at the top of finishSignup — a
// stray rerenderSignup() (e.g. from opening a dropdown) while a submission
// is in flight recreates these nodes, and writing to the old detached copy
// would silently do nothing visible to the user.
function setSignupError(msg){ if(signupWizard) signupWizard.error = msg||''; const el = $('#signupErr'); if(el) el.textContent = msg||''; }
function setSignupButtonState(disabled, text){ const btn = $('#signupFinalBtn'); if(btn){ btn.disabled = disabled; btn.textContent = text; } }
async function finishSignup(){
  if(!signupWizard.occupation){ setSignupError('Select an occupation.'); return; }
  if(signupWizard.occupation==='Other' && !signupWizard.occupationOther){ setSignupError('Tell us what you do.'); return; }
  if(!signupWizard.howHeard){ setSignupError('Let us know how you heard about us.'); return; }
  if(!signupWizard.legalAccepted){ setSignupError('Please accept the Terms of Use and acknowledge the Privacy Notice to create your account.'); return; }
  if(signupUserIsUnder18()) signupWizard.marketingConsent = false;
  setSignupError('');
  signupWizard.submitting = true;
  setSignupButtonState(true, 'Creating account…');
  const fullName = `${signupWizard.firstName} ${signupWizard.lastName}`.trim();
  const address = [signupWizard.state, signupWizard.country].filter(Boolean).join(', ');
  const finalOccupation = signupWizard.occupation==='Other' ? signupWizard.occupationOther : signupWizard.occupation;
  const consentAt = new Date().toISOString();
  try{
    if(!window.__emailSignUp) throw new Error('Sign-up is not ready yet — try again in a moment.');
    // Every network step below is wrapped in withTimeout so a stalled
    // connection always ends in a visible error instead of an endless
    // "Creating account…" spinner.
    const user = await withTimeout(
      window.__emailSignUp(signupWizard.email, signupWizard.password, fullName),
      20000, 'Sign-up is taking too long — check your connection and try again.'
    );
    const uid = user.uid;
    const email = signupWizard.email;
    // Flip Firebase Auth's emailVerified flag using the proof collected on
    // step 4 (OTP verified BEFORE this account even existed) — best-effort,
    // never blocks or fails the sign-up itself if this call doesn't land.
    confirmEmailVerifiedServerSide(uid, email, signupWizard.verifiedToken).catch(()=>{});
    // The photo (if any) was already uploaded back on step 4 — Continue
    // there was disabled until it finished, so signupWizard.photoURL is
    // guaranteed to be ready here already; no need to upload again.
    let photoURL = signupWizard.photoURL || '';
    if(!photoURL) photoURL = defaultAvatarForGender(signupWizard.gender);
    await withTimeout(
      window.__novaUpsertUserProfile({
        uid, name: fullName, email, photoURL, address,
        occupation: finalOccupation, gender: signupWizard.gender, dob: signupWizard.dob,
        country: signupWizard.country, state: signupWizard.state, howHeard: signupWizard.howHeard,
        legalAccepted: true, legalAcceptedAt: consentAt,
        termsVersion: '1.0', privacyVersion: '1.0',
        marketingConsent: !!signupWizard.marketingConsent,
        marketingConsentAt: signupWizard.marketingConsent ? consentAt : '',
        marketingConsentSource: signupWizard.marketingConsent ? 'account-signup' : '',
        provider: 'password',
      }),
      15000, 'Saving your profile is taking too long.'
    ).catch(e=>{
      // Don't block the whole flow on this write — the account itself was
      // already created successfully. But onAuthStateChanged's own upsert
      // (see the module script) only ever re-saves the basics (name/
      // email/photo), never the extended fields (gender, dob, country,
      // state, occupation, howHeard) — those live ONLY here. If this
      // write timed out or failed, they'd otherwise be silently lost the
      // moment the shopper refreshes. Retry once, quietly, with more
      // time; only bother the shopper if it fails twice.
      console.warn('Profile save failed or timed out — retrying once', e);
      window.__novaUpsertUserProfile({
        uid, name: fullName, email, photoURL, address,
        occupation: finalOccupation, gender: signupWizard.gender, dob: signupWizard.dob,
        country: signupWizard.country, state: signupWizard.state, howHeard: signupWizard.howHeard,
        legalAccepted: true, legalAcceptedAt: consentAt,
        termsVersion: '1.0', privacyVersion: '1.0',
        marketingConsent: !!signupWizard.marketingConsent,
        marketingConsentAt: signupWizard.marketingConsent ? consentAt : '',
        marketingConsentSource: signupWizard.marketingConsent ? 'account-signup' : '',
        provider: 'password',
      }).catch(e2=>{
        console.warn('Profile save retry also failed', e2);
        toast('Your account was created, but some profile details didn\'t save — please double-check your Profile page.', 'error');
      });
    });
    if(signupWizard.country && SIGNUP_COUNTRY_CURRENCY[signupWizard.country]){
      lsSet(LS_KEYS.currency, SIGNUP_COUNTRY_CURRENCY[signupWizard.country]);
    }
    // We already have every field the Profile tab needs right here (no
    // need to wait on a Firestore re-fetch or guess with a timeout like
    // before) — set it directly so navigating to #profile shows the
    // fully completed account on the very first paint.
    window.__fbShopper = {
      uid, name: fullName, email, photoURL, address,
      occupation: finalOccupation, gender: signupWizard.gender, dob: signupWizard.dob,
      country: signupWizard.country, state: signupWizard.state, howHeard: signupWizard.howHeard,
      legalAccepted: true, legalAcceptedAt: consentAt,
      termsVersion: '1.0', privacyVersion: '1.0',
      marketingConsent: !!signupWizard.marketingConsent,
      marketingConsentAt: signupWizard.marketingConsent ? consentAt : '',
      marketingConsentSource: signupWizard.marketingConsent ? 'account-signup' : '',
      provider: 'password', profileSetupDone: true,
    };
    if(signupWizard.marketingConsent){
      // Best-effort only: account creation must never fail because the
      // newsletter collection is temporarily unavailable.
      Promise.resolve(pushNewsletterSubToCloud(email, 'account-signup', {
        uid, name: fullName, consentAt, consentTextVersion: 'signup-marketing-v1'
      })).catch(()=>{});
    }
    toast('You have successfully created your account! 🎉', 'success');
    resetSignupWizard();
    if(!applyPendingFeedLikeIfAny()) navigate('#profile');
    render();
  }catch(e){
    console.warn('Sign-up failed', e);
    const code = e && e.code;
    setSignupError(
      (code==='auth/email-already-in-use') ? 'That email is already registered — try signing in instead.'
      : (code==='auth/invalid-email') ? 'That email address looks invalid.'
      : (code==='auth/weak-password') ? 'Password is too weak — use at least 6 characters.'
      : (code==='auth/network-request-failed') ? 'Network problem — check your connection and try again.'
      : (code==='auth/operation-not-allowed') ? 'Email sign-up is not enabled yet — contact support.'
      : (code==='auth/too-many-requests') ? 'Too many attempts — please wait a moment and try again.'
      : (e && e.message) || 'Could not create account.'
    );
    signupWizard.submitting = false;
    rerenderSignup();
  }
}
/* ---- custom dropdown used by the wizard's picker fields (gender,
   country, state, occupation, how-heard) — deliberately not a native
   <select>, per spec. ---- */
function wizardDropdown(field, options, placeholder){
  const val = signupWizard[field];
  const norm = options.map(o => typeof o === 'string' ? {value:o, label:o} : o);
  const sel = norm.find(o=>o.value===val);
  return `
  <div class="csel" id="csel_${field}">
    <button type="button" class="csel-btn ${sel?'':'placeholder'}" onclick="toggleWizardSelect('${field}')">
      <span>${escapeHtml(sel?sel.label:placeholder)}</span><span class="csel-arrow">▾</span>
    </button>
    <div class="csel-panel">
      ${norm.map(o=>`<div class="csel-opt ${o.value===val?'active':''}" onclick="pickWizardOption('${field}','${jsStr(o.value)}')">${escapeHtml(o.label)}</div>`).join('')}
    </div>
  </div>`;
}
function toggleWizardSelect(field){
  const el = $('#csel_'+field);
  if(!el) return;
  const wasOpen = el.classList.contains('open');
  $all('.csel.open').forEach(o=>o.classList.remove('open'));
  if(!wasOpen) el.classList.add('open');
}
function pickWizardOption(field, value){
  signupWizard[field] = value;
  if(field === 'country'){
    signupWizard.state = ''; // state list depends on country — stale pick doesn't carry over
    const cur = SIGNUP_COUNTRY_CURRENCY[value];
    if(cur) lsSet(LS_KEYS.currency, cur); // follow the shopper's home currency as they pick — no full app re-render needed mid-wizard
  }
  rerenderSignup();
}
document.addEventListener('click', function(e){
  if(!e.target.closest('.csel')) closeAllCustomSelects();
});
function afterAuthRender(){
  window.scrollTo({top:0, behavior:'auto'});
}
// Returns the admin-configured default avatar for a gender, falling back
// to the app logo if none has been uploaded for that gender yet.
function defaultAvatarForGender(gender){
  const c = DB.content;
  const map = { male:c.defaultAvatarMale, female:c.defaultAvatarFemale };
  return (gender && map[gender]) ? map[gender] : (DEFAULT_LOGO_DATA_URI);
}
// Uploads the chosen profile picture immediately (rather than waiting
// until final submit) so the wizard can show real upload progress and — as
// requested — keep the step's Continue button disabled ("not glow") until
// the photo has actually finished uploading, instead of letting someone
// move on while it's silently still in flight or has failed.
function previewSignupAvatar(inputEl){
  const file = inputEl.files && inputEl.files[0];
  if(!file) return;
  if(file.size > 8*1024*1024){ toast('Image too large — 8MB max', 'error'); inputEl.value=''; return; }
  const reader = new FileReader();
  reader.onload = e=>{
    signupWizard.avatarFile = file;
    signupWizard.avatarPreview = e.target.result;
    signupWizard.photoURL = '';
    signupWizard.avatarUploadError = '';
    uploadSignupAvatar(file);
  };
  reader.readAsDataURL(file);
}
async function uploadSignupAvatar(file){
  signupWizard.avatarUploading = true;
  signupWizard.avatarUploadError = '';
  rerenderSignup();
  try{
    const upFile = await resizeAvatarImage(file);
    const url = await withTimeout(cloudinaryUploadFile(upFile, 8), 45000, 'Photo upload is taking too long — try again with a stronger connection.');
    // Guard against a since-superseded selection (picked a different photo,
    // or removed it) while this upload was in flight.
    if(signupWizard.avatarFile !== file) return;
    signupWizard.photoURL = url;
    signupWizard.avatarUploading = false;
    rerenderSignup();
  }catch(err){
    console.warn('Avatar upload failed', err);
    if(signupWizard.avatarFile !== file) return;
    signupWizard.avatarUploading = false;
    signupWizard.avatarUploadError = uploadErrorMessage(err);
    rerenderSignup();
  }
}
function retrySignupAvatarUpload(){
  if(signupWizard.avatarFile) uploadSignupAvatar(signupWizard.avatarFile);
}
function clearSignupAvatar(){
  signupWizard.avatarFile = null;
  signupWizard.avatarPreview = '';
  signupWizard.photoURL = '';
  signupWizard.avatarUploading = false;
  signupWizard.avatarUploadError = '';
  rerenderSignup();
}
// Shows a "no account found — want to create one?" message in place of a
// plain error, with a link straight into the Sign Up wizard, email
// pre-filled so the person doesn't have to retype it.
function showLoginNoAccountPrompt(email){
  const el = $('#loginErr');
  if(!el) return;
  el.innerHTML = `We couldn't find an account for that email. <a onclick="startSignupFlow('${jsStr(email)}')" style="text-decoration:underline;cursor:pointer;">Create one?</a>`;
}
async function handleEmailLogin(){
  const email = ($('#loginEmail')?.value||'').trim();
  const pass = $('#loginPass')?.value||'';
  const errEl = $('#loginErr');
  const btn = $('#loginBtn');
  if(errEl) errEl.textContent = '';
  if(!email || !pass){ if(errEl) errEl.textContent = 'Enter both email and password.'; return; }
  if(!window.__emailSignIn){ toast('Sign-in is not ready yet — try again in a moment.', 'error'); return; }
  if(btn){ btn.disabled = true; btn.textContent = 'Signing in…'; }
  try{
    const user = await withTimeout(window.__emailSignIn(email, pass), 20000, 'Sign-in is taking too long — check your connection and try again.');
    // Populate the shopper profile from the signed-in user right away —
    // see the matching comment in handleGoogleSignIn — so the Profile
    // tab is correct on its first paint instead of relying on a guessed
    // delay for onAuthStateChanged to catch up.
    window.__fbShopper = { uid:user.uid, name:user.displayName||'', email:user.email||'', photoURL:user.photoURL||'', provider:'password' };
    toast('Signed in!', 'success');
    if(!applyPendingFeedLikeIfAny()) navigate('#profile');
    render();
  }catch(e){
    // Surface the real reason instead of always blaming the password —
    // a network/config problem (wrong API key, offline, etc.) looks
    // identical to a wrong password otherwise, which is what made sign-in
    // look like it was "always failing" for reasons that had nothing to
    // do with the credentials actually being wrong.
    console.warn('Email sign-in failed', e);
    const code = e && e.code;
    if(code==='auth/user-not-found'){
      // Firebase said, unambiguously, that no account exists for this
      // email — send the person to Sign Up instead of a dead-end error.
      showLoginNoAccountPrompt(email);
    }else if(code==='auth/invalid-credential' || code==='auth/wrong-password'){
      // Newer Firebase projects return the same generic
      // auth/invalid-credential for both "wrong password" AND "no such
      // account" (to prevent attackers from probing which emails are
      // registered).
      // BUGFIX: this used to call __checkEmailExists and treat exists===
      // false as proof the account didn't exist, sending the person to
      // "we couldn't find an account for that email". But most current
      // Firebase projects have Email Enumeration Protection turned on,
      // which makes fetchSignInMethodsForEmail (what __checkEmailExists
      // calls) return an EMPTY list for every email, real accounts
      // included — so that branch was confidently lying to real,
      // already-registered users. An empty/false result here no longer
      // proves anything, so we only ever use this check as a positive
      // signal (a non-empty result really does mean the account exists),
      // and otherwise fall back to a neutral message that doesn't assert
      // something we can't actually verify.
      const exists = window.__checkEmailExists ? await window.__checkEmailExists(email) : null;
      if(exists === true){
        if(errEl) errEl.textContent = 'Incorrect password.';
      }else if(errEl){
        errEl.innerHTML = 'Incorrect email or password. <a onclick="startSignupFlow(\''+jsStr(email)+'\')" style="text-decoration:underline;cursor:pointer;">New here? Create an account</a>';
      }
    }else if(errEl){
      errEl.textContent =
        (code==='auth/too-many-requests') ? 'Too many attempts — please wait a moment and try again.'
        : (code==='auth/network-request-failed') ? 'Network problem — check your connection and try again.'
        : 'Could not sign in (' + (code||(e&&e.message)||'unknown error') + ').';
    }
    if(btn){ btn.disabled = false; btn.textContent = 'Sign In'; }
  }
}
// NOTE: single-page email sign-up (old handleEmailSignup) is now handled
// by the 5-step wizard instead — see screenSignup/finishSignup above,
// defined alongside screenLogin.

/* ---------------- ORDER HISTORY ---------------- */
function screenOrders(){
  const shopper = window.__fbShopper;
  const pending = getPendingPayments();
  if(!shopper){
    return `
    <div class="screen">
      <h1 class="screen-title">Order History</h1>
      ${pendingPaymentsHtml(pending)}
      <div class="empty-state"><div class="ic">${icon('package')}</div><h3>Sign in to see your orders</h3><p>Orders are tied to your account, so sign in with Google first.</p><button class="btn btn-primary" onclick="navigate('#profile')">Go to Profile</button></div>
    </div>`;
  }
  setTimeout(loadOrdersIntoScreen, 0);
  return `
  <div class="screen">
    <h1 class="screen-title">Order History</h1>
    ${pendingPaymentsHtml(pending)}
    <div id="ordersWrap"><div class="log-row text-2 small">Loading your orders…</div></div>
  </div>`;
}
/* A payment Paystack confirmed but we haven't finished delivering yet —
   surfaced here (not just in the moment-of-payment modal) so it's never
   truly lost even if the shopper closed that modal, closed the tab, or
   paid on a different device/session. */
function pendingPaymentsHtml(pending){
  if(!pending || !pending.length) return '';
  return `
  <div class="section">
    <div class="section-head"><h2>⏳ Confirming (${pending.length})</h2></div>
    ${pending.map(entry=>`
      <div class="card" style="padding:14px;margin-bottom:10px;border:1px solid var(--warning);">
        <div style="font-weight:700;">${escapeHtml(entry.productName||'Order')}</div>
        <div class="text-2 small mono">Ref: ${escapeHtml(entry.reference)}</div>
        <div class="text-2 small" style="margin:4px 0 10px;">Payment received — still confirming delivery. This retries automatically, or tap below.</div>
        <button class="btn btn-outline btn-sm" onclick="retrySinglePendingPayment('${entry.reference}').then(()=>{ if(location.hash==='#orders') render(); })">Retry now</button>
      </div>`).join('')}
  </div>`;
}
// Orders are written server-side (see the /api/verify-paystack note near
// startPaystackCheckout) so we don't control their exact shape from here —
// this checks every field name that server function plausibly uses for
// "which product", rather than assuming one, so the Download button still
// shows up even if that endpoint's payload changes slightly.
function orderProductId(o){
  return (o.items && o.items[0] && (o.items[0].id || o.items[0].productId)) || o.productId || null;
}
function orderDownloadHtml(o){
  if(o.status!=='success') return '';
  const pid = orderProductId(o);
  const prod = pid ? findProduct(pid) : null;
  if(prod && prod.secureDelivery && (o.paystackReference||o.reference)) return `<div style="margin-top:10px;"><button type="button" class="btn btn-primary btn-sm" onclick="openSecureAccess('${jsStr(o.paystackReference||o.reference)}')">🎓 Get course access</button></div>`;
  const link = prod && (prod.deliveryLink || prod.fileUrl);
  if(!link) return '';
  return `<div style="margin-top:10px;"><button type="button" class="btn btn-primary btn-sm" onclick="forceDownloadFile('${jsStr(link)}','${jsStr(downloadFilenameFor(prod))}')">⬇️ Download</button></div>`;
}
async function loadOrdersIntoScreen(){
  const wrap = $('#ordersWrap');
  if(!wrap) return;
  const orders = await fetchMyOrders();
  if(!orders.length){
    wrap.innerHTML = `<div class="empty-state"><div class="ic">${icon('package')}</div><h3>No orders yet</h3><p>Anything you buy will show up here once payment is confirmed.</p><button class="btn btn-primary" onclick="navigate('#products')">Browse Products</button></div>`;
    return;
  }
  wrap.innerHTML = orders.map(o=>`
    <div class="card" style="padding:14px;margin-bottom:10px;">
      <div class="flex" style="justify-content:space-between;align-items:flex-start;">
        <div>
          <div style="font-weight:700;">${escapeHtml((o.items&&o.items[0]&&o.items[0].name)||'Order')}</div>
          <div class="text-2 small mono">Ref: ${escapeHtml(o.paystackReference||o.reference||'')}</div>
          <div class="text-2 small">${o.timestamp?new Date(o.timestamp).toLocaleString():''}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-weight:700;">${escapeHtml(o.currency||'NGN')} ${(o.totalAmount||0).toLocaleString()}</div>
          <span class="small" style="color:${o.status==='success'?'var(--success)':o.status==='failed'?'var(--error)':'var(--warning)'};">${escapeHtml(o.status||'pending')}</span>
        </div>
      </div>
      ${orderDownloadHtml(o)}
    </div>`).join('');
}

// Combined notifications control — this single Settings toggle now covers
// what used to be two separate, disconnected things: a local on/off
// preference here, and a real "Enable Notifications" button in the Menu
// tab that requested actual browser push permission. Removing the Menu
// button in favor of this one switch means this toggle has to do both
// jobs: request real permission when turned on, and reflect the real
// state (see window.__notificationsEnabled() above) rather than a
// separate flag that could disagree with it.
async function toggleNotif(el){
  const isOn = el.classList.contains('on');
  if(!isOn){
    el.classList.add('on'); // optimistic — reverted below if permission isn't granted
    const ok = await window.__enableNotifications();
    if(!ok){ el.classList.remove('on'); return; } // __enableNotifications already toasted why
  } else {
    // Browser push permission itself can't be revoked from JS once granted —
    // this just stops sending this device new notifications.
    localStorage.removeItem('ln_notif_enabled');
    el.classList.remove('on');
    toast('Notifications off');
  }
}

function brandIcon(name){
  const icons = {
    youtube:'<svg viewBox="0 0 24 24" width="20" height="20" fill="#FF0000"><path d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.4 3.5 12 3.5 12 3.5s-7.4 0-9.4.6A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c2 .6 9.4.6 9.4.6s7.4 0 9.4-.6a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8ZM9.6 15.6V8.4l6.3 3.6-6.3 3.6Z"/></svg>',
    tiktok:'<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M16.6 3c.4 2.2 1.9 3.9 4.4 4.1v3c-1.6.1-3-.4-4.3-1.3v6.6c0 4-3.2 6.6-6.7 6.1a5.9 5.9 0 0 1-4.8-6.4c.4-3 3.1-5.2 6.1-4.9v3.1c-.4-.1-.9-.1-1.4 0a2.7 2.7 0 0 0-2 3c.2 1.4 1.6 2.4 3.1 2.1a2.6 2.6 0 0 0 2.1-2.6V3h3.5Z"/></svg>',
    instagram:'<svg viewBox="0 0 24 24" width="20" height="20"><defs><linearGradient id="igg" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#FED576"/><stop offset=".3" stop-color="#F47133"/><stop offset=".6" stop-color="#BC3081"/><stop offset="1" stop-color="#4C63D2"/></linearGradient></defs><path fill="url(#igg)" d="M12 2.2c3.2 0 3.6 0 4.9.1 1.2.1 2 .3 2.7.6a5.4 5.4 0 0 1 2 1.3 5.4 5.4 0 0 1 1.3 2c.3.7.5 1.5.6 2.7.1 1.3.1 1.7.1 4.9s0 3.6-.1 4.9c-.1 1.2-.3 2-.6 2.7a5.8 5.8 0 0 1-3.3 3.3c-.7.3-1.5.5-2.7.6-1.3.1-1.7.1-4.9.1s-3.6 0-4.9-.1c-1.2-.1-2-.3-2.7-.6a5.4 5.4 0 0 1-2-1.3 5.4 5.4 0 0 1-1.3-2c-.3-.7-.5-1.5-.6-2.7C2.2 15.6 2.2 15.2 2.2 12s0-3.6.1-4.9c.1-1.2.3-2 .6-2.7a5.4 5.4 0 0 1 1.3-2 5.4 5.4 0 0 1 2-1.3c.7-.3 1.5-.5 2.7-.6C8.4 2.2 8.8 2.2 12 2.2Zm0 2.7c-3.1 0-3.5 0-4.7.1-1 0-1.6.2-2 .4-.5.2-.8.4-1.2.8-.4.4-.6.7-.8 1.2-.2.4-.3 1-.4 2-.1 1.2-.1 1.6-.1 4.6s0 3.5.1 4.7c0 1 .2 1.6.4 2 .2.5.4.8.8 1.2.4.4.7.6 1.2.8.4.2 1 .3 2 .4 1.2.1 1.6.1 4.7.1s3.5 0 4.6-.1c1-.1 1.6-.2 2-.4.5-.2.8-.4 1.2-.8.4-.4.6-.7.8-1.2.2-.4.3-1 .4-2 .1-1.2.1-1.6.1-4.7s0-3.5-.1-4.6c-.1-1-.2-1.6-.4-2a3.2 3.2 0 0 0-.8-1.2 3.2 3.2 0 0 0-1.2-.8c-.4-.2-1-.3-2-.4-1.2-.1-1.6-.1-4.7-.1Zm0 3.3a5.8 5.8 0 1 1 0 11.6 5.8 5.8 0 0 1 0-11.6Zm0 9.6a3.8 3.8 0 1 0 0-7.6 3.8 3.8 0 0 0 0 7.6Zm6-9.8a1.4 1.4 0 1 1-2.8 0 1.4 1.4 0 0 1 2.8 0Z"/></svg>',
    facebook:'<svg viewBox="0 0 24 24" width="20" height="20" fill="#1877F2"><path d="M24 12.1C24 5.4 18.6 0 12 0S0 5.4 0 12.1c0 6 4.4 11 10.1 11.9v-8.4H7.1v-3.5h3V9.4c0-3 1.7-4.6 4.5-4.6 1.3 0 2.6.2 2.6.2v2.9h-1.5c-1.5 0-1.9.9-1.9 1.8v2.2h3.3l-.5 3.5h-2.8V24C19.6 23.1 24 18 24 12.1Z"/></svg>',
    whatsapp:'<svg viewBox="0 0 24 24" width="20" height="20" fill="#25D366"><path d="M12 0C5.4 0 0 5.4 0 12c0 2.1.6 4.1 1.6 5.9L0 24l6.3-1.6A12 12 0 0 0 12 24c6.6 0 12-5.4 12-12S18.6 0 12 0Zm0 22a10 10 0 0 1-5.1-1.4l-.4-.2-3.7 1 1-3.6-.2-.4A10 10 0 1 1 12 22Zm5.5-7.4c-.3-.1-1.8-.9-2-1-.3-.1-.5-.1-.7.1-.2.3-.8 1-.9 1.1-.2.2-.3.2-.6.1a8.2 8.2 0 0 1-2.4-1.5 9 9 0 0 1-1.7-2.1c-.2-.3 0-.5.1-.6l.4-.5.3-.4c0-.2 0-.3 0-.5-.1-.1-.7-1.7-1-2.3-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1c.1.2 2.2 3.4 5.4 4.7.7.3 1.3.5 1.8.7.7.2 1.4.2 1.9.1.6-.1 1.8-.7 2-1.4.3-.7.3-1.3.2-1.4-.1-.2-.3-.3-.6-.4Z"/></svg>',
    email:'<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M2 4h20a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm10 8.5L4.2 6H19.8L12 12.5ZM3 7.4V18h18V7.4l-9 7.4-9-7.4Z"/></svg>',
  };
  return icons[name] || '';
}

/* ---------------- MENU ---------------- */
/* ---------------- ABOUT US ---------------- */
function screenAbout(){
  const c = DB.content;
  const team = DB.management;
  return `
  <div class="screen">
    <button class="btn btn-ghost btn-sm" style="margin-bottom:10px;" onclick="history.back()">← Back</button>
    <h1 class="screen-title">About ${escapeHtml(c.appName||'LEXDEN NOVA')}</h1>
    <p class="screen-sub">Who we are, and why this site exists</p>

    <div class="card" style="padding:16px;margin-bottom:16px;">
      <h3 style="font-size:15px;margin-bottom:8px;">Our story</h3>
      <p class="text-2" style="font-size:13.5px;">${escapeHtml(c.aboutText)}</p>
    </div>

    <div class="card" style="padding:16px;margin-bottom:16px;">
      <h3 style="font-size:15px;margin-bottom:8px;">🎯 Our mission</h3>
      <p class="text-2" style="font-size:13.5px;">${escapeHtml(c.missionText||'')}</p>
    </div>

    <div class="card" style="padding:16px;margin-bottom:16px;">
      <h3 style="font-size:15px;margin-bottom:8px;">🔭 Our vision</h3>
      <p class="text-2" style="font-size:13.5px;">${escapeHtml(c.visionText||'')}</p>
    </div>

    ${team.length?`<div class="section">
      <div class="section-head"><h2>Management</h2></div>
      <div class="card" style="padding:16px;">
        ${team.map(m=>`
          <div class="flex gap-8" style="align-items:flex-start;margin-bottom:14px;">
            <div class="avatar">${escapeHtml((m.name||'LN').slice(0,2).toUpperCase())}</div>
            <div>
              <div style="font-weight:700;font-size:14px;">${escapeHtml(m.name)}</div>
              <div class="text-2 small" style="margin-bottom:4px;">${escapeHtml(m.role||'')}</div>
              <div class="text-2" style="font-size:13px;">${escapeHtml(m.bio||'')}</div>
            </div>
          </div>`).join('')}
      </div>
    </div>`:''}

    <div class="section">
      <div class="section-head"><h2>Get in touch</h2></div>
      <div class="card" style="padding:4px 16px;">
        <a class="list-row social-row" href="mailto:${c.contactEmail}"><span class="left"><span class="ic">✉️</span>${escapeHtml(c.contactEmail)}</span></a>
        <a class="list-row social-row" href="https://wa.me/${c.whatsappNumber.replace(/^0/,'234')}" target="_blank"><span class="left"><span class="ic">💬</span>WhatsApp: ${escapeHtml(c.whatsappDisplay)}</span></a>
        <div class="list-row social-row" style="cursor:pointer;" onclick="openContactModal()"><span class="left"><span class="ic">📩</span>Send us a message</span></div>
      </div>
    </div>
    <p class="text-2 small" style="text-align:center;margin-top:20px;">${escapeHtml(c.footerCopyright)}</p>
  </div>`;
}

function screenMenu(){
  const c = DB.content;
  return `
  <div class="screen">
    <h1 class="screen-title">Menu</h1>
    <div class="section">
      <div class="section-head"><h2>Explore</h2></div>
      <div class="card" style="padding:4px 16px;">
        <div class="list-row" style="cursor:pointer;" onclick="navigate('#home')"><span class="left"><span class="ic">🏠</span>Home</span><span>›</span></div>
        <div class="list-row" style="cursor:pointer;" onclick="navigate('#products')"><span class="left"><span class="ic">🛍️</span>Products</span><span>›</span></div>
        <div class="list-row" style="cursor:pointer;" onclick="navigate('#service')"><span class="left"><span class="ic">🧭</span>Service</span><span>›</span></div>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>Company</h2></div>
      <div class="card" style="padding:4px 16px;">
        <div class="list-row" style="cursor:pointer;" onclick="navigate('#about')"><span class="left"><span class="ic">🏢</span>About Us</span><span>›</span></div>
        <div class="list-row" style="cursor:pointer;" onclick="openNova('Tell me about LEXDEN NOVA')"><span class="left"><span class="ic">💬</span>Contact</span><span>›</span></div>
        <div class="list-row" style="cursor:pointer;" onclick="navigate('#service')"><span class="left"><span class="ic">❓</span>FAQ</span><span>›</span></div>
        <div class="list-row"><span class="left"><span class="ic">⭐</span>Testimonials</span></div>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>Support</h2></div>
      <div class="card" style="padding:4px 16px;">
        <div class="list-row" style="cursor:pointer;" onclick="openContactModal()"><span class="left"><span class="ic">📩</span>Send us a message</span></div>
        <div class="list-row" style="cursor:pointer;" onclick="mailtoReport('bug')"><span class="left"><span class="ic">🐞</span>Report a Bug</span></div>
        <div class="list-row" style="cursor:pointer;" onclick="mailtoReport('feedback')"><span class="left"><span class="ic">📝</span>Send Feedback</span></div>
        <div class="list-row" style="cursor:pointer;" onclick="openNova('I need help with something')"><span class="left"><span class="ic">🆘</span>Help Center</span></div>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>Connect</h2></div>
      <div class="card" style="padding:4px 16px;">
        <a class="list-row social-row" href="https://www.youtube.com/${c.youtube}" target="_blank"><span class="left"><span class="ic">${brandIcon('youtube')}</span>YouTube: ${escapeHtml(c.youtube)}</span></a>
        <a class="list-row social-row" href="https://www.tiktok.com/${c.tiktok}" target="_blank"><span class="left"><span class="ic">${brandIcon('tiktok')}</span>TikTok: ${escapeHtml(c.tiktok)}</span></a>
        <a class="list-row social-row" href="https://www.instagram.com/${c.instagram.replace('@','')}" target="_blank"><span class="left"><span class="ic">${brandIcon('instagram')}</span>Instagram: ${escapeHtml(c.instagram)}</span></a>
        <a class="list-row social-row" href="https://facebook.com/${c.facebook.replace(/\s+/g,'')}" target="_blank"><span class="left"><span class="ic">${brandIcon('facebook')}</span>Facebook: ${escapeHtml(c.facebook)}</span></a>
        <a class="list-row social-row" href="mailto:${c.contactEmail}"><span class="left"><span class="ic">${brandIcon('email')}</span>${escapeHtml(c.contactEmail)}</span></a>
        <a class="list-row social-row" href="https://wa.me/${c.whatsappNumber.replace(/^0/,'234')}" target="_blank"><span class="left"><span class="ic">${brandIcon('whatsapp')}</span>WhatsApp: ${escapeHtml(c.whatsappDisplay)}</span></a>
      </div>
    </div>
    <div class="section">
      <div class="section-head"><h2>Legal</h2></div>
      <div class="card" style="padding:4px 16px;">
        <a class="list-row" href="legal/index.html"><span class="left"><span class="ic">📚</span>Documents &amp; Policies</span><span>›</span></a>
        <a class="list-row" href="legal/terms.html"><span class="left"><span class="ic">📜</span>Terms of Use</span><span>›</span></a>
        <a class="list-row" href="legal/privacy.html"><span class="left"><span class="ic">📄</span>Privacy Notice</span><span>›</span></a>
        <a class="list-row" href="legal/refunds.html"><span class="left"><span class="ic">↩️</span>Refunds, Returns &amp; Disputes</span><span>›</span></a>
        <a class="list-row" href="legal/marketplace.html"><span class="left"><span class="ic">🛍️</span>Marketplace &amp; Seller Disclosure</span><span>›</span></a>
        <a class="list-row" href="legal/complaints.html"><span class="left"><span class="ic">💬</span>Complaints &amp; Redress</span><span>›</span></a>
        <div class="list-row"><span class="left"><span class="ic">ℹ️</span>App version</span><span class="text-2 small mono">v2.0.1</span></div>
      </div>
    </div>
    <p class="text-2 small" style="text-align:center;margin-top:20px;">${escapeHtml(c.footerCopyright)}</p>
  </div>`;
}
function mailtoReport(kind){
  const subject = kind==='bug' ? 'Bug Report - LEXDEN NOVA' : 'Feedback - LEXDEN NOVA';
  window.location.href = `mailto:${DB.content.contactEmail}?subject=${encodeURIComponent(subject)}`;
}

/* ---------------- CONTACT FORM (saves a lead to the cloud) ---------------- */
function openContactModal(){
  if($('#leadModalOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'leadModalOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:380px;width:100%;padding:20px;">
      <h2 class="font-display" style="margin-bottom:4px;">Send us a message</h2>
      <p class="text-2 small" style="margin-bottom:14px;">We read every message and reply by email, usually within a day.</p>
      <div class="form-field"><label>Your name</label><input id="leadName" placeholder="Your name"></div>
      <div class="form-field"><label>Your email</label><input id="leadEmail" type="email" placeholder="you@example.com"></div>
      <div class="form-field"><label>Reason</label>
        ${customSelect('leadReason', 'General', [
          {value:'General',label:'General question'},
          {value:'Order issue',label:'Order / payment issue'},
          {value:'Bug report',label:'Bug report'},
          {value:'Partnership',label:'Partnership / business'},
          {value:'Other',label:'Other'}
        ], '')}
      </div>
      <div class="form-field"><label>Message</label><textarea id="leadMessage" placeholder="How can we help?"></textarea></div>
      <p class="small text-2" id="leadErr" style="color:var(--error);min-height:16px;"></p>
      <div class="flex gap-8">
        <button class="btn btn-primary" id="leadSendBtn" onclick="submitLead()" style="flex:1;">Send</button>
        <button class="btn btn-outline" onclick="closeContactModal()">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
function closeContactModal(){
  const overlay = $('#leadModalOverlay');
  if(overlay) overlay.remove();
}
async function submitLead(){
  const name = ($('#leadName').value||'').trim();
  const email = ($('#leadEmail').value||'').trim();
  const reason = ($('#leadReason')?.value||'General').trim();
  const message = ($('#leadMessage').value||'').trim();
  const errEl = $('#leadErr');
  if(!name || !email || !message){
    errEl.textContent = 'Please fill in every field.';
    return;
  }
  const btn = $('#leadSendBtn');
  btn.disabled = true; btn.textContent = 'Sending…';
  const ok = await pushLeadToCloud({ name, email, reason, message });
  if(ok){
    closeContactModal();
    toast('Message sent — thanks!','success');
    logActivity('User', `Sent a message via contact form (${email})`);
    const receivedAt = new Date().toLocaleString('en-GB', { timeZone:'Africa/Lagos' }) + ' WAT';
    const ticketId = 'LN'+Date.now().toString(36).toUpperCase();
    sendNovaEmail('contact', { email, name }, { ticket_id: ticketId, received_at: receivedAt, topic: reason, message }).catch(()=>{});
    sendNovaEmail('admin', { email: DB.content.adminNotifyEmail || 'lexdendigital@gmail.com' }, {
      event_type: 'New contact message', reference_id: ticketId, user_email: email,
      event_time: receivedAt, priority: reason==='Bug report'?'High':'Normal',
      details: `${reason} — ${message}`,
    }).catch(()=>{});
  } else {
    errEl.textContent = 'Could not send — check your connection and try again.';
    btn.disabled = false; btn.textContent = 'Send';
  }
}

/* ---------------- AFTER RENDER (shared wiring) ---------------- */
let pressTimer = null;
function afterRender(hash){
  syncWishIcons();
  updateSeoForRoute(hash);
  $all('.logo-press').forEach(logo=>{
    const start = ()=>{ logo.style.transition='filter .3s, transform .3s'; logo.style.filter='drop-shadow(0 0 8px var(--accent))'; pressTimer = setTimeout(()=>{ if(navigator.vibrate) navigator.vibrate(120); navigate('#admin'); }, 1500); };
    const cancel = ()=>{ clearTimeout(pressTimer); logo.style.filter=''; };
    logo.addEventListener('mousedown', start); logo.addEventListener('touchstart', start, {passive:true});
    logo.addEventListener('mouseup', cancel); logo.addEventListener('mouseleave', cancel); logo.addEventListener('touchend', cancel);
  });
  ensureNovaWidget();
  setupBackToTop();
}
function setupBackToTop(){
  let bt = $('#backTop');
  if(!bt){
    bt = document.createElement('button');
    bt.id='backTop'; bt.className='back-top icon-btn'; bt.innerHTML='↑';
    bt.onclick = ()=>window.scrollTo({top:0,behavior:'smooth'});
    document.body.appendChild(bt);
  }
  window.onscroll = debounce(()=>{ bt.classList.toggle('show', window.scrollY>400); }, 80);
}
