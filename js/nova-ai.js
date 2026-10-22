'use strict';

/* =========================================================
   NOVA AI ASSISTANT
   Default mode: fully local — a rules + catalog-grounded
   response engine that reads live product/FAQ/content data
   and composes multi-paragraph answers. No network call, so
   it works instantly on GitHub Pages with zero backend.

   OPTIONAL live-Claude mode: see callRealNovaAPI() below.
   Calling api.anthropic.com directly from a public static
   site would require embedding a secret API key in client-side
   JS, which anyone could read from "view source" — so it's
   left OFF by default. If you want real Claude-powered answers,
   deploy the included cloudflare-worker-nova.js as a free
   Cloudflare Worker (holds the key server-side) and set the
   mode + endpoint from Admin -> NOVA AI Setup (DB.content.novaMode
   / novaApiEndpoint) — no source-code editing needed.
   ========================================================= */

function ensureNovaWidget(){
  if($('#novaFab')) { syncNovaBadge(); return; }
  const fab = document.createElement('button');
  fab.id='novaFab'; fab.className='nova-fab'; fab.setAttribute('aria-label','Open NOVA AI assistant'); fab.innerHTML='✨<span class="fab-label">Ask NOVA</span>';
  fab.onclick = ()=>toggleNova(true);
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.id='novaPanel'; panel.className='nova-panel';
  panel.innerHTML = `
    <div class="nova-head">
      <div class="who"><div class="avatar-ai">✨</div><div><div style="font-weight:700;font-size:14px;">NOVA AI</div><div class="small text-2">Here to help you choose</div></div></div>
      <div class="flex gap-8">
        <button class="icon-btn btn-sm" title="Clear history" onclick="clearNovaHistory()">🗑️</button>
        <button class="icon-btn" onclick="toggleNova(false)">✕</button>
      </div>
    </div>
    <div class="nova-body" id="novaBody"></div>
    <div class="quick-replies" id="novaQuick"></div>
    <div class="nova-input-row">
      <input id="novaInput" placeholder="Ask NOVA anything..." onkeydown="if(event.key==='Enter') sendNovaMessage();">
      <button class="nova-send" onclick="sendNovaMessage()" aria-label="Send">➤</button>
    </div>`;
  document.body.appendChild(panel);
  renderNovaHistory();
}
function syncNovaBadge(){}
function toggleNova(open){
  if(open) warmBackend();
  appState.novaOpen = open;
  const panel = $('#novaPanel');
  if(!panel) return;
  panel.classList.toggle('open', open);
  if(open){ renderNovaHistory(); setTimeout(()=>$('#novaInput')?.focus(), 200); }
}
function novaHistory(){ return lsGet(LS_KEYS.novaHistory, []); }
function saveNovaHistory(h){ lsSet(LS_KEYS.novaHistory, h.slice(-40)); }
function clearNovaHistory(){ saveNovaHistory([]); renderNovaHistory(); toast('Chat history cleared'); }

function renderNovaHistory(){
  const body = $('#novaBody');
  if(!body) return;
  let hist = novaHistory();
  if(!hist.length){
    hist = [{role:'ai', html: welcomeMessage()}];
  }
  body.innerHTML = hist.map(m=>`<div class="msg ${m.role==='user'?'user':'ai'}">${m.role==='user'?escapeHtml(m.text):m.html}</div>`).join('');
  body.scrollTop = body.scrollHeight;
  renderQuickReplies();
}
function welcomeMessage(){
  const sp = shopperProfile();
  if(sp.isReturning || sp.wishlistCount || sp.hasPurchased){
    return `Welcome back! I'm <strong>NOVA</strong>, your shopping assistant for LEXDEN NOVA. I can pick up on what you've browsed or saved before, check your order status, recommend products, compare prices, or explain checkout. Ask me "what have I been looking at" any time, or just tell me what you need.`;
  }
  return `Hi! I'm <strong>NOVA</strong>, your shopping assistant for LEXDEN NOVA. I can recommend products, compare prices, explain how checkout works, check your order status, or answer questions about anything you're browsing right now. What are you looking for today?`;
}
// Quick-reply chips used to be a fixed, identical list everywhere. They're
// now generated from wherever the shopper currently is (product page,
// cart, orders, category, checkout, etc.) so the suggestion is actually
// useful in that moment instead of generic. Falls back to a sensible
// general set when the route doesn't match anything more specific.
function contextualNovaSuggestions(){
  const route = appState.route || '#home';
  const c = DB.content;
  if(route.startsWith('#product/')){
    const p = findProduct(route.split('/')[1]);
    if(p){
      const list = [`Is ${p.name} worth it?`, isFreeProduct(p) ? 'How do I get this for free?' : 'How do I pay for this?'];
      list.push('Show similar products');
      if(p.reviewCount) list.push('What do reviews say?'); else list.push('Any discounts on this?');
      return list;
    }
  }
  if(route.startsWith('#category/') || route === '#products'){
    return ['Cheapest here?', 'What\'s trending?', 'Any free products?', 'Recommend one for me'];
  }
  if(route === '#cart' || route === '#checkout'){
    return ['How does checkout work?', 'Is payment safe?', 'Do I get a receipt?', 'Contact support'];
  }
  if(route === '#orders'){
    return ['My order status', 'Where\'s my download?', 'I didn\'t get my file', 'Contact support'];
  }
  if(route === '#wishlist'){
    return ['Recommend something new', 'Any free products?', 'What\'s trending?', 'Contact support'];
  }
  if(route === '#service' || route === '#faq'){
    return ['How do I contact support?', 'How do I buy?', 'Refund policy?', 'Is this site legit?'];
  }
  if(route === '#menu' || route === '#profile'){
    return ['How do I install the app?', 'How do I contact support?', 'Any free products?', 'What\'s trending?'];
  }
  // Home / default
  return ['Cheapest products?', 'Any free products?', 'How do I buy?', 'Contact support'];
}
function renderQuickReplies(){
  const q = $('#novaQuick'); if(!q) return;
  const suggestions = contextualNovaSuggestions();
  q.dataset.suggestions = JSON.stringify(suggestions);
  q.innerHTML = suggestions.map((s,i)=>`<button class="chip" onclick="quickNovaByIndex(${i})">${escapeHtml(s)}</button>`).join('');
}
function quickNovaByIndex(i){
  const suggestions = JSON.parse($('#novaQuick')?.dataset.suggestions || '[]');
  if(!suggestions[i]) return;
  $('#novaInput').value = suggestions[i];
  sendNovaMessage();
}
function openNova(prefill){ toggleNova(true); if(prefill){ setTimeout(()=>{ $('#novaInput').value = prefill; sendNovaMessage(); }, 250); } }

async function sendNovaMessage(){
  const input = $('#novaInput');
  const text = input.value.trim();
  if(!text) return;
  input.value = '';
  const hist = novaHistory();
  hist.push({role:'user', text});
  saveNovaHistory(hist);
  renderNovaHistory();

  const body = $('#novaBody');
  const typingEl = document.createElement('div');
  typingEl.className = 'typing-dots'; typingEl.innerHTML = '<span></span><span></span><span></span>';
  body.appendChild(typingEl); body.scrollTop = body.scrollHeight;

  let responseHtml;
  try{
    // Hard override: whatever the backend/local engine would say, if the
    // shopper is asking for the assistant's name, the answer is always
    // "NOVA AI" — checked before any API/local call, so it can never be
    // overridden by a model's own idea of what to call itself.
    if(isAskingNovaName(text)){
      responseHtml = `<p style="margin:0;">My name is <strong>NOVA AI</strong> 👋 — how can I help you shop today?</p>`;
    } else {
      responseHtml = DB.content.novaMode === 'api' && DB.content.novaApiEndpoint ? await callRealNovaAPI(text) : generateNovaResponse(text);
    }
  }catch(err){
    responseHtml = generateNovaResponse(text);
  }
  await new Promise(r=>setTimeout(r, 450 + Math.random()*400));
  typingEl.remove();

  const hist2 = novaHistory();
  hist2.push({role:'ai', html: responseHtml});
  saveNovaHistory(hist2);
  renderNovaHistory();
}

function isAskingNovaName(text){
  const t = pidginNormalize(text.toLowerCase());
  return /\b(what('|)s| is)?\s*your name\b|\bwho are you\b|\bwhat should i call you\b|\bwhat(\'s| is) your name\b/.test(t);
}

/* Optional real-API bridge (see notes above). Left inactive unless
   DB.content.novaMode is switched to 'api' and an endpoint is configured. */
async function callRealNovaAPI(userText){
  const context = buildNovaContext();
  // FIX (v2.0.1): this had no client-side timeout and never checked
  // res.ok — an unreachable/misrouted endpoint (e.g. a 404 because the
  // Vercel deploy didn't expose /api/nova-ai) could hang or throw an
  // opaque JSON-parse error, both landing on the same generic "failed to
  // reach my full brain" message with nothing in the console to diagnose
  // it by. Now: 15s hard timeout, and a real HTTP-status error surfaced
  // to the console so a wrong/undeployed endpoint is obvious, not silent.
  const res = await withTimeout(
    fetch(DB.content.novaApiEndpoint, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ message:userText, context })
    }),
    20000,
    'NOVA API request timed out'
  );
  if(!res.ok){
    console.error(`NOVA API endpoint returned HTTP ${res.status} — check the Render service is awake and /api/nova-ai is deployed.`);
    throw new Error(`NOVA API HTTP ${res.status}`);
  }
  const data = await res.json();
  if(data.fallback || !data.html){ console.warn('NOVA backend fallback', data.reason||''); throw new Error('NOVA backend unavailable — using local NOVA'); }
  return data.html;
}
function buildNovaContext(){
  return {
    route: appState.route,
    products: DB.products.filter(p=>p.status==='published').map(p=>({
      id:p.id, name:p.name, category:p.category,
      priceUSD:isFreeProduct(p)?0:p.price, salePriceUSD:p.salePrice||null,
      free:isFreeProduct(p), discountPercent:discountPercent(p), rating:p.rating,
      specs:p.specs||{}, description:(p.description||'').slice(0,300), tags:p.tags||[],
      // Media URLs are included (not the files themselves) so a
      // vision-capable backend — e.g. a Gemini call made server-side by
      // cloudflare-worker-nova.js — can fetch and look at each product's
      // actual images/video when forming an answer, instead of relying on
      // the text description alone. This file never calls Gemini directly.
      media: productMedia(p).slice(0,8).map(m=>({url:m.url, type:m.type})),
    })),
    // Feed posts, WITH their media, so the backend can hand Gemini images
    // from the feed too — not just products. Capped to the most recent 20
    // posts and to each post's own 8-media cap (already enforced on save)
    // so this stays a light payload; nova-ai.js does its own further
    // capping/prioritizing before it actually fetches any image bytes.
    feed: DB.feed.slice(0, 20).map(f => ({
      id: f.id, title: f.title, body: (f.body || '').slice(0, 300),
      productIds: feedPostProductIds(f),
      media: (f.media || []).slice(0, 8),
    })),
    faqs: DB.faqs, content: DB.content, management: DB.management, services: DB.services,
    currency: currentCurrency(),
    // Recent, on-device activity for THIS shopper only (page views, clicks,
    // searches — see logActivity throughout this file). Lets the backend
    // tailor suggestions to what someone's actually been doing this
    // session ("still deciding between the two design bundles") instead of
    // generic catalog advice. Nothing here leaves the device except in
    // this one request, and only when API mode is switched on in Admin.
    recentActivity: lsGet(LS_KEYS.activityLog, []).filter(e=>e.who==='User').slice(0,25).map(e=>({time:e.time, what:e.what})),
    // Derived shopper snapshot (see shopperProfile()) — saves the backend
    // from having to re-derive interest/category/returning-visitor signals
    // itself from the raw activity log every single call.
    shopper: shopperProfile(),
    // Cached order snapshot (populated when the shopper opens the Orders
    // tab — see fetchMyOrders/cacheOrdersForNova). Lets a live backend
    // answer "where's my order" without a separate round trip.
    cachedOrders: lsGet(LS_ORDER_CACHE, []),
  };
}

/* ---------- LOCAL RESPONSE ENGINE (grounded, multi-paragraph) ---------- */
// Light Nigerian Pidgin → English normalization. This isn't a full pidgin
// parser, but it maps the words people actually type at a shopping
// assistant ("wetin", "abeg", "how much e cost", "I wan buy") onto the
// English keywords the intent-matchers below already understand, so
// pidgin questions land in the same branches as their English equivalents.
const PIDGIN_MAP = [
  [/\bwetin\b/g, 'what'], [/\babeg\b/g, 'please'], [/\bi wan\b/g, 'i want'],
  [/\bi go\b/g, 'i will'], [/\bhow much e cost\b/g, 'how much does it cost'],
  [/\be cost\b/g, 'it costs'], [/\bno wahala\b/g, 'no problem'],
  [/\bhow far\b/g, 'hello'], [/\bhow you dey\b/g, 'hello'], [/\bi dey fine\b/g, 'i am fine'],
  [/\bdey work\b/g, 'is working'], [/\bnaso\b/g, 'that is right'], [/\bsha\b/g, ''],
  [/\bshey\b/g, 'is it that'], [/\bwahala\b/g, 'problem'], [/\bcheck am\b/g, 'check it'],
  [/\bbuy am\b/g, 'buy it'], [/\bshow me am\b/g, 'show me it'], [/\bfit\b/g, 'can'],
  [/\bmake i\b/g, 'let me'], [/\bi no get\b/g, 'i do not have'], [/\bgimme\b/g, 'give me'],
  [/\bhelep\b/g, 'help'], [/\bnah\b/g, 'no'], [/\bna\b/g, 'is'], [/\bfree free\b/g, 'free'],
  [/\bgratis\b/g, 'free'], [/\bhowmuch\b/g, 'how much'],
];
function pidginNormalize(text){
  let t = ' '+text+' ';
  PIDGIN_MAP.forEach(([re,rep])=>{ t = t.replace(re, rep); });
  return t.replace(/\s+/g,' ').trim();
}
// GENERAL SYNONYM NORMALIZATION — the real lever for handling "no matter
// how it's asked", more than any single new if-branch: instead of adding
// a pattern per phrasing, fold every common alternate phrasing onto one
// canonical keyword BEFORE the intent branches run, so one regex like
// /\bcheap\b/ below now also catches "affordable", "budget-friendly",
// "pocket-friendly", "won't break the bank", "not expensive", etc. This
// is applied on top of pidginNormalize(), so pidgin → English → synonym
// canonicalization all happen in one pass.
const SYNONYM_MAP = [
  // price / cheapness
  [/\b(affordable|budget[- ]friendly|pocket[- ]friendly|low[- ]cost|won'?t break the bank|light on (my |the )?(pocket|wallet)|not expensive|inexpensive)\b/g, 'cheap'],
  [/\b(price tag|cost|how much (is|does|for)|what'?s the (price|cost)|price of)\b/g, 'price'],
  [/\b(pricey|costly|expensive|too much money)\b/g, 'expensive'],
  // free
  [/\b(complimentary|at no cost|no charge|for nothing|on the house)\b/g, 'free'],
  // buying / purchasing
  [/\b(buy|purchase|order|get(?:ting)? (this|it)|checkout|check out|pay for)\b/g, 'buy'],
  // greetings / smalltalk
  [/\b(good day|howdy|greetings|what'?s up|wassup|wagwan)\b/g, 'hello'],
  // thanks
  [/\b(thanks a lot|thank you (so much|very much)?|much appreciated|appreciate it|thanks!*|tanks|tenk you)\b/g, 'thank you'],
  // quality / recommendation
  [/\b(best|top|greatest|number one|no\.?\s?1|highest rated|most popular)\b/g, 'best'],
  [/\b(suggest|recommend|point me to|show me|what should i (get|buy|choose)|help me (pick|choose|decide))\b/g, 'recommend'],
  // legitimacy
  [/\b(is this legit|real deal|is it fake|con|dupe(?:d)?|ripped off|rip[- ]off)\b/g, 'scam'],
  // problems / bugs
  [/\b(not working|broken|acting up|misbehaving|error(?:ing)?|freezing|frozen|stuck loading|won'?t open)\b/g, 'bug'],
  // refund / money back
  [/\b(money back|get (my|a) refund|cancel (my|the) order|return policy)\b/g, 'refund'],
  // where to find things
  [/\b(where (do i|can i|to) find|locate|point me to the)\b/g, 'where is'],
  // install
  [/\b(add to home ?screen|save to (my )?(phone|home ?screen)|get the app)\b/g, 'install the app'],
];
function synonymNormalize(text){
  let t = ' '+text+' ';
  SYNONYM_MAP.forEach(([re,rep])=>{ t = t.replace(re, rep); });
  return t.replace(/\s+/g,' ').trim();
}
// Cheap Levenshtein edit-distance — used for typo-tolerant product-name and
// FAQ matching so "how much is the canvaa bundle" or "instal the app" still
// resolve correctly instead of falling through to the generic fallback just
// because of one misspelled word.
function editDistance(a, b){
  if(a===b) return 0;
  const m=a.length, n=b.length;
  if(!m) return n; if(!n) return m;
  let prev = Array.from({length:n+1}, (_,j)=>j);
  for(let i=1;i<=m;i++){
    const cur = [i];
    for(let j=1;j<=n;j++){
      cur[j] = a[i-1]===b[j-1] ? prev[j-1] : 1+Math.min(prev[j-1], prev[j], cur[j-1]);
    }
    prev = cur;
  }
  return prev[n];
}
// Fuzzy "does this word appear, allowing small typos" — a whole-word exact
// match always wins; otherwise a word counts as a match if it's close
// enough in edit distance for its length (short words need a near-exact
// match so we don't collide unrelated short words with each other).
function fuzzyIncludes(haystackWords, word){
  if(word.length<3) return haystackWords.includes(word);
  const maxDist = word.length<=5 ? 1 : word.length<=9 ? 2 : 3;
  return haystackWords.some(w=> w===word || (Math.abs(w.length-word.length)<=maxDist && editDistance(w,word)<=maxDist));
}
// Fuzzy product-name finder: scores every product by how many of its own
// name-words appear (allowing typos) anywhere in the shopper's message,
// picks the best match above a real threshold rather than the first
// substring hit — this is what lets a slightly-misspelled or partial
// product name still resolve correctly across every branch that needs it
// (fallback nameHit, compare, tagHit), instead of duplicating this logic.
function fuzzyFindProduct(text, products){
  const msgWords = text.toLowerCase().split(/\s+/).filter(w=>w.length>2);
  if(!msgWords.length) return null;
  let best = null, bestScore = 0;
  products.forEach(p=>{
    const nameWords = p.name.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(w=>w.length>2);
    if(!nameWords.length) return;
    const hits = nameWords.filter(nw=>fuzzyIncludes(msgWords, nw)).length;
    const score = hits / nameWords.length;
    if(score > bestScore){ bestScore = score; best = p; }
  });
  return bestScore >= 0.5 ? best : null;
}
// Logs any question NOVA couldn't confidently answer, so the admin can see
// real recurring questions (Admin → NOVA AI Setup → Learning Queue) and
// turn frequent ones into FAQs — the closest thing to "self-improvement"
// that's honest to build without a live model call.
function logUnansweredQuery(raw){
  const log = lsGet(LS_KEYS.novaLearning, []);
  const norm = raw.trim().toLowerCase();
  const existing = log.find(x=>x.text===norm);
  if(existing){ existing.count++; existing.last = new Date().toISOString(); }
  else log.unshift({text:norm, count:1, last:new Date().toISOString()});
  lsSet(LS_KEYS.novaLearning, log.slice(0,200));
}

function pLink(p){ return `<a href="#product/${p.id}" onclick="toggleNova(false)">${escapeHtml(p.name)}</a>`; }
function moneyStr(p){
  if(isFreeProduct(p)) return 'Free';
  const off = discountPercent(p);
  return p.salePrice ? `${fmtPrice(p.salePrice)} (down from ${fmtPrice(p.price)}${off>0?`, ${off}% off`:''})` : fmtPrice(p.price);
}

function generateNovaResponse(raw){
  const text = synonymNormalize(pidginNormalize(raw.toLowerCase()));
  const c = DB.content;
  const products = DB.products.filter(p=>p.status!=='published' ? p.status!=='draft' : true).filter(p=>p.status!=='draft');
  const currentProduct = appState.route.startsWith('#product/') ? findProduct(appState.route.split('/')[1]) : null;

  // -1) MULTI-CONSTRAINT PARSER — this is the actual upgrade over a flat
  // if/else chain. Instead of one regex owning one answer, this extracts
  // every constraint mentioned in the sentence (budget ceiling, category,
  // minimum rating, free-only, "not X", beginner/advanced level) into a
  // structured object, then answers by FILTERING the live catalog against
  // ALL of them at once. A query like "cheap beginner design course under
  // $15 but not templates, well rated" hits zero single-keyword branches
  // below but is fully answerable here because it's genuine composition,
  // not one more regex. Falls through untouched (returns null) if it
  // can't extract at least two real constraints, so it never hijacks a
  // simple one-topic question from the branches that already handle those
  // better.
  function parseConstraints(t){
    const con = {};
    const under = /(?:under|below|less than|not more than|max(?:imum)?|no more than)\s*\$?(\d+(?:\.\d+)?)/.exec(t);
    const over = /(?:over|above|more than|at least|min(?:imum)?)\s*\$?(\d+(?:\.\d+)?)/.exec(t);
    if(under) con.maxPrice = parseFloat(under[1]);
    if(over) con.minPrice = parseFloat(over[1]);
    if(/\bfree\b/.test(t) && !/not free|isn't free/.test(t)) con.freeOnly = true;
    const ratingM = /(\d(?:\.\d)?)\s*(?:\+|star|★)/.exec(t);
    if(ratingM) con.minRating = parseFloat(ratingM[1]);
    else if(/(highly rated|well rated|top rated|best rated|well reviewed)/.test(t)) con.minRating = 4.5;
    const catMatch = DB.categories.find(cat=>cat.id!=='all' && t.includes(cat.name.toLowerCase()));
    if(catMatch) con.category = catMatch.id;
    // Negation: "not templates", "no courses", "anything but bundles",
    // "excluding software" — collects category/tag names appearing after
    // a negation cue so they can be filtered OUT rather than in.
    const negMatches = [...t.matchAll(/\b(?:not|no|excluding|except|besides|other than|anything but)\s+([a-z][a-z\s]{2,20}?)(?:\.|,|$| and | but | or )/g)];
    if(negMatches.length){
      con.exclude = negMatches.map(m=>m[1].trim()).filter(Boolean);
    }
    if(/(beginner|new to this|just starting|novice|from scratch)/.test(t)) con.level = 'beginner';
    else if(/(advanced|expert|experienced|pro level)/.test(t)) con.level = 'advanced';
    if(/(trending|popular|hot right now)/.test(t)) con.trendingOnly = true;
    if(/(featured|recommended by you|staff pick)/.test(t)) con.featuredOnly = true;
    const constraintCount = Object.keys(con).length;
    return constraintCount >= 2 ? con : null;
  }
  const constraints = parseConstraints(text);
  if(constraints && !/^(hi|hey|hello|yo|sup)\b/.test(text.trim())){
    let pool = products.slice();
    if(constraints.category) pool = pool.filter(p=>p.category===constraints.category);
    if(constraints.freeOnly) pool = pool.filter(isFreeProduct);
    if(constraints.maxPrice!=null) pool = pool.filter(p=>(p.salePrice||p.price||0) <= constraints.maxPrice);
    if(constraints.minPrice!=null) pool = pool.filter(p=>(p.salePrice||p.price||0) >= constraints.minPrice);
    if(constraints.minRating!=null) pool = pool.filter(p=>p.rating >= constraints.minRating);
    if(constraints.trendingOnly) pool = pool.filter(p=>p.trending);
    if(constraints.featuredOnly) pool = pool.filter(p=>p.featured);
    if(constraints.level==='beginner') pool = pool.filter(p=>!/advanced|expert/i.test(p.description||'') && !/advanced|expert/i.test((p.tags||[]).join(' ')));
    if(constraints.level==='advanced') pool = pool.filter(p=>/advanced|expert|pro/i.test(p.description||'') || /advanced|expert|pro/i.test((p.tags||[]).join(' ')));
    if(constraints.exclude && constraints.exclude.length){
      pool = pool.filter(p=>{
        const hay = (p.category+' '+(p.tags||[]).join(' ')+' '+p.name).toLowerCase();
        return !constraints.exclude.some(ex=>hay.includes(ex));
      });
    }
    pool = pool.sort((a,b)=>b.rating-a.rating).slice(0,4);
    const describedConstraints = [];
    if(constraints.category) describedConstraints.push(`category: ${DB.categories.find(cc=>cc.id===constraints.category)?.name||constraints.category}`);
    if(constraints.freeOnly) describedConstraints.push('free only');
    if(constraints.maxPrice!=null) describedConstraints.push(`under $${constraints.maxPrice}`);
    if(constraints.minPrice!=null) describedConstraints.push(`over $${constraints.minPrice}`);
    if(constraints.minRating!=null) describedConstraints.push(`${constraints.minRating}★ or higher`);
    if(constraints.level) describedConstraints.push(constraints.level+'-level');
    if(constraints.exclude?.length) describedConstraints.push(`excluding ${constraints.exclude.join(', ')}`);
    if(constraints.trendingOnly) describedConstraints.push('trending');
    if(constraints.featuredOnly) describedConstraints.push('featured');
    if(pool.length){
      const p1 = `You gave me a few conditions at once, so here's what actually satisfies all of them (${describedConstraints.join('; ')}):`;
      const list = pool.map((p,i)=>`${i+1}. ${pLink(p)} — ${moneyStr(p)}, ${p.rating}★${p.reviewCount?` (${p.reviewCount} reviews)`:''}`).join('<br>');
      const p2 = `${pLink(pool[0])} is the strongest match overall. Want me to relax one of those conditions (e.g. raise the budget) if this list feels too narrow?`;
      return [`<p style="margin:0 0 8px;">${p1}</p>`,`<p style="margin:0 0 8px;">${list}</p>`,`<p style="margin:0;">${p2}</p>`].join('');
    } else {
      const p1 = `Nothing in the current catalog satisfies all of those at once (${describedConstraints.join('; ')}) — that's a real answer, not a dodge: I checked every combination and came up empty.`;
      const relaxed = products.slice().sort((a,b)=>b.rating-a.rating).slice(0,3);
      const p2 = `If I drop the tightest condition, the closest matches are ${relaxed.map(p=>pLink(p)).join(', ')}. Tell me which condition matters least and I'll refine from there.`;
      return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
    }
  }

  // 0) Resolve a bare "yes"/"no" against whatever NOVA just offered — this is
  // what was previously the bug where NOVA offered to suggest a product,
  // the user said "yes", and NOVA had no memory of its own question.
  const pending = appState.novaPendingOffer;
  const isYes = /^(yes|yeah|yep|yea|sure|ok|okay|please|go ahead|do that|alright|do it)\b/.test(text.trim());
  const isNo = /^(no|nah|not (now|really)|maybe later|nope)\b/.test(text.trim());
  if(pending && (isYes || isNo)){
    appState.novaPendingOffer = null;
    if(isNo) return `<p style="margin:0;">No problem — I'm here whenever you need me. Ask about a product, a price, or how checkout works any time.</p>`;
    if(pending==='suggestProduct'){
      const pool = products.slice().sort((a,b)=>(b.featured?1:0)-(a.featured?1:0) || b.rating-a.rating).slice(0,3);
      const p1 = `Sure — here are a few strong picks to try the checkout flow with:`;
      const list = pool.map((p,i)=>`${i+1}. ${pLink(p)} — ${moneyStr(p)}, ${p.rating}★`).join('<br>');
      const p2 = `Tap any name to open its product page, then use the "${escapeHtml(c.buyButtonText)}" button at the bottom — that's the whole flow.`;
      return [`<p style="margin:0 0 8px;">${p1}</p>`,`<p style="margin:0 0 8px;">${list}</p>`,`<p style="margin:0;">${p2}</p>`].join('');
    }
  }
  appState.novaPendingOffer = null;

  // 1) Greetings — personalized using on-device shopper memory (activity,
  // wishlist, cached orders) so a returning visitor gets a genuinely
  // different, context-aware greeting instead of the same canned line
  // every time.
  if(/^(hi|hey|hello|yo|sup|how far|good (morning|afternoon|evening))\b/.test(text.trim())){
    const sp = shopperProfile();
    const name = sp.firstName ? escapeHtml(sp.firstName) : '';
    // Teen shoppers (derived from dob at signup) get a lighter, more casual
    // tone throughout — shorter greeting line, less formal phrasing. Never
    // guessed from anything other than an actual stored date of birth.
    const p1 = sp.isTeen
      ? (sp.isReturning
          ? `Heyy${name?' '+name:''}, you're back! I'm NOVA — I keep tabs on what you've been checking out so we don't start from zero.`
          : `Hey${name?' '+name:''}! I'm NOVA. I know the whole LEXDEN NOVA catalog — courses, templates, software, bundles, prices, ratings, all of it — so just ask me stuff instead of digging through menus.`)
      : sp.isReturning
        ? `Hey${name?' '+name:''}, welcome back! Good to see you again — I'm NOVA, and I keep track of what you've been browsing so I can pick up where things left off instead of starting from zero.`
        : `Hey${name?' '+name:''}! Good to have you here. I'm NOVA, and I know the entire LEXDEN NOVA catalog — every course, template, software pick and bundle, along with prices, ratings and reviews — so you can ask me anything instead of digging through menus.`;
    let p2;
    if(currentProduct){
      p2 = `I can see you're currently looking at ${pLink(currentProduct)}, priced at ${moneyStr(currentProduct)}${currentProduct.reviewCount ? ` with a ${currentProduct.rating}★ rating from ${currentProduct.reviewCount} reviewer${currentProduct.reviewCount===1?'':'s'}` : ` — it doesn't have any reviews yet`}. Want me to break down whether it's worth it, or compare it with something similar?`;
    } else if(sp.hasPurchased){
      p2 = `Since you've already bought from us before, I can help with follow-up questions on a past order, or point you to something new — maybe in ${sp.topCategory ? escapeHtml(sp.topCategory) : 'a category you haven\'t tried yet'}?`;
    } else if(sp.wishlistCount > 0){
      p2 = `You've got ${sp.wishlistCount} item${sp.wishlistCount===1?'':'s'} saved in your wishlist${sp.topCategory ? `, mostly in ${escapeHtml(sp.topCategory)}` : ''} — want me to check if any of them are now discounted, or suggest something similar?`;
    } else if(sp.topCategory){
      p2 = `Based on what you've been browsing, you seem interested in ${escapeHtml(sp.topCategory)} — want a ranked shortlist from that category, or something different today?`;
    } else {
      p2 = `Right now we have ${products.length} products live across ${DB.categories.length-1} categories, ranging from quick eBooks under $10 to full course bundles. If you tell me your budget or what you're trying to achieve (grow a page, learn a skill, start freelancing), I'll point you to the best fit.`;
    }
    const p3 = `You can also ask me things like "what's the cheapest course", "how do I buy something", "what's trending", "how do I install the app", or "compare product X and Y" — I'll always answer with real prices and links, not generic filler.`;
    return [p1,p2,p3].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 1b) "What have I been up to / do you remember me" — direct request to
  // surface the shopper's own on-device history back to them.
  if(/(what have i (been )?(looking|browsing)|do you remember me|my (recent )?(activity|history)|what did i (view|look at|search))/.test(text)){
    const sp = shopperProfile();
    if(!sp.isReturning && !sp.wishlistCount && !sp.hasPurchased){
      return `<p style="margin:0;">This looks like the start of our conversation, and I don't see much browsing history on this device yet — once you view a few products or save something to your wishlist, I'll be able to reference it here.</p>`;
    }
    const bits = [];
    if(sp.wishlistCount) bits.push(`${sp.wishlistCount} item${sp.wishlistCount===1?'':'s'} saved to your wishlist${sp.topCategory?` (mostly ${escapeHtml(sp.topCategory)})`:''}`);
    if(sp.hasPurchased) bits.push(`${sp.orders.length} past order${sp.orders.length===1?'':'s'} on record`);
    if(sp.visitCount) bits.push(`${sp.visitCount} tracked action${sp.visitCount===1?'':'s'} this session/device (views, searches, clicks)`);
    const p1 = `Here's what I can see from this device: ${bits.join('; ')}.`;
    const recentLines = sp.lastActivity.slice(0,4).map(a=>`• ${escapeHtml(a.what)}`).join('<br>');
    const p2 = recentLines ? `Most recent activity:<br>${recentLines}` : '';
    const p3 = `Nothing here ever leaves your device unless you switch NOVA to live-API mode in Admin — this is just local browser storage, so it resets if you clear site data or switch devices.`;
    return [p1,p2,p3].filter(Boolean).map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 1c) Order status — uses the cached order snapshot populated whenever
  // the shopper visits the Orders screen (fetchMyOrders -> cacheOrdersForNova).
  if(/(my order|where'?s my (download|order|file)|order status|did (my|the) payment (go through|work)|i (didn'?t|did not) get my (file|download))/.test(text)){
    const sp = shopperProfile();
    if(!sp.signedIn){
      return `<p style="margin:0;">I can't see order history without you being signed in — sign in from the Profile tab first, then ask me again and I'll pull up what's on record.</p>`;
    }
    if(!sp.orders.length){
      const p1 = `I don't have any cached orders for you yet on this device — that usually just means you haven't opened the Orders tab this session, since that's what refreshes my view of your purchase history.`;
      const p2 = `Open Orders once from the bottom nav, then come back and ask me again — or if you just paid and it's stuck, give it a minute and refresh; payment confirmation runs a server-side verification step that can take a few seconds.`;
      return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
    }
    const list = sp.orders.slice(0,5).map((o,i)=>{
      const p = products.find(pr=>pr.id===o.productId);
      return `${i+1}. ${p?pLink(p):escapeHtml(o.productId||'Unknown item')} — ${escapeHtml(o.status||'processing')}`;
    }).join('<br>');
    const p1 = `Here's what's on record from your most recent orders:`;
    const p2 = `If any of these say "processing" for more than a few minutes after payment, or a download link isn't working, message support at ${escapeHtml(c.contactEmail)} with the order reference and a timestamp — that's the fastest way to get it manually resolved.`;
    return [`<p style="margin:0 0 8px;">${p1}</p>`,`<p style="margin:0 0 8px;">${list}</p>`,`<p style="margin:0;">${p2}</p>`].join('');
  }

  // 2) Contact / support
  if(/(contact|support|whatsapp|email|reach you|talk to (a )?human)/.test(text)){
    const p1 = `You've got a few ways to reach the LEXDEN NOVA team directly. WhatsApp is usually fastest — message ${escapeHtml(c.whatsappDisplay)} (username ${escapeHtml(c.whatsappUsername)}) and someone typically replies within a few hours.`;
    const p2 = `For anything that needs a paper trail — like a purchase issue with a specific partner product — email works well too: ${escapeHtml(c.contactEmail)}. Include the product name and item code (shown on every product page) so support can look it up fast.`;
    const p3 = `We're also active on Instagram (${escapeHtml(c.instagram)}), TikTok (${escapeHtml(c.tiktok)}), YouTube (${escapeHtml(c.youtube)}) and Facebook (${escapeHtml(c.facebook)}) if you'd rather DM there or just want to see more product breakdowns.`;
    return [p1,p2,p3].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 2b) Install the app — previously had no dedicated intent at all, so a
  // plain "how do I install the app?" (one of NOVA's own suggested quick
  // replies!) fell through to the generic fallback. Routed through the
  // exact same handleInstallAction() every other "Install" affordance in
  // the app uses (top banner, Profile menu row) — tries the browser's real
  // native install prompt first, and only falls back to manual
  // step-by-step instructions if that's unavailable, so NOVA's button
  // behaves identically to the rest of the app rather than duplicating
  // that logic.
  if(/(how (do|can|would) i install|install (the )?(app|nova)|add (this |it |the app )?to (my )?home ?screen|get (the )?app on my (phone|home ?screen|device)|download the app|can i install|install instructions|pwa)/.test(text)){
    if(isStandalone()){
      return `<p style="margin:0;">Looks like you've already got NOVA installed on this device — you're using it right now as an installed app, not the browser tab. Nothing else to do here.</p>`;
    }
    const p1 = `Installing NOVA puts it on your home screen like a regular app — faster to open, works offline for anything you've already loaded, and skips the browser address bar entirely.`;
    const p2 = `Tap the button below and I'll trigger your browser's real install prompt. If your browser doesn't support that (this is common on iOS Safari and some desktop browsers), I'll show the exact manual steps for your specific device instead.`;
    return [`<p style="margin:0 0 8px;">${p1}</p>`,`<p style="margin:0 0 12px;">${p2}</p>`,`<button class="btn btn-primary btn-sm" onclick="handleInstallAction()">Install App</button>`].join('');
  }

  // 3) How to buy / purchase flow — checkout actually works one of THREE
  // different ways depending on the individual product (see startCheckout()
  // and the sticky-buy button logic on the product page):
  //   (a) free products — a direct link, no payment step at all
  //   (b) most paid products — an in-app Paystack popup, so LEXDEN NOVA
  //       *does* run the payment itself, in-app, no new tab
  //   (c) products with an externalPaymentLink set — redirected to the
  //       seller's own external checkout page in a new tab
  // Previously this branch described only (c) unconditionally, which was
  // wrong for the majority of products (which use (b)) and for anything
  // free (which uses (a)). Now it answers for the specific product in
  // context when there is one, and otherwise explains honestly that it
  // depends on the product rather than picking one flow to describe.
  if(/(how (do|to) i (buy|purchase|checkout|order)|how does (buying|checkout) work|how to pay)/.test(text)){
    if(currentProduct){
      const p = currentProduct;
      const p1 = isFreeProduct(p)
        ? `${escapeHtml(p.name)} is free — there's no payment step at all. Just tap "Get it free" at the bottom of the page and it opens your access link (download or the seller's delivery page) directly in a new tab.`
        : p.externalPaymentLink
          ? `For ${escapeHtml(p.name)}, tapping "${escapeHtml(isCourseProduct(p) ? 'Get Started' : c.buyButtonText)}" sends you to the seller's own checkout page in a new tab — you'll enter payment details directly with them, not with LEXDEN NOVA. Access afterward is granted by that seller, usually by email or download link.`
          : `For ${escapeHtml(p.name)}, tapping "${escapeHtml(isCourseProduct(p) ? 'Get Started' : c.buyButtonText)}" opens payment right here in the app through Paystack — no new tab, no separate seller account. You'll enter your email, then card/bank/USSD details in the secure Paystack popup, and access unlocks automatically the moment payment is verified.`;
      const p2 = `It's ${moneyStr(p)}. Scroll to the sticky button at the bottom of this product's page whenever you're ready.`;
      return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
    }
    const p1 = `Honest answer: it depends on the specific product, since checkout runs one of three ways here — not the same for everything.`;
    const p2 = `Most paid products check out right in the app through Paystack (card, bank transfer or USSD) — no new tab, no separate account with anyone else. Free products just give you a direct access link, no payment step. A smaller number of products send you to that seller's own external checkout page in a new tab instead.`;
    const p3 = `Either way: open the product, scroll to the sticky "${escapeHtml(c.buyButtonText)}" button at the bottom — the button label tells you which of the three you're getting before you tap it. Want me to check a specific product for you?`;
    appState.novaPendingOffer = 'suggestProduct';
    return [p1,p2,p3].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 4) Refund / policy / FAQ keyword match
  const faqHit = DB.faqs.find(f=> text.split(/\s+/).some(w=>w.length>3 && f.q.toLowerCase().includes(w)) );
  if(faqHit || /(refund|policy|guarantee|cancel)/.test(text)){
    const f = faqHit || DB.faqs.find(f=>/refund/i.test(f.q));
    const p1 = f ? `Good question — here's the honest answer: ${escapeHtml(f.a)}` : `For items paid for through LEXDEN NOVA checkout you can open a dispute from your order. For partner items bought on another site, that partner's own policy applies. The full wording is under Documents & Policies → Refunds, Returns & Disputes (currently a draft pending review).`;
    const p2 = `Each listing shows its seller and what is included. I can't decide or promise a refund myself; I can only point you to the process and the listed policy.`;
    const p3 = `If a purchase goes wrong, open a dispute from your order, or reach out on WhatsApp (${escapeHtml(c.whatsappDisplay)}) with your order reference.`;
    return [p1,p2,p3].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 5) Free products
  if(/(free|no cost|zero naira|gratis|without paying)/.test(text)){
    const freeOnes = products.filter(isFreeProduct);
    if(freeOnes.length){
      const p1 = `Yes — here's what's currently free in the catalog, no payment needed:`;
      const list = freeOnes.slice(0,6).map((p,i)=>`${i+1}. ${pLink(p)} — Free, ${p.rating}★`).join('<br>');
      return [`<p style="margin:0 0 8px;">${p1}</p>`,`<p style="margin:0;">${list}</p>`].join('');
    }
    const cheapest = products.slice().sort((a,b)=>(a.salePrice||a.price)-(b.salePrice||b.price))[0];
    const p1 = `Nothing in the catalog is free right now, but the closest thing to it is ${cheapest?pLink(cheapest):'our cheapest item'} at ${cheapest?moneyStr(cheapest):''}.`;
    const p2 = `Want me to list the cheapest products instead, sorted lowest to highest?`;
    return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 6) Cheapest / budget
  if(/(cheap|budget|lowest price|affordable|under \$?\d+)/.test(text)){
    const sorted = products.slice().sort((a,b)=>(a.salePrice||a.price)-(b.salePrice||b.price)).slice(0,4);
    const p1 = `If price is the priority, here's what's currently cheapest in the catalog, from lowest up:`;
    const list = sorted.map((p,i)=>`${i+1}. ${pLink(p)} — ${moneyStr(p)}, rated ${p.rating}★`).join('<br>');
    const p2 = `${sorted[0] ? `${pLink(sorted[0])} is the best deal right now at ${moneyStr(sorted[0])}` : ''}${sorted[0] && sorted[0].rating>=4.5 ? `, and it's also well-reviewed — not just cheap for the sake of it.` : `.`}`;
    const p3 = `If you tell me what category you actually need (courses, templates, software, or bundles), I can narrow this down further instead of just sorting by price.`;
    return [`<p style="margin:0 0 8px;">${p1}</p>`, `<p style="margin:0 0 8px;">${list}</p>`, `<p style="margin:0 0 8px;">${p2}</p>`, `<p style="margin:0;">${p3}</p>`].join('');
  }

  // 6) Compare two products
  if(/(compare|vs\.?|versus|which is (better|cheaper|worth it))/.test(text)){
    const matches = products.filter(p=> text.includes(p.name.toLowerCase()) || (p.tags||[]).some(t=>text.includes(t.toLowerCase())) );
    if(matches.length>=2){
      const [a,b] = matches;
      const p1 = `Comparing ${pLink(a)} and ${pLink(b)}: on price, ${a.salePrice||a.price < (b.salePrice||b.price) ? pLink(a) : pLink(b)} is the more budget-friendly option at ${moneyStr((a.salePrice||a.price)<(b.salePrice||b.price)?a:b)}.`;
      const p2 = (a.reviewCount||b.reviewCount)
        ? `On ratings, ${a.rating>=b.rating?pLink(a):pLink(b)} edges ahead at ${Math.max(a.rating,b.rating)}★ versus ${Math.min(a.rating,b.rating)}★, based on ${a.rating>=b.rating?a.reviewCount:b.reviewCount} reviews.`
        : `Neither has reviews yet, so I can't compare them on ratings — happy to compare price or features instead.`;
      const p3 = `They're also aimed at slightly different things — ${escapeHtml(a.name)} is a ${a.category} focused on "${(a.tags||[])[0]||a.category}", while ${escapeHtml(b.name)} leans more into "${(b.tags||[])[0]||b.category}". If budget matters more, go with the cheaper one; if you want the strongest track record, go with the higher-rated one.`;
      return [p1,p2,p3].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
    }
    if(currentProduct){
      const related = products.filter(p=>p.category===currentProduct.category && p.id!==currentProduct.id).sort((a,b)=>b.rating-a.rating)[0];
      if(related){
        const p1 = `Since you're viewing ${pLink(currentProduct)}, the closest comparison in the catalog is ${pLink(related)} — both are in ${currentProduct.category}.`;
        const p2 = `${pLink(currentProduct)} is ${moneyStr(currentProduct)} at ${currentProduct.rating}★, while ${pLink(related)} is ${moneyStr(related)} at ${related.rating}★. ${currentProduct.rating>=related.rating? 'The one you\'re looking at currently has the edge in reviews.' : 'The alternative actually has a stronger review record, so it might be worth a look too.'}`;
        const p3 = `Tell me your priority — price, rating, or specific features — and I'll give you a clearer recommendation between the two.`;
        return [p1,p2,p3].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
      }
    }
  }

  // 7) Question about "this" product on current product page
  if(currentProduct && /(this|it|worth it|good|price|detail|feature|review)/.test(text)){
    const hasSale = currentProduct.salePrice && currentProduct.salePrice < currentProduct.price;
    const p1 = `${escapeHtml(currentProduct.name)} is ${escapeHtml(currentProduct.description)}`;
    const p2 = `It's priced at ${fmtPrice(hasSale?currentProduct.salePrice:currentProduct.price)}${hasSale?` (marked down from ${fmtPrice(currentProduct.price)})`:''}${currentProduct.reviewCount
      ? `, and currently holds a ${currentProduct.rating}★ average across ${currentProduct.reviewCount} reviews — ${currentProduct.rating>=4.6?'one of the stronger ratings in the catalog.':currentProduct.rating>=4.3?'a solid, dependable rating.':'a decent rating, worth reading a couple of reviews before deciding.'}`
      : `. It doesn't have any reviews yet — you'd be one of the first to try it.`}`;
    const specEntries = Object.entries(currentProduct.specs||{});
    const p3 = specEntries.length ? `Key specifics: ${specEntries.map(([k,v])=>`${k} — ${v}`).join('; ')}. It's sold by ${escapeHtml(currentProduct.seller||'a Lexden partner')}.` : `It's sold by ${escapeHtml(currentProduct.seller||'a Lexden partner')}.`;
    const p4 = `If it looks like a fit, the "${escapeHtml(c.buyButtonText)}" button at the bottom of this page takes you straight to checkout. Want me to suggest something similar to compare it against first?`;
    return [p1,p2,p3,p4].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 8) Category / keyword driven recommendation
  const catHit = DB.categories.find(c2=>c2.id!=='all' && text.includes(c2.name.toLowerCase()));
  const tagHit = products.filter(p=>(p.tags||[]).some(t=>text.includes(t.toLowerCase())));
  if(catHit || tagHit.length || /(recommend|suggest|best|looking for|need something|help me (find|choose))/.test(text)){
    let pool = catHit ? products.filter(p=>p.category===catHit.id) : (tagHit.length? tagHit : products.filter(p=>p.featured || p.trending));
    pool = pool.sort((a,b)=>b.rating-a.rating).slice(0,3);
    if(pool.length){
      const p1 = catHit ? `Here's what I'd point you to in ${escapeHtml(catHit.name)}, ranked by rating:` : `Based on what you're asking, here are a few strong picks from the catalog:`;
      const list = pool.map((p,i)=>`${i+1}. ${pLink(p)} — ${moneyStr(p)}, ${p.rating}★ (${p.reviewCount} reviews)`).join('<br>');
      const top = pool[0];
      const p2 = `${pLink(top)} stands out most — it's rated ${top.rating}★ and ${top.salePrice?`currently discounted to ${fmtPrice(top.salePrice)}`:`priced at ${fmtPrice(top.price)}`}. ${top.description.split('.')[0]}.`;
      const p3 = `If none of these quite match what you had in mind, tell me more about your goal (e.g. "I want to learn video editing" or "something under $10") and I'll refine the list.`;
      return [`<p style="margin:0 0 8px;">${p1}</p>`,`<p style="margin:0 0 8px;">${list}</p>`,`<p style="margin:0 0 8px;">${p2}</p>`,`<p style="margin:0;">${p3}</p>`].join('');
    }
  }

  // 8b) Media / gallery questions — NOVA can't literally see pixels in
  // local-rules mode (no vision model runs client-side), but it can reason
  // accurately about what media exists, its type, and how it maps to the
  // product, which covers the vast majority of real "does it have a demo
  // video / how many photos" questions honestly rather than hallucinating.
  if(/(video|screenshot|photo|image|gallery|demo|preview|what does it look like|watch)/.test(text) && currentProduct){
    const media = productMedia(currentProduct);
    const counts = media.reduce((acc,m)=>{ acc[m.type]=(acc[m.type]||0)+1; return acc; },{});
    if(!media.length){
      return `<p style="margin:0;">${escapeHtml(currentProduct.name)} doesn't have any gallery media uploaded yet — just the description and specs on the page. I can walk you through those instead, or flag it to support if you'd expect a preview here.</p>`;
    }
    const parts = [];
    if(counts.image) parts.push(`${counts.image} image${counts.image===1?'':'s'}`);
    if(counts.video) parts.push(`${counts.video} video${counts.video===1?'':'s'}`);
    if(counts.embed) parts.push(`${counts.embed} embedded player${counts.embed===1?'':'s'} (YouTube/TikTok/etc.)`);
    const p1 = `${escapeHtml(currentProduct.name)}'s gallery has ${parts.join(' and ')} — you can swipe through them at the top of the product page, and tapping any thumbnail opens it full-size${counts.video||counts.embed?' with playback controls':''}.`;
    const p2 = `I read metadata about each media item (type and position) rather than analyzing the pixels myself in this mode, so for anything highly visual — like exact colors or on-screen text in a screenshot — your own eyes on the gallery will be more reliable than my description of it.`;
    return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 9) Navigation help
  if(/(where (is|can i find)|how do i get to|navigate|wishlist screen|admin|menu screen)/.test(text)){
    const p1 = `Here's a quick map of the app: <strong>Home</strong> has featured and trending picks, <strong>Products</strong> is the full searchable catalog with filters, <strong>Wishlist</strong> holds everything you've hearted, <strong>Profile</strong> has your settings, and <strong>Menu</strong> has company info, support links and legal pages.`;
    const p2 = `All five are reachable from the bar at the bottom of the screen on mobile, or the top navigation bar on larger screens — tapping any icon takes you straight there with no reload.`;
    const p3 = `If you were looking for something specific, tell me what it was and I can usually just answer it directly instead of you having to click around.`;
    return [p1,p2,p3].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 11) Trust / legitimacy — a genuinely common question for an affiliate
  // marketplace that people haven't bought from before. Answered honestly
  // rather than with generic reassurance.
  if(/(is this (site|app|website) (legit|real|safe|a scam)|is lexden (nova )?legit|can i trust|is it safe to (buy|pay)|scam)/.test(text)){
    const p1 = `Fair question, and worth answering plainly: LEXDEN NOVA is a curation and affiliate marketplace, not the merchant of record for most products — we don't process or store your card details ourselves. Checkout for paid items runs through Paystack, a licensed payment processor used widely across Africa, or directly through the individual seller's own checkout.`;
    const p2 = `Every product listing shows real specs, ratings and the seller responsible for fulfillment, so you can verify what you're buying and from whom before paying. That said, like any marketplace, individual seller quality varies — the rating and review count on each product page is the most honest signal of that.`;
    const p3 = `If something feels off about a specific listing, the safest move is to message ${escapeHtml(c.contactEmail)} or WhatsApp (${escapeHtml(c.whatsappDisplay)}) before paying, and we'll clarify.`;
    return [p1,p2,p3].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 12) Payment method / currency questions
  if(/(what (currency|currencies)|pay in (naira|dollars|usd|ngn|cedis)|which payment method|accept (card|paypal|crypto|bank transfer)|exchange rate)/.test(text)){
    const codes = Object.keys(c.currencySymbols||{USD:'$',NGN:'₦'});
    const p1 = `Prices display in ${escapeHtml(currentCurrency())} right now, but you can switch currency from the selector in the header — supported options are ${codes.join(', ')}. Conversion uses live-ish exchange rates set in Admin, so the number you see is a close real-world estimate, not the exact rate your bank will use.`;
    const p2 = `Actual payment happens through Paystack (cards, bank transfer, USSD, depending on your bank) for in-app checkout items, or through the individual seller's own payment page for externally-fulfilled products — so accepted methods can vary slightly by product.`;
    const p3 = `If a specific payment method didn't work for you, that's usually a seller-side or bank-side issue rather than something on our end — try a different method, or message support with the error you saw.`;
    return [p1,p2,p3].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 13) Technical troubleshooting — app/UI not behaving. Diagnostic-style
  // answer rather than a canned "try again later".
  if(/(app (won'?t|not|isn'?t) (load|work|open)|wishlist (not|isn'?t) saving|dark mode (not working|broken)|install(ation)? (fail|not working|issue)|blank (screen|page)|not loading|keeps crashing|glitch(y|ing)?|bug\b)/.test(text)){
    const p1 = `Let's narrow this down. Most loading/blank-screen issues on a PWA like this come from one of three things: a stale cached version, a spotty connection during load, or local storage that's out of sync after an update.`;
    const p2 = `Quick fixes in order of likelihood: (1) pull down to refresh or fully close and reopen the app/tab, (2) if you installed it to your home screen, check Menu for an "update available" banner and tap it, (3) as a last resort, clearing site data resets local caches — but note that also clears your wishlist and NOVA chat history on this device since those are stored locally too.`;
    const p3 = `If none of that fixes it, it's worth reporting properly rather than guessing further — email ${escapeHtml(c.contactEmail)} with your device type, browser, and roughly when it started, so it can actually get fixed rather than just worked around.`;
    return [p1,p2,p3].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 14) Product logistics — format, prerequisites, delivery, updates,
  // compatibility. These are "is this actually usable for me" questions
  // that a rating alone doesn't answer.
  if((currentProduct || /(this (course|product|template|tool))/.test(text)) && /(format|prerequisite|require|need to know|compatible|compatibility|how (long|much time)|updates?|lifetime access|download link|file type)/.test(text)){
    const p = currentProduct;
    if(p){
      const specEntries = Object.entries(p.specs||{});
      const p1 = specEntries.length
        ? `For ${escapeHtml(p.name)}, here's what's actually specified: ${specEntries.map(([k,v])=>`${escapeHtml(k)} — ${escapeHtml(String(v))}`).join('; ')}.`
        : `${escapeHtml(p.name)} doesn't have detailed specs filled in beyond the main description, so I don't want to guess at format/prerequisites I can't verify — that's worth confirming with the seller before buying if it's critical for you.`;
      const p2 = `Delivery and update policy (lifetime access vs. time-limited, whether updates are included) is set by the individual seller rather than by LEXDEN NOVA platform-wide, so the most reliable source is the "About the seller" section on this product's page.`;
      const p3 = `If the spec you need isn't listed at all, message support with the product's item code before paying — better to confirm than assume.`;
      return [p1,p2,p3].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
    }
  }

  // 15) Why-didn't-my-search-match meta-question — a genuinely useful
  // "critical thinking" branch: explains its own limits honestly instead
  // of pretending confidence.
  if(/(why (didn'?t|can'?t) you (find|show|answer)|you don'?t understand|that'?s not what i asked|you'?re not (getting|understanding))/.test(text)){
    const p1 = `Fair callout — let me be straight about how I work here: I'm running in local mode, which matches your message against known question patterns and the live catalog rather than truly reasoning about open-ended language. If your question used unusual phrasing or combined ideas I don't have a pattern for, I can miss it even when the answer is knowable from the catalog.`;
    const p2 = `The fix is usually to restate it more directly — name the actual product, category, price range, or action you mean (e.g. instead of "that other one", say the product name). Concrete constraints like "under $20, design category, 4★+" work especially well since I can filter on those directly.`;
    const p3 = `If it's genuinely something only a full conversation could resolve, that's exactly what switching to live-API mode (Admin → NOVA AI Setup) is for — worth flagging to whoever manages this site if you hit this often.`;
    return [p1,p2,p3].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 16) Gratitude / small talk — previously fell straight to the generic
  // fallback (and logged as "unanswered"), which is a bad experience for
  // one of the most common things people actually type.
  if(/^(thank you|thanks|nice one|good (bot|job|work)|noted|got it|understood|makes sense|cool|nice|great)\b/.test(text.trim()) && text.trim().split(/\s+/).length<=5){
    return `<p style="margin:0;">Anytime! If anything else comes up — pricing, a specific product, checkout, whatever — I'm right here.</p>`;
  }
  if(/^(how are you|how'?s it going|how you doing|you good|you okay)\b/.test(text.trim())){
    return `<p style="margin:0;">Running well and ready to help! I'm NOVA — ask me about any product, price, or how something in the app works and I'll give you a straight answer.</p>`;
  }

  // 17) "What is this site/app/company" — a genuinely common first
  // question that previously had no dedicated branch even though the
  // answer (c.aboutText) already exists in admin content.
  if(/(what is (this (site|app|website|place)|lexden ?nova)|what does (this (site|app)|lexden ?nova) do|tell me about (this (site|app)|lexden ?nova|yourself)|what'?s lexden ?nova)/.test(text)){
    const p1 = escapeHtml(c.aboutText || `LEXDEN NOVA curates and showcases the best digital products online, from courses to software to templates.`);
    const p2 = c.missionText ? escapeHtml(c.missionText) : '';
    const p3 = `Right now that means ${products.length} live products across ${DB.categories.length-1} categories. Ask me for a category, a budget, or "what's trending" and I'll pull real picks.`;
    return [p1,p2,p3].filter(Boolean).map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 18) Who runs it / team — pulls from the management array admins fill
  // in (Admin → App Content → About Us), same source the real About page
  // uses, so NOVA's answer never drifts from what's actually published.
  if(/(who (runs|owns|made|built|is behind)|who'?s behind|the team behind|founder of|who created (this|lexden))/.test(text)){
    const mgmt = DB.management || [];
    if(mgmt.length){
      const list = mgmt.map(m=>`${escapeHtml(m.name)} — ${escapeHtml(m.role)}`).join('; ');
      return [`<p style="margin:0 0 8px;">LEXDEN NOVA is run by ${escapeHtml(DB.content.appName||'the LEXDEN DIGITAL')} team: ${list}.</p>`,`<p style="margin:0;">Full bios are on the About page (Menu → About Us) if you want more detail.</p>`].join('');
    }
    return `<p style="margin:0;">LEXDEN NOVA is built and run by LEXDEN DIGITAL. Full company info is on the About page (Menu → About Us).</p>`;
  }

  // 19) Discount codes / coupons — a genuinely common e-commerce question
  // that was previously unhandled; answered honestly (no fabricated code)
  // and pointed at what's real (sale-priced items).
  if(/(discount code|coupon|promo ?code|voucher)/.test(text)){
    const onSale = products.filter(p=>p.salePrice && p.salePrice<p.price).sort((a,b)=>discountPercent(b)-discountPercent(a)).slice(0,4);
    const p1 = `There's no site-wide coupon-code system right now — discounts show up as sale prices directly on the product itself, already applied, no code needed.`;
    const p2 = onSale.length
      ? `Currently discounted: ${onSale.map(p=>`${pLink(p)} (${discountPercent(p)}% off)`).join(', ')}.`
      : `Nothing's on sale right now, but that changes regularly — worth checking back, or ask me to flag it next time you visit.`;
    return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 20) Buying as a gift for someone else
  if(/(gift|buy (this|it) for (my|a) friend|present for|surprise (my|a))/.test(text)){
    const p1 = `You can buy anything here as a gift — checkout just needs an email/payment, there's no requirement that it's your own. The simplest way: buy it, then forward the download link or access details you receive to whoever it's for.`;
    const p2 = `One thing to flag honestly: since delivery is handled by each individual seller, there's no built-in "gift wrapping" or scheduled-delivery feature — it delivers to whichever email completes checkout, right away.`;
    return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 21) Becoming a seller / listing a product
  if(/(sell (my|on)|list my (product|course)|become a (seller|partner|vendor)|partner with (you|lexden)|feature my product)/.test(text)){
    const p1 = `Creators can apply to sell on LEXDEN NOVA through the Creator program. Applications are reviewed by the team before anything can be listed.`;
    const p2 = `If you've got something you think fits, the way in is a direct pitch: email ${escapeHtml(c.contactEmail)} or WhatsApp ${escapeHtml(c.whatsappDisplay)} with what it is, and the team can look at whether it's a fit.`;
    return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 22) "What's trending / new" explanation — distinct from just listing
  // trending products: explains how the ranking actually works, since
  // "how is this decided" is a fair, common follow-up once someone notices
  // a Trending section exists.
  if(/(how (is|does) trending (work|decided|calculated)|what'?s new|what'?s trending|most popular right now|what (is|are) (people|others) (buying|viewing|liking))/.test(text)){
    const trendingNow = computeTrendingProducts(products, 5);
    const p1 = `Trending isn't manually curated — it's calculated from real activity across every shopper: product views, wishlist saves (weighted heavier, since saving something signals more intent than a glance), and likes on feed posts linked to that product.`;
    const p2 = trendingNow.length ? `Right now, that puts these on top: ${trendingNow.map(p=>pLink(p)).join(', ')}.` : `Nothing has enough activity yet to rank by signal, so the section is currently backfilled with staff picks until real traffic builds up.`;
    return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // ============ GENERAL-PURPOSE CHATBOT LAYER ============
  // Shoppers naturally try to use NOVA like a regular assistant, not just
  // a catalog lookup — this section handles that without needing a live
  // API call, so it works even in local mode.

  // 23) Safe arithmetic — a real calculator, not a canned "I can't do
  // math" line. Deliberately restricted to digits/operators/parens only
  // (validated by regex before ever touching eval-adjacent code) so it
  // can never execute arbitrary input.
  if(/^[\s\d+\-*/().]+$/.test(raw.trim()) && /\d/.test(raw) && /[+\-*/]/.test(raw)){
    try{
      const cleaned = raw.trim();
      if(!/^[\d+\-*/().\s]+$/.test(cleaned)) throw new Error('unsafe');
      const result = Function('"use strict"; return (' + cleaned + ')')();
      if(typeof result === 'number' && isFinite(result)){
        return `<p style="margin:0;"><strong>${escapeHtml(cleaned)} = ${Number(result.toFixed(6))}</strong></p>`;
      }
    }catch(e){ /* fall through to normal handling if it wasn't really math */ }
  }
  if(/(what'?s|calculate|compute|work out)\s+[\d+\-*/().\s]+\??$/.test(text) || /^\d+\s*(plus|minus|times|multiplied by|divided by)\s*\d+/.test(text)){
    let expr = text.replace(/plus/g,'+').replace(/minus/g,'-').replace(/times|multiplied by/g,'*').replace(/divided by/g,'/');
    const m = expr.match(/[\d+\-*/().\s]+/g);
    if(m){
      const candidate = m.sort((a,b)=>b.length-a.length)[0].trim();
      if(/\d/.test(candidate) && /[+\-*/]/.test(candidate)){
        try{
          const result = Function('"use strict"; return (' + candidate + ')')();
          if(typeof result === 'number' && isFinite(result)){
            return `<p style="margin:0;"><strong>${escapeHtml(candidate.trim())} = ${Number(result.toFixed(6))}</strong></p>`;
          }
        }catch(e){}
      }
    }
  }

  // 24) Date / time — genuinely useful and something people ask any
  // chatbot without thinking twice.
  if(/(what'?s (today'?s )?date|what (day|date) is (it|today)|current time|what time is it|what year is it)/.test(text)){
    const now = new Date();
    const p1 = `Right now it's ${now.toLocaleString(undefined, {weekday:'long', year:'numeric', month:'long', day:'numeric', hour:'2-digit', minute:'2-digit'})} on your device's clock.`;
    return `<p style="margin:0;">${p1}</p>`;
  }

  // 25) Identity / "are you a bot" / "are you human"
  if(/(are you (a )?(real |human|person|bot|robot|ai)\??|are you alive|do you have feelings)/.test(text)){
    const p1 = `I'm NOVA — an AI assistant built for this app, running on rule-based local logic (with an optional live-API mode the admin can switch on). Not human, no feelings to speak of, but I do try to give you real, specific answers instead of generic filler.`;
    return `<p style="margin:0;">${p1}</p>`;
  }

  // 26) Jokes / light entertainment — small, honest rotation rather than
  // pretending to have infinite material.
  if(/(tell me a joke|make me laugh|say something funny|know any jokes)/.test(text)){
    const jokes = [
      `Why do programmers prefer dark mode? Because light attracts bugs.`,
      `I'd tell you a joke about NGN exchange rates, but it changes before the punchline lands.`,
      `Why did the shopper break up with the browser's price filter? It wouldn't commit to a custom range.`,
      `What did one wishlist item say to the other? "Someday my discount will come."`,
    ];
    return `<p style="margin:0;">${jokes[Math.floor(Math.random()*jokes.length)]} 😄</p>`;
  }

  // 27) Capabilities — "what can you do" is one of the most common things
  // anyone types into any chatbot on first contact.
  if(/(what can you do|what are you (capable of|good for)|how (can|do) you help|what do you know)/.test(text)){
    const p1 = `Two things, really. First — I'm a genuine shopping assistant for LEXDEN NOVA: I can recommend products by budget/category/rating (even combined, like "beginner design under $20, 4★+"), compare two products, explain checkout, check your order status, troubleshoot the app, and answer policy/payment questions — all grounded in the real, live catalog, not guesses.`;
    const p2 = `Second — I can also just chat: quick math, the date/time, a joke, or a straight answer about how I work. For open-ended general-knowledge questions outside the catalog, I'm honest that local mode has limits — that's what live-API mode (if the admin's enabled it) is for.`;
    return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // ============ WEBSITE-MECHANICS LAYER ============
  // "How do I do X on this app" questions — previously most of these had
  // no dedicated branch at all and fell straight to the generic catalog
  // fallback, which is exactly backwards for a question that has nothing
  // to do with which product to buy.

  // 29) Dark mode / theme
  if(/(dark mode|light mode|switch theme|change (the )?theme|toggle theme)/.test(text)){
    const p1 = `You're currently in ${appState.theme==='dark'?'dark':'light'} mode. Switch it from the moon/sun icon in the top header, or from Profile → Settings → Theme — either toggles instantly, no reload.`;
    return `<p style="margin:0;">${p1}</p>`;
  }

  // 30) Notifications
  if(/(turn on notifications|enable notifications|push notifications|get notified|notification settings|stop notifications|disable notifications)/.test(text)){
    const on = window.__notificationsEnabled ? window.__notificationsEnabled() : false;
    const p1 = `Notifications are currently ${on?'ON':'OFF'} on this device. You can flip that from Profile → Settings → Notifications — when it's on, you'll get alerted for important announcements (the ones marked "Important" in the feed), not routine catalog updates.`;
    const p2 = `First time enabling, your browser will ask for permission directly — if you accidentally blocked it before, you'll need to re-allow notifications from your browser's own site settings, not from inside the app.`;
    return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 31) Password reset / login trouble
  if(/(forgot (my )?password|reset (my )?password|can'?t (log ?in|sign ?in)|change (my )?password)/.test(text)){
    const p1 = `On the Sign In screen there's a "Forgot password?" link right under the password field — tap it, enter your email, and a reset link gets sent there. If you signed up with "Sign in with Google" instead of an email/password, there's no app password to reset — you'd manage that through your Google account directly.`;
    const p2 = `If the reset email isn't arriving, check spam first, then message ${escapeHtml(c.contactEmail)} if it still doesn't show up after a few minutes.`;
    return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 32) Sign out / switch account
  if(/(sign out|log ?out|switch account|log into a different account)/.test(text)){
    const p1 = `Sign out from Profile → Sign out (near the bottom). To use a different account, sign out first, then sign back in with the other email — or with a different Google account if you're using Google sign-in.`;
    return `<p style="margin:0;">${p1}</p>`;
  }

  // 33) Account deletion / data removal
  if(/(delete (my )?account|remove (my )?(account|data)|close my account)/.test(text)){
    const p1 = `There's no self-serve "delete account" button in the app right now — this needs a manual request so it's handled properly rather than instantly wiping something by mistake. Email ${escapeHtml(c.contactEmail)} from the address on your account asking for deletion, and it'll be actioned from there.`;
    const p2 = `Note that's separate from just clearing local data: uninstalling the app or clearing site data only wipes what's stored on this device (wishlist, chat history) — your actual account and order history live server-side and need the request above to remove.`;
    return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 34) Wishlist mechanics
  if(/(how (do|to) i (save|add|remove) .*(wishlist)|what is (the )?wishlist|how does (the )?wishlist work|save for later)/.test(text)){
    const p1 = `Tap the heart icon on any product card or product page to save it to your Wishlist — tap it again to remove it. Your Wishlist tab (bottom nav) shows everything saved, sortable by newest or price, and syncs to your account if you're signed in, so it follows you across devices.`;
    return `<p style="margin:0;">${p1}</p>`;
  }

  // 35) Item code meaning
  if(/(what is (the |an )?item code|what does (the )?item code mean|what'?s (a |the )?(sku|item code) for)/.test(text)){
    const p1 = `The item code (e.g. "LX-COU-101") is this catalog's internal reference for a product — it's shown on every product page and is the fastest way for support to look up the exact item if you're asking about something specific. It's not a discount code or anything you need to enter.`;
    return `<p style="margin:0;">${p1}</p>`;
  }

  // 36) Reviews — leaving one, not reading one (reading is handled by
  // the general product-question branches already)
  if(/(how (do|can) i (leave|write|submit|add) a review|leave feedback on|rate (this|a) product)/.test(text)){
    const p1 = `On any product page, scroll to the Reviews section — there's a "Write a review" option there where you pick a star rating and add a comment. You'll need to be signed in so the review is tied to your account.`;
    return `<p style="margin:0;">${p1}</p>`;
  }

  // 37) Sharing a product/post
  if(/(how (do|can) i share|share (this|a) (product|link|post)|send this to a friend)/.test(text)){
    const p1 = `Every product page and feed post has a Share button — it uses your device's normal share sheet (WhatsApp, copy link, etc.) if available, or copies the link directly if not. ${currentProduct ? `On the page you're on now, it's near the top next to the wishlist heart.` : ''}`;
    return `<p style="margin:0;">${p1}</p>`;
  }

  // 38) Privacy / terms / cookies — answered honestly rather than
  // inventing policy text that doesn't exist in the app's actual content.
  if(/(privacy policy|terms of service|terms and conditions|cookie policy|data protection|gdpr)/.test(text)){
    const p1 = `The Privacy Policy link is in Menu → Legal. I don't have the full policy text loaded into my own answers though, so for the actual legal wording, open that link directly rather than relying on my summary of it.`;
    const p2 = `In plain terms: this app stores your wishlist/preferences locally on your device and, if you sign in, syncs account data (profile, orders, liked posts) to the backend so it follows you across devices. Payment details are handled by Paystack or the individual seller, never stored by LEXDEN NOVA directly.`;
    return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 39) Multi-device / sync
  if(/(sync across devices|use (this |it )?on (another|multiple|different) device|same account (on|from) (my )?(phone|laptop|computer))/.test(text)){
    const p1 = `Sign in with the same account (email or Google) on the other device and your wishlist, liked posts, and order history all sync automatically through your account — nothing device-specific there. Things stored only locally per-device are your theme choice, notification toggle, and NOVA chat history, since those are just browser preferences, not account data.`;
    return `<p style="margin:0;">${p1}</p>`;
  }

  // 40) App version / updates
  if(/(what version|app version|is there an update|new version available|latest version)/.test(text)){
    const p1 = `This is a web app (PWA), so there's no version number to check manually — it updates automatically when you reload, and if you've installed it to your home screen, Menu shows an "update available" banner the moment a new version is live.`;
    return `<p style="margin:0;">${p1}</p>`;
  }

  // 41) Language support
  if(/(other languages|change language|is this available in|do you speak)/.test(text)){
    const p1 = `The interface itself is English only right now (with a good amount of Nigerian Pidgin understanding built into me specifically, so "wetin", "abeg", "how much e cost" etc. all work fine when you're chatting with me). There's no language switcher for the rest of the app yet.`;
    return `<p style="margin:0;">${p1}</p>`;
  }

  // 42) Offline / connectivity
  if(/(work offline|no internet|without wifi|does it need internet)/.test(text)){
    const p1 = `If you've installed the app (Menu → Install, or your browser's install prompt), pages you've already visited stay viewable offline thanks to the service worker cache — but anything needing fresh data (checkout, sign-in, new prices, order status) still needs a connection.`;
    return `<p style="margin:0;">${p1}</p>`;
  }

  // 28) General-knowledge / off-topic questions — an honest, chatbot-style
  // answer for things that have nothing to do with the catalog, instead of
  // forcing every off-topic question into a product pitch. Only triggers
  // when the message has zero shopping-relevant vocabulary, so it never
  // hijacks a genuine "recommend me something" question.
  const SHOPPING_SIGNAL = /(product|price|buy|cheap|expensive|free|order|checkout|wishlist|category|rating|review|discount|refund|catalog|course|template|software|bundle|seller|trending|feature|install|app|account|sign ?in|sign ?up|profile|payment|currency|naira|dollar)/;
  if(constraints===null && !SHOPPING_SIGNAL.test(text) && text.trim().split(/\s+/).length>=2 && DB.content.novaMode!=='api'){
    logUnansweredQuery(raw);
    const p1 = `That's outside the shopping catalog I'm actually grounded in, so I want to be honest rather than make something up: in local mode, I don't have general world-knowledge or a live model behind me — I only reason reliably about LEXDEN NOVA's real data (products, prices, policies, orders).`;
    const p2 = `If the admin switches me to live-API mode (Admin → NOVA AI Setup), I'd be able to hold a genuinely open-ended conversation too. Until then, ask me anything about the catalog and I'll give you a real, specific answer.`;
    return [p1,p2].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
  }

  // 10) Fallback — general, still catalog-grounded and multi-paragraph,
  // and now uses shopper memory to steer the sample toward their apparent
  // interest instead of always showing the same top-rated three.
  logUnansweredQuery(raw);
  const sp = shopperProfile();
  let sample = products.slice().sort((a,b)=>b.rating-a.rating);
  if(sp.topCategory) sample = sample.filter(p=>p.category===sp.topCategory).length ? sample.filter(p=>p.category===sp.topCategory) : sample;
  sample = sample.slice(0,3);
  // Fuzzy nearest-product match: even in the fallback, if any single word
  // in the message is a strong partial match to a real product name, surface
  // it directly — this alone resolves a large share of "I don't understand"
  // dead-ends, since a lot of unmatched queries are just a product name the
  // regex branches above weren't looking for.
  const words = text.split(/\s+/).filter(w=>w.length>3);
  // Fuzzy match first (typo-tolerant, scores whole product names — see
  // fuzzyFindProduct), falling back to the plain substring check so
  // neither approach's blind spots are the only line of defense.
  const nameHit = fuzzyFindProduct(text, products) || products.find(p=>words.some(w=>p.name.toLowerCase().includes(w)));
  const p1 = `I want to give you a genuinely useful answer rather than a generic one, so let me work with what I know: LEXDEN NOVA currently lists ${products.length} products across ${DB.categories.length-1} categories (${DB.categories.filter(c2=>c2.id!=='all').map(c2=>c2.name).join(', ')}).`;
  const p2 = nameHit
    ? `I noticed you mentioned something close to ${pLink(nameHit)} — is that what you meant? It's ${moneyStr(nameHit)} at ${nameHit.rating}★. If so, ask me anything specific about it and I'll answer directly.`
    : (sp.topCategory
        ? `Since you've been showing interest in ${escapeHtml(sp.topCategory)}, here are a few strong picks from there: ${sample.map(p=>pLink(p)).join(', ')} — all ${sample[sample.length-1]?.rating}★ or higher.`
        : `A few of the best-reviewed picks right now are ${sample.map(p=>pLink(p)).join(', ')} — all ${sample[sample.length-1]?.rating}★ or higher.`);
  const p3 = `I can recommend products by budget, category, rating, or level, combine several conditions at once, compare two items, check your order status, troubleshoot the app, or explain policy/payment questions — just phrase it naturally.`;
  const p4 = `What would help most right now?`;
  return [p1,p2,p3,p4].map(t=>`<p style="margin:0 0 8px;">${t}</p>`).join('');
}
