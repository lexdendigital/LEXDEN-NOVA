'use strict';

/* ---------------- STORAGE / STATE ---------------- */
const LS_KEYS = {
  products:'ln_products', categories:'ln_categories', testimonials:'ln_testimonials',
  faqs:'ln_faqs', content:'ln_content', wishlist:'ln_wishlist', theme:'ln_theme',
  novaHistory:'ln_nova_history', activityLog:'ln_activity_log', notif:'ln_notif',
  currency:'ln_currency', feed:'ln_feed', services:'ln_services',
  management:'ln_management', novaLearning:'ln_nova_learning',
  seeded:'ln_seeded_v1', installDismissed:'ln_install_dismissed',
  pendingPayments:'ln_pending_payments',
  likedPosts:'ln_liked_posts', feedLikeCounts:'ln_feed_like_counts',
  productViewCounts:'ln_product_view_counts', productWishlistCounts:'ln_product_wishlist_counts',
  feedViewCounts:'ln_feed_view_counts',
  productClickCounts:'ln_product_click_counts', productShareCounts:'ln_product_share_counts',
  feedShareCounts:'ln_feed_share_counts', suppliers:'ln_suppliers'
};

function lsGet(key, fallback){
  try{ const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch(e){ return fallback; }
}
function lsSet(key, val){
  try{ localStorage.setItem(key, JSON.stringify(val)); }catch(e){ console.warn('Storage failed', e); }
}

function seedIfNeeded(){
  if(!lsGet(LS_KEYS.seeded, false)){
    // NO demo products/feed/services/team are seeded any more — a new device
    // starts empty and shows a loading state until the REAL catalog arrives
    // from Firestore (see pullFromCloud). The DEFAULT_* demo arrays below
    // are kept only so old installs can be recognised and cleaned.
    lsSet(LS_KEYS.products, []);
    lsSet(LS_KEYS.categories, DEFAULT_CATEGORIES);
    lsSet(LS_KEYS.testimonials, DEFAULT_TESTIMONIALS);
    lsSet(LS_KEYS.faqs, DEFAULT_FAQS);
    lsSet(LS_KEYS.content, DEFAULT_CONTENT);
    lsSet(LS_KEYS.wishlist, []);
    lsSet(LS_KEYS.feed, []);
    lsSet(LS_KEYS.services, []);
    lsSet(LS_KEYS.management, []);
    lsSet(LS_KEYS.seeded, true);
    logActivity('System', 'App initialized with demo catalog');
  } else {
    // Migration for installs seeded by an older version of this file: fill in
    // any newly-added fields/collections without touching existing admin edits.
    const c = lsGet(LS_KEYS.content, DEFAULT_CONTENT);
    let changed = false;
    Object.keys(DEFAULT_CONTENT).forEach(k=>{ if(!(k in c)){ c[k]=DEFAULT_CONTENT[k]; changed=true; } });
    if(changed) lsSet(LS_KEYS.content, c);
    if(lsGet(LS_KEYS.feed, null)===null) lsSet(LS_KEYS.feed, []);
    if(lsGet(LS_KEYS.services, null)===null) lsSet(LS_KEYS.services, []);
    if(lsGet(LS_KEYS.management, null)===null) lsSet(LS_KEYS.management, []);
  }
  purgeDemoCatalog();
}
// Devices that were seeded by an older version still hold the demo catalog
// (p1..p8, fp1..fp3, ...). If a stored list contains ONLY demo items, empty
// it so the real catalog from Firestore is the only thing ever shown.
// Real admin-created items have other ids, so they are never touched.
function purgeDemoCatalog(){
  const pairs = [
    [LS_KEYS.products, DEFAULT_PRODUCTS], [LS_KEYS.feed, DEFAULT_FEED_POSTS],
    [LS_KEYS.services, DEFAULT_SERVICES], [LS_KEYS.management, DEFAULT_MANAGEMENT],
  ];
  pairs.forEach(([key, demo])=>{
    const stored = lsGet(key, null);
    if(!Array.isArray(stored) || !stored.length) return;
    const demoIds = new Set(demo.map(d=>d && d.id));
    if(stored.every(x=>x && demoIds.has(x.id))) lsSet(key, []);
  });
}

const DB = {
  // Catalog products ONLY (what the admin edits, saves and pushes to the cloud).
  get legacyProducts(){
    const list = lsGet(LS_KEYS.products, []).filter(p=>!(p && p._creator));
    return list.map(p=>{
      const stats = liveRatingStats(p);
      return { ...p, rating: stats.rating, reviewCount: stats.count };
    });
  },
  // Storefront view = catalog + published creator listings (in memory only —
  // never written to localStorage or to catalog/products).
  get products(){
    const list = lsGet(LS_KEYS.products, []).filter(p=>!(p && p._creator)).concat(window.__creatorProducts||[]);
    // Every consumer of DB.products (sorting, NOVA AI replies, product
    // cards, schema, etc.) sees a real, live-computed rating/reviewCount
    // here — never the old fabricated seed numbers. See liveRatingStats().
    // Speed: read the reviews ONCE and total them per product, instead of
    // re-reading and re-parsing the whole review list for every product.
    const sums = Object.create(null), counts = Object.create(null);
    DB.testimonials.forEach(t=>{ if(t && t.productId!=null){ sums[t.productId]=(sums[t.productId]||0)+(t.rating||0); counts[t.productId]=(counts[t.productId]||0)+1; } });
    return list.map(p=>{
      const n = counts[p.id]||0;
      return { ...p, rating: n ? Math.round(sums[p.id]/n*10)/10 : 0, reviewCount: n };
    });
  },
  set products(v){ lsSet(LS_KEYS.products, (v||[]).filter(p=>!(p && p._creator))); },
  get categories(){ return lsGet(LS_KEYS.categories, DEFAULT_CATEGORIES); },
  set categories(v){ lsSet(LS_KEYS.categories, v); },
  get testimonials(){ return lsGet(LS_KEYS.testimonials, DEFAULT_TESTIMONIALS); },
  set testimonials(v){ lsSet(LS_KEYS.testimonials, v); },
  get faqs(){ return lsGet(LS_KEYS.faqs, DEFAULT_FAQS); },
  set faqs(v){ lsSet(LS_KEYS.faqs, v); },
  get content(){ return lsGet(LS_KEYS.content, DEFAULT_CONTENT); },
  set content(v){ lsSet(LS_KEYS.content, v); },
  get wishlist(){ return lsGet(LS_KEYS.wishlist, []); },
  set wishlist(v){ lsSet(LS_KEYS.wishlist, v); },
  // Feed-post likes are deliberately kept OUT of DB.feed (the admin-authored
  // content array synced wholesale from the admin-only catalog/settings
  // cloud doc) — anything stored inside a feed post object here would be
  // silently wiped the next time an admin edit pulls fresh content down.
  // Counts and "did I like this" live in their own local cache + their own
  // Firestore collection instead (see pushFeedLikeToCloud / pullFeedLikesFromCloud),
  // the same way reviews got their own collection instead of living inside
  // the admin content doc.
  get likedPosts(){ return lsGet(LS_KEYS.likedPosts, []); },
  set likedPosts(v){ lsSet(LS_KEYS.likedPosts, v); },
  get feedLikeCounts(){ return lsGet(LS_KEYS.feedLikeCounts, {}); },
  set feedLikeCounts(v){ lsSet(LS_KEYS.feedLikeCounts, v); },
  // Cross-shopper interest signals that power dynamic Trending / Featured
  // For You (see computeTrendingProducts / computeFeaturedForYou below).
  // Same pattern as feedLikeCounts: a local cache kept in sync with a
  // shared Firestore counter via increment(), so every device's view of
  // "what's actually getting attention" converges over time without
  // needing a real backend.
  get productViewCounts(){ return lsGet(LS_KEYS.productViewCounts, {}); },
  set productViewCounts(v){ lsSet(LS_KEYS.productViewCounts, v); },
  get productWishlistCounts(){ return lsGet(LS_KEYS.productWishlistCounts, {}); },
  set productWishlistCounts(v){ lsSet(LS_KEYS.productWishlistCounts, v); },
  // Same shared-counter pattern, for feed post opens — the missing global
  // signal for "related/trending feed" (a post everyone's opening but not
  // liking yet was previously invisible to feedHotScore).
  get feedViewCounts(){ return lsGet(LS_KEYS.feedViewCounts, {}); },
  set feedViewCounts(v){ lsSet(LS_KEYS.feedViewCounts, v); },
  // Clicks and shares — same shared-counter pattern, feeding trendingScore()
  // and feedHotScore() alongside views/wishlists/likes (see those functions).
  get productClickCounts(){ return lsGet(LS_KEYS.productClickCounts, {}); },
  set productClickCounts(v){ lsSet(LS_KEYS.productClickCounts, v); },
  get productShareCounts(){ return lsGet(LS_KEYS.productShareCounts, {}); },
  set productShareCounts(v){ lsSet(LS_KEYS.productShareCounts, v); },
  get feedShareCounts(){ return lsGet(LS_KEYS.feedShareCounts, {}); },
  set feedShareCounts(v){ lsSet(LS_KEYS.feedShareCounts, v); },
  get feed(){ return lsGet(LS_KEYS.feed, []); },
  set feed(v){ lsSet(LS_KEYS.feed, v); },
  get services(){ return lsGet(LS_KEYS.services, []); },
  set services(v){ lsSet(LS_KEYS.services, v); },
  get management(){ return lsGet(LS_KEYS.management, []); },
  set management(v){ lsSet(LS_KEYS.management, v); },
  // Dropshipping/fulfilment suppliers (physical-commerce admin section).
  // Deliberately holds ONLY non-secret, admin-visible fields — no API
  // keys ever live here. See adminSuppliers()'s own comment for why.
  get suppliers(){ return lsGet(LS_KEYS.suppliers, []); },
  set suppliers(v){ lsSet(LS_KEYS.suppliers, v); },
};

/* ---------------- CLOUD SYNC (Firebase) ----------------
   IMPORTANT LESSON FROM v1.12: every push function below used to swallow
   its own errors with a silent console.warn(). That meant a permission
   error (e.g. Firestore rules rejecting the write) looked EXACTLY like a
   successful save from the admin's point of view — the toast said
   "Product saved" either way. That's why a test product could be added
   and never show up anywhere else. Every push now surfaces a visible
   toast on failure, and cloudStatus() tracks whether the last attempt
   actually reached the server, shown on the Dashboard tab. */
window.__cloudStatus = { ok:null, lastError:'', lastCheck:null };
function setCloudStatus(ok, err){
  window.__cloudStatus = { ok, lastError: err ? (err.code || err.message || String(err)) : '', lastCheck: new Date().toISOString() };
}
function isPermissionError(e){
  const msg = (e && (e.code||e.message||'')).toString().toLowerCase();
  return msg.includes('permission-denied') || msg.includes('insufficient');
}
function explainCloudError(e){
  if(isPermissionError(e)) return 'Firestore rejected this write (permission-denied). This almost always means your security rules\' admin email doesn\'t match the email you\'re signed in with, or the rules haven\'t been published yet.';
  return 'Could not reach the cloud database — check your data connection.';
}

async function pushProductsToCloud(){
  if(!window.__fb) return false;
  const { fbDb, doc, setDoc } = window.__fb;
  try{
    // BUGFIX ("edits disappear after a while"): every one of these
    // Firestore calls used to have no timeout — see withTimeout()'s
    // comment further down this file for the original case this pattern
    // fixed (signup hanging forever). On a slow/flaky mobile connection a
    // save could sit "in flight" far longer than the admin waits around
    // for, and if the tab/app got backgrounded or killed before it truly
    // finished, the edit was silently lost even though a "Saved" state
    // may have already been assumed. Bounding every push/pull to a fixed
    // window means a failure is reported honestly and promptly instead of
    // leaving the admin thinking something saved when it didn't.
    await withTimeout(setDoc(doc(fbDb, "catalog", "products"), { list: DB.legacyProducts }), 20000, 'Saving products timed out — check your connection and try again.');
    await withTimeout(setDoc(doc(fbDb, "catalog", "categories"), { list: DB.categories }), 20000, 'Saving categories timed out — check your connection and try again.');
    setCloudStatus(true);
    return true;
  }catch(e){
    setCloudStatus(false, e);
    console.warn("Cloud push failed", e);
    toast('⚠️ Cloud save failed — ' + explainCloudError(e), 'error');
    return false;
  }
}

// Everything else an admin edits (branding, currency, hero/about text,
// social links, services, feed posts, team, FAQs, NOVA settings) lives in
// one shared "settings" document so it syncs across every device the same
// way products already do.
async function pushSettingsToCloud(){
  if(!window.__fb) return false;
  const { fbDb, doc, setDoc } = window.__fb;
  try{
    await withTimeout(setDoc(doc(fbDb, "catalog", "settings"), {
      content: DB.content, services: DB.services, feed: DB.feed,
      management: DB.management, faqs: DB.faqs, suppliers: DB.suppliers,
    }), 20000, 'Saving settings timed out — check your connection and try again.');
    setCloudStatus(true);
    return true;
  }catch(e){
    setCloudStatus(false, e);
    console.warn("Settings push failed", e);
    toast('⚠️ Cloud save failed — ' + explainCloudError(e), 'error');
    return false;
  }
}

async function pushWishlistToCloud(){
  if(!window.__fb || !window.__fbUid) return;
  const { fbDb, doc, setDoc } = window.__fb;
  try{
    await withTimeout(setDoc(doc(fbDb, "wishlists", window.__fbUid), { ids: DB.wishlist }), 15000, 'Saving wishlist timed out.');
  }catch(e){ console.warn("Wishlist push failed", e); /* non-critical, no toast */ }
}

// Reviews are the one piece of "catalog" data any visitor must be able to
// write (submitting a review), not just the admin — so they live in their
// own collection with create:true, separate from the admin-only catalog
// docs. See the security rules block for the matching /reviews rule.
async function pushReviewToCloud(t){
  if(!window.__fb) return false;
  const { fbDb, doc, setDoc } = window.__fb;
  try{
    await withTimeout(setDoc(doc(fbDb, "reviews", t.id), t), 15000, 'Saving your review timed out.');
    return true;
  }catch(e){ console.warn("Review push failed", e); toast('Could not save your review to the cloud — it is only visible on this device.', 'error'); return false; }
}
async function pullReviewsFromCloud(){
  if(!window.__fb) return;
  const { fbDb, collection, getDocs } = window.__fb;
  try{
    const snap = await withTimeout(getDocs(collection(fbDb, "reviews")), 15000, 'Loading reviews timed out.');
    if(!snap.empty){
      const list = [];
      snap.forEach(d=>list.push(d.data()));
      list.sort((a,b)=> new Date(b.date||0) - new Date(a.date||0));
      DB.testimonials = list;
    }
  }catch(e){ console.warn("Reviews pull failed", e); }
}
async function deleteReviewFromCloud(id){
  if(!window.__fb) return;
  const { fbDb, doc, deleteDoc } = window.__fb;
  try{
    await withTimeout(deleteDoc(doc(fbDb, "reviews", id)), 15000, 'Deleting review timed out.');
    setCloudStatus(true);
  }catch(e){
    setCloudStatus(false, e);
    toast('⚠️ Could not delete review from cloud — ' + explainCloudError(e), 'error');
  }
}

/* ---------------- CREATOR LISTINGS (marketplace) ----------------
   Published listings from approved creators come from the public, sanitised
   /api/creator-listings endpoint (never straight from Firestore — a listing's
   private delivery details must reach a buyer only after payment). They are
   mapped into the normal product shape and held IN MEMORY ONLY (see DB.products
   getter) so they can never be saved into the admin's catalog.
   Prices: a creator prices in ONE currency (usually NGN). Legacy products are
   stored in USD and converted; to make both display identically the creator
   price is stored as price/rate[currency], and checkout (startPaystackCheckout)
   charges the creator's own price in the creator's own currency, exactly. */
const CREATOR_CATEGORY_FALLBACK = { EBOOK:'ebooks', COURSE:'courses', TEMPLATE:'templates', SOFTWARE:'software', BUNDLE:'bundles', PHYSICAL_PRODUCT:'accessories' };
function mapCreatorListing(l){
  try{
    if(!l || !l.id || !l.title) return null;
    const rates = (DB.content && DB.content.exchangeRates) || {};
    const cur = l.currency || 'NGN';
    const rate = rates[cur];
    if(!l.isFree && !(rate>0 && typeof l.price==='number' && l.price>0)) return null;
    const cats = DB.categories || [];
    const want = String(l.category||'').trim().toLowerCase();
    const hit = cats.find(c=>String(c.id).toLowerCase()===want || String(c.name).toLowerCase()===want);
    const fb = CREATOR_CATEGORY_FALLBACK[l.offeringType];
    const category = hit ? hit.id : ((cats.find(c=>c.id===fb)||{}).id || fb || 'all');
    const specs = {};
    if(l.systemRequirements) specs['Requirements'] = l.systemRequirements;
    if(l.pageCount) specs['Pages'] = String(l.pageCount);
    if(l.compatibility) specs['Compatibility'] = l.compatibility;
    if(l.level) specs['Level'] = l.level;
    if(l.modules && l.modules.length) specs['Modules'] = String(l.modules.length);
    if(l.turnaround) specs['Turnaround'] = l.turnaround;
    if(l.deliverables) specs['You get'] = l.deliverables;
    if(l.billingInterval) specs['Billing'] = l.billingInterval;
    if(l.refundPolicy) specs['Refund policy'] = l.refundPolicy;
    const images = l.images && l.images.length ? l.images : [];
    const prod = {
      id: l.id, name: l.title, category,
      price: l.isFree ? 0 : l.price / rate, salePrice: null, free: !!l.isFree,
      rating: 0, reviewCount: 0, itemCode: 'CR-'+String(l.id).slice(0,6).toUpperCase(),
      image: images[0] || '', gallery: images, description: l.description || '', specs,
      tags: [], seller: l.sellerName || 'Creator', status: 'published',
      affiliateLink: '#', productType: l.physical ? 'PHYSICAL' : 'DIGITAL',
      _creator: { price: l.isFree ? 0 : l.price, currency: cur, sellerId: l.sellerId, sellerUsername: l.sellerUsername || null, verified: !!l.sellerVerified, offeringType: l.offeringType, inStock: l.inStock !== false },
    };
    if(l.physical){
      prod.physical = {
        shippingCountries: ['Nigeria'],
        deliveryEstimate: l.processingDays ? `Ships within ${l.processingDays} day${l.processingDays===1?'':'s'}` : '',
        stockStatus: l.inStock === false ? 'out_of_stock' : 'in_stock',
      };
    }
    return prod;
  }catch(e){ console.warn('mapCreatorListing failed', e); return null; }
}
async function loadCreatorListings(){
  try{
    const r = await withTimeout(fetch(API_BASE+'/api/creator-listings', {cache:'no-store'}), 12000, 'Loading creator listings timed out.');
    const d = await r.json();
    if(d && d.ok && d.data && Array.isArray(d.data.listings)){
      window.__creatorProducts = d.data.listings.map(mapCreatorListing).filter(Boolean);
    }
  }catch(e){ console.warn('creator listings unavailable', e && e.message); }
}

async function pullFromCloud(){
  if(!window.__fb) return;
  const { fbDb, doc, getDoc } = window.__fb;
  try{
    const prodSnap = await withTimeout(getDoc(doc(fbDb, "catalog", "products")), 20000, 'Loading products timed out.');
    if(prodSnap.exists()) DB.products = prodSnap.data().list;

    const catSnap = await withTimeout(getDoc(doc(fbDb, "catalog", "categories")), 20000, 'Loading categories timed out.');
    if(catSnap.exists()) DB.categories = catSnap.data().list;

    const settingsSnap = await withTimeout(getDoc(doc(fbDb, "catalog", "settings")), 20000, 'Loading settings timed out.');
    if(settingsSnap.exists()){
      const s = settingsSnap.data();
      if(s.content) DB.content = {...DB.content, ...s.content};
      migrateLegacyHomeMessaging();
      if(s.services) DB.services = s.services;
      if(s.feed) DB.feed = s.feed;
      if(s.management) DB.management = s.management;
      if(s.faqs) DB.faqs = s.faqs;
      if(s.suppliers) DB.suppliers = s.suppliers;
    }

    await loadCreatorListings();
    await pullReviewsFromCloud();
    await pullFeedLikesFromCloud();
    await pullProductInterestFromCloud();
    await pullFeedViewCountsFromCloud();

    if(window.__fbUid){
      const wishSnap = await withTimeout(getDoc(doc(fbDb, "wishlists", window.__fbUid)), 15000, 'Loading wishlist timed out.');
      const cloudIds = wishSnap.exists() ? (wishSnap.data().ids||[]) : [];
      // Merge, don't overwrite: anything the shopper wishlisted as a guest
      // right before signing in (still sitting in DB.wishlist on this
      // device) must not be silently wiped by an older cloud copy. Union
      // the two and push back up so every device converges on the same list.
      const merged = Array.from(new Set([...(DB.wishlist||[]), ...cloudIds]));
      DB.wishlist = merged;
      if(merged.length !== cloudIds.length) pushWishlistToCloud();
    }
    setCloudStatus(true);
    window.__catalogLoaded = true;
  }catch(e){ setCloudStatus(false, e); console.warn("Cloud pull failed", e); window.__catalogLoaded = true; window.__catalogFailed = true; }
}
// True while a brand-new device is still waiting for the real catalog.
function catalogIsLoading(){ return !window.__catalogLoaded; }

// BUGFIX (round 2 — "signed in as a different account, feed was already
// liked"): the previous fix only cleared DB.likedPosts/DB.wishlist inside
// the explicit Sign Out button handler (__googleSignOut). That's not the
// only way this device's active account can change — e.g. tapping
// "Continue with Google" again while ALREADY signed in and picking a
// different Google account from the picker swaps the Firebase user
// directly, without ever going through Sign Out, so that clear never ran
// and Account A's locally-cached likes/wishlist survived into Account B's
// first sync. Rather than trying to catch every place an account switch
// can originate, this guards the one place all of them funnel through:
// window.__novaCloudSync, which onAuthStateChanged calls on every single
// identity change no matter what caused it. It remembers the uid this
// device last actually synced as (ln_last_identity), and whenever that
// uid changes to a DIFFERENT real shopper — or drops to guest/signed-out —
// it wipes the local caches before pullFromCloud()'s merge runs, so the
// new identity always starts from its own cloud data only. The one case
// this deliberately still allows through un-wiped is guest → first-ever
// sign-in (lastUid null, currentUid set), which is what lets a genuine
// guest's pre-signup likes carry into their brand new account.
function guardAccountSwitch(){
  const currentUid = window.__fbShopper ? window.__fbShopper.uid : null; // null = guest/admin
  let last = null;
  try{ last = JSON.parse(localStorage.getItem('ln_last_identity')||'null'); }catch(e){}
  const lastUid = last && last.uid || null;
  // BUGFIX ("feed likes disappearing"/heart un-filling on their own): this
  // used to wipe on ANY uid change, including lastUid (real) -> currentUid
  // (null). onAuthStateChanged can refire with a transient null before the
  // session settles back in — e.g. right after the storage-eviction blip
  // noted above, or a brief reconnect — even though the person never
  // actually signed out. Wiping likedPosts on that blip made an already-
  // liked post look un-liked; tapping the heart again then re-incremented
  // the shared Firestore counter instead of decrementing it, which is
  // exactly the "12 -> 0 -> 6 -> 0" drift being reported. Only a genuine
  // switch BETWEEN two different real accounts (both uids non-null) is an
  // actual identity change that should wipe local state; a drop to/from
  // guest is handled by pullFromCloud()'s own merge logic instead.
  if(lastUid && currentUid && lastUid !== currentUid){
    DB.likedPosts = [];
    DB.wishlist = [];
  }
  localStorage.setItem('ln_last_identity', JSON.stringify({ uid: currentUid }));
}

window.__novaCloudSync = async function(){
  guardAccountSwitch();
  await pullFromCloud();
  // BUGFIX: this used to call render() unconditionally. Firebase's
  // onAuthStateChanged (and therefore this sync) can fire mid-flight while
  // someone is still filling in or submitting the Sign Up / Login screens
  // — those screens don't show any cloud data, so re-rendering them here
  // serves no purpose and only risks replacing the exact DOM nodes
  // finishSignup()/handleEmailLogin() are about to update, making the
  // in-progress submission look frozen even once it actually finishes.
  const hash = location.hash;
  if(hash !== '#signup' && hash !== '#login'){
    render();
  }
  syncWishIcons();
};

/* ---------------- SHOPPER PROFILES ('users' collection) ----------------
   Separate from the admin account: admin signs in with email/password
   (see tryAdminLogin) and is never written here. Every shopper who signs
   in with Google gets/updates a doc at users/{uid}. */
window.__novaUpsertUserProfile = async function(shopper){
  if(!window.__fb || !shopper) return;
  const { fbDb, doc, getDoc, setDoc } = window.__fb;
  try{
    const ref = doc(fbDb, "users", shopper.uid);
    const existing = await getDoc(ref);
    const prior = existing.exists() ? existing.data() : {};
    await setDoc(ref, {
      uid: shopper.uid,
      name: shopper.name || prior.name || '',
      email: shopper.email || prior.email || '',
      photoURL: shopper.photoURL || prior.photoURL || '',
      address: shopper.address !== undefined ? shopper.address : (prior.address||''),
      occupation: shopper.occupation !== undefined ? shopper.occupation : (prior.occupation||''),
      gender: shopper.gender !== undefined ? shopper.gender : (prior.gender||''),
      dob: shopper.dob !== undefined ? shopper.dob : (prior.dob||''),
      country: shopper.country !== undefined ? shopper.country : (prior.country||''),
      state: shopper.state !== undefined ? shopper.state : (prior.state||''),
      howHeard: shopper.howHeard !== undefined ? shopper.howHeard : (prior.howHeard||''),
      // Set once — either by saving or explicitly skipping the "finish
      // your profile" card — so a Google shopper is only ever asked for
      // the details Google didn't supply ONE time, the first time they
      // use that email, never again on later logins.
      profileSetupDone: shopper.profileSetupDone !== undefined ? shopper.profileSetupDone : (prior.profileSetupDone||false),
      provider: shopper.provider || prior.provider || 'google',
      updatedAt: new Date().toISOString(),
      createdAt: prior.createdAt || new Date().toISOString(),
    }, { merge:true });
  }catch(e){ console.warn("User profile save failed", e); }
};
window.__novaFetchUserProfile = async function(uid){
  if(!window.__fb || !uid) return null;
  const { fbDb, doc, getDoc } = window.__fb;
  try{
    const snap = await getDoc(doc(fbDb, "users", uid));
    return snap.exists() ? snap.data() : null;
  }catch(e){ console.warn("User profile fetch failed", e); return null; }
};

/* ---------------- ORDERS ----------------
   Orders are written server-side only (by the /api/verify-paystack
   serverless function, using the Firebase Admin SDK, AFTER it has
   independently verified the transaction with Paystack). The client never
   writes to /orders — it only ever reads its own — so a shopper can't
   fabricate a "paid" order by calling Firestore directly. See
   firestore.rules for the matching read-only-own-orders rule. */
async function fetchMyOrders(){
  if(!window.__fb || !window.__fbUid) return [];
  const { fbDb, collection, getDocs, query, where, orderBy } = window.__fb;
  try{
    const q = query(collection(fbDb, "orders"), where("uid", "==", window.__fbUid), orderBy("timestamp", "desc"));
    const snap = await getDocs(q);
    const list = [];
    snap.forEach(d=>list.push({ id:d.id, ...d.data() }));
    cacheOrdersForNova(list);
    return list;
  }catch(e){
    console.warn("Fetch orders failed", e);
    return [];
  }
}

/* ---------------- CHECKOUT ----------------
   startCheckout() is the single entry point the UI calls. It dispatches
   to whichever gateway is configured (DB.content.paymentGateway), so
   adding Flutterwave or another provider later means writing one new
   startXFlutterwaveCheckout()-style function and adding one case here —
   nothing else in the app needs to change. */
function startCheckout(productId, variantId){
  const p = findProduct(productId);
  const selectedVariant=(p&&p.variants||[]).find(v=>String(v.id)===String(variantId||appState.selectedVariants[productId]||''));
  if(p&&(p.variants||[]).length&&!isVariantPurchasable(selectedVariant)){toast('Choose an available product option before continuing.','error');return;}
  // A product can be marked to complete payment on another site entirely
  // (e.g. a seller's own Selar/Gumroad page) instead of the in-app Paystack
  // popup. When set, that always wins — checked before the gateway dispatch
  // below so it works no matter which gateway is configured.
  const externalPaymentLink=selectedVariant&&(selectedVariant.externalPaymentLink||selectedVariant.affiliateLink)||p&&p.externalPaymentLink;
  if(p && externalPaymentLink){
    logActivity('User', `Sent to external payment link for "${p.name}"`);
    openCheckoutReviewModal(p,selectedVariant,null,()=>window.open(externalPaymentLink,'_blank','noopener'),true);
    return;
  }
  const gateway = DB.content.paymentGateway || 'paystack';
  if(gateway === 'paystack') return startPaystackCheckout(productId,selectedVariant&&selectedVariant.id||null);
  // Extension point for future gateways, e.g.:
  // if(gateway === 'flutterwave') return startFlutterwaveCheckout(productId);
  // Shoppers never see internal config details — just a plain, friendly
  // message. The specific reason is logged to the console for whoever's
  // debugging, and to the admin dashboard's activity log.
  console.warn(`Checkout attempted with unconfigured gateway "${gateway}"`);
  toast('Checkout is temporarily unavailable. Please try again shortly.', 'error');
}

// Wake the (free-plan) backend before it is needed: a sleeping Render service
// takes ~30-50s on its first request, which is exactly when a payment is being
// confirmed or the first NOVA question is asked. A tiny GET /api/health at
// checkout start / chat open / app start means it is already awake. Throttled.
let __lastWarmAt = 0;
function warmBackend(){
  try{
    if(Date.now() - __lastWarmAt < 4*60*1000) return;
    __lastWarmAt = Date.now();
    fetch(API_BASE + '/api/health', { method:'GET', cache:'no-store', keepalive:true }).catch(()=>{});
  }catch(e){}
}
function startPaystackCheckout(productId, variantId, deliveryDetails, confirmed){
  warmBackend();
  const p = findProduct(productId);
  if(!p){ toast('Product not found', 'error'); return; }
  const selectedVariant=(p.variants||[]).find(v=>String(v.id)===String(variantId||appState.selectedVariants[productId]||''));
  if((p.variants||[]).length&&!isVariantPurchasable(selectedVariant)){toast('This option is no longer available. Choose another option.','error');return;}
  // PHYSICAL-COMMERCE ADDITION: for a physical product, collect delivery
  // details first, then re-invoke this exact same function's real body —
  // guarded by `deliveryDetails !== undefined so it can never loop or
  // fire twice, and so every DIGITAL/SERVICE product's checkout runs
  // through the untouched original path below with zero behavior change.
  if(p.productType === 'PHYSICAL' && deliveryDetails === undefined){
    openDeliveryDetailsModal(p, (deliveryDetails)=>{
      startPaystackCheckout(productId, selectedVariant&&selectedVariant.id||null, deliveryDetails);
    });
    return;
  }
  deliveryDetails = deliveryDetails || null;
  if(!confirmed){
    openCheckoutReviewModal(p,selectedVariant,deliveryDetails,()=>startPaystackCheckout(productId,selectedVariant&&selectedVariant.id||null,deliveryDetails,true));
    return;
  }
  const c = DB.content;
  // The key is derived from the payment MODE every time, so a stale or blank
  // legacy `paystackPublicKey` can never block checkout or pair the wrong
  // public key with the server's secret key.
  const activePaystackKey = (c.paymentMode==='live' ? c.paystackPublicKeyLive : c.paymentMode==='test' ? c.paystackPublicKeyTest : '') || c.paystackPublicKey || c.paystackPublicKeyLive || '';
  if(!activePaystackKey){
    // Shopper-facing message stays generic — no mention of "admin" or
    // "Paystack key" — the real reason still goes to the console/log for
    // whoever manages the store.
    console.warn('Checkout blocked: no Paystack public key set in Admin → Payments.');
    logActivity('System', 'A shopper tried to check out before payments were configured.');
    toast('Checkout is temporarily unavailable. Please check back soon.', 'error');
    return;
  }
  if(typeof PaystackPop === 'undefined'){
    toast('Something went wrong loading checkout — check your connection and try again.', 'error');
    return;
  }
  const shopper = window.__fbShopper;
  // Charge in whatever currency the shopper has selected for browsing —
  // but ONLY if this Paystack account can actually settle in it (see the
  // PAYSTACK_CHARGEABLE_CURRENCIES comment near the top of this file).
  // Anything else falls back to NGN rather than opening a popup Paystack
  // will reject, so checkout never silently fails.
  const selectedCode = currentCurrency();
  // Creator listings are charged in the listing's OWN currency at exactly the
  // creator's price (the server re-checks both); everything else is unchanged.
  const creatorInfo = p._creator || null;
  if(creatorInfo && creatorInfo.inStock === false){ toast('This item is out of stock right now.', 'error'); return; }
  if(creatorInfo && !PAYSTACK_CHARGEABLE_CURRENCIES.includes(creatorInfo.currency)){ toast('This listing cannot be paid for right now.', 'error'); return; }
  const chargeCode = creatorInfo ? creatorInfo.currency : (PAYSTACK_CHARGEABLE_CURRENCIES.includes(selectedCode)
    ? selectedCode
    : PAYSTACK_FALLBACK_CURRENCY);
  const proceedWithEmail = (email) => {
    const rate = (c.exchangeRates && c.exchangeRates[chargeCode]) || 1;
    // Paystack expects every currency's amount in its smallest subunit
    // (kobo for NGN, cents for USD, etc.) — always base amount * 100,
    // per Paystack's own "Supported currency" docs.
    const variantPrice=effectiveVariantPrice(p,selectedVariant);
    const amountMajor = creatorInfo ? creatorInfo.price : Math.round((variantPrice==null?(p.salePrice || p.price):variantPrice) * rate);
    const amountSubunit = amountMajor * 100;
    const reference = 'LN-' + Date.now() + '-' + Math.random().toString(36).slice(2,8);
    if(chargeCode !== selectedCode && !creatorInfo){
      toast(`Checkout isn't set up in ${selectedCode} yet — charging in ${chargeCode} instead.`, 'info');
    }
    // Creator-held physical stock: hold the unit on the SERVER before Paystack opens, so two buyers
    // can never both pay for the last one. The hold expires by itself if payment is abandoned.
    const needsHold = !!creatorInfo && p.productType === 'PHYSICAL';
    window.__resByRef = window.__resByRef || {};
    const handler = PaystackPop.setup({
      key: activePaystackKey,
      email,
      amount: amountSubunit,
      currency: chargeCode,
      ref: reference,
      metadata: {
        productId: p.id, productName: p.name,
        ...(selectedVariant?{variantId:selectedVariant.id,variantName:variantLabel(p,selectedVariant)}:{}),
        uid: window.__fbUid || 'guest', custom_fields: [],
        // PHYSICAL-COMMERCE ADDITION: absent/undefined for every digital
        // purchase — visible on the Paystack dashboard transaction too,
        // in addition to being stored on the order doc server-side (see
        // verify-paystack.js).
        ...(deliveryDetails ? { delivery: deliveryDetails } : {}),
      },
      callback: function(response){
        // Record this payment as "pending" the instant Paystack confirms
        // the charge — BEFORE we even try to verify it. This is what
        // makes delivery recoverable: if verification fails right now
        // (dropped connection, server hiccup, popup blocked), the
        // reference isn't lost — it's retried automatically next time the
        // app opens, or manually from Order History, instead of becoming
        // "I paid and got nothing."
        addPendingPayment(response.reference, p, email, deliveryDetails,selectedVariant&&selectedVariant.id);
        verifyPaystackPayment(response.reference, p, email, true, deliveryDetails,selectedVariant&&selectedVariant.id);
      },
      onClose: function(){
        if(needsHold){ try{ fetch(`${API_BASE}/api/creator-checkout`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'release', productId:p.id, checkoutId:reference }), keepalive:true }).catch(()=>{}); }catch(e){} }
        toast('Checkout closed — no charge was made.', 'info');
      }
    });
    // Brief "contacting payment partner" beat before the Paystack iframe
    // takes over — gives the shopper a moment of reassurance that
    // something is happening rather than the popup appearing to stall
    // or (worse) looking like nothing was tapped at all.
    showPaymentPartnerOverlay();
    const openPay = ()=>{ hidePaymentPartnerOverlay(); handler.openIframe(); };
    if(!needsHold){ setTimeout(openPay, 3000); return; }
    fetch(`${API_BASE}/api/creator-checkout`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'reserve', productId:p.id, checkoutId:reference }) })
      .then(r=>r.json())
      .then(d=>{
        if(!d || !d.ok){ hidePaymentPartnerOverlay(); toast((d && d.error && d.error.message) || 'Sorry, this item just sold out.', 'error'); return; }
        window.__resByRef[reference] = (d.data && d.data.reservation && d.data.reservation.id) || null;
        setTimeout(openPay, 1500);
      })
      .catch(()=>{ hidePaymentPartnerOverlay(); toast('Could not reserve this item. Check your connection and try again.', 'error'); });
  };
  if(shopper && shopper.email){
    proceedWithEmail(shopper.email);
  } else {
    openCheckoutEmailModal(proceedWithEmail);
  }
}

function openCheckoutReviewModal(product,variant,delivery,onContinue,external=false){
  if($('#checkoutReviewOverlay'))return;
  const overlay=document.createElement('div');overlay.id='checkoutReviewOverlay';overlay.className='modal-backdrop';overlay.setAttribute('role','presentation');
  const amount=effectiveVariantPrice(product,variant);
  const selectedName=variantLabel(product,variant);
  const deliveryCopy=external?'You will continue to the seller’s payment page to complete this order.':product.productType==='PHYSICAL'
    ? `Ships to ${escapeHtml(delivery&&delivery.country||'your delivery address')}${product.physical&&product.physical.deliveryEstimate?` · ${escapeHtml(product.physical.deliveryEstimate)}`:''}`
    : 'Digital access or download after payment verification';
  overlay.innerHTML=`<section class="modal-box checkout-review" role="dialog" aria-modal="true" aria-labelledby="checkoutReviewTitle" aria-describedby="checkoutReviewDelivery">
    <h2 id="checkoutReviewTitle">Review your selection</h2>
    <p class="text-2">${escapeHtml(product.name)}</p>
    ${selectedName?`<div class="checkout-review-variant">${escapeHtml(selectedName)}</div>`:''}
    <div class="checkout-review-price"><span>Price</span><strong>${amount===0?'Free':fmtPrice(amount)}</strong></div>
    <p id="checkoutReviewDelivery" class="text-2 small">${deliveryCopy}</p>
    <div class="checkout-review-actions"><button type="button" class="btn btn-ghost" data-review-cancel>Change selection</button><button type="button" class="btn btn-primary" data-review-continue>Continue to payment</button></div>
  </section>`;
  document.body.appendChild(overlay);
  const close=()=>overlay.remove();
  overlay.querySelector('[data-review-cancel]')?.addEventListener('click',close);
  overlay.querySelector('[data-review-continue]')?.addEventListener('click',()=>{close();onContinue();});
  overlay.addEventListener('click',event=>{if(event.target===overlay)close();});
  overlay.addEventListener('keydown',event=>{if(event.key==='Escape')close();});
  overlay.querySelector('[data-review-continue]')?.focus();
}

/* Guest checkout email capture — replaces the old window.prompt(), which
   Chrome/Android wraps in an ugly, untrustworthy-looking "This page
   says" system dialog. This is a normal in-app modal styled like the
   rest of the site, with real email validation before it lets the
   shopper proceed to payment. */
function openCheckoutEmailModal(onSubmit){
  if($('#checkoutEmailOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'checkoutEmailOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:380px;width:100%;padding:20px;">
      <h2 class="font-display" style="margin-bottom:4px;">Where should we send your receipt?</h2>
      <p class="text-2 small" style="margin-bottom:14px;">We'll email your payment receipt and download link here.</p>
      <div class="form-field"><label>Your email</label><input type="email" id="checkoutEmailInput" autocomplete="email" placeholder="you@example.com"></div>
      <p class="small text-2" id="checkoutEmailErr" style="color:var(--error);min-height:16px;"></p>
      <div class="flex gap-8">
        <button class="btn btn-primary" id="checkoutEmailBtn" style="flex:1;">Continue to Payment</button>
        <button class="btn btn-outline" onclick="closeCheckoutEmailModal()">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const input = $('#checkoutEmailInput');
  input.focus();
  const submit = ()=>{
    const email = input.value.trim();
    const errEl = $('#checkoutEmailErr');
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
      if(errEl) errEl.textContent = 'Enter a valid email address.';
      return;
    }
    closeCheckoutEmailModal();
    onSubmit(email);
  };
  $('#checkoutEmailBtn').addEventListener('click', submit);
  input.addEventListener('keydown', e=>{ if(e.key==='Enter') submit(); });
}
function closeCheckoutEmailModal(){ $('#checkoutEmailOverlay')?.remove(); }

// PHYSICAL-COMMERCE ADDITION: collects shipping details for a PHYSICAL
// product before payment — reuses the exact overlay/modal pattern
// openCheckoutEmailModal already established above, rather than
// introducing a different UI approach for what is conceptually the same
// "one more thing before Paystack opens" step. Never called for DIGITAL/
// SERVICE products (see startPaystackCheckout's gate), so it can't affect
// the existing checkout flow those use.
function openDeliveryDetailsModal(product, onSubmit){
  if($('#deliveryDetailsOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'deliveryDetailsOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:900;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto;';
  const countries = (product.physical && product.physical.shippingCountries && product.physical.shippingCountries.length)
    ? product.physical.shippingCountries : ['Nigeria'];
  overlay.innerHTML = `
    <div class="card" style="max-width:420px;width:100%;padding:20px;max-height:90vh;overflow-y:auto;">
      <h2 class="font-display" style="margin-bottom:4px;">Where should we ship this?</h2>
      <p class="text-2 small" style="margin-bottom:14px;">"${escapeHtml(product.name)}" is a physical item — we need a delivery address before payment.</p>
      <div class="form-field"><label>Full name</label><input id="dd_name" autocomplete="name" placeholder="Full name"></div>
      <div class="form-field"><label>Phone number</label><input id="dd_phone" type="tel" autocomplete="tel" placeholder="e.g. 0801 234 5678"></div>
      <div class="form-field"><label>Delivery address</label><input id="dd_address" autocomplete="street-address" placeholder="Street address"></div>
      <div class="form-field"><label>City</label><input id="dd_city" autocomplete="address-level2" placeholder="City"></div>
      <div class="form-field"><label>State</label><input id="dd_state" autocomplete="address-level1" placeholder="State/Province"></div>
      <div class="form-field"><label>Country</label>${customSelect('dd_country', countries[0], countries.map(c=>({value:c,label:c})), '', ()=>cjRefreshShippingEstimate(product))}</div>
      <p class="small text-2" id="dd_shippingEstimate" style="min-height:14px;"></p>
      <p class="small text-2" id="deliveryDetailsErr" style="color:var(--error);min-height:16px;"></p>
      <div class="flex gap-8">
        <button class="btn btn-primary" id="deliveryDetailsBtn" style="flex:1;">Continue to Payment</button>
        <button class="btn btn-outline" onclick="closeDeliveryDetailsModal()">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  $('#dd_name').focus();
  cjRefreshShippingEstimate(product);
  const submit = ()=>{
    const errEl = $('#deliveryDetailsErr');
    const name = $('#dd_name').value.trim();
    const phone = $('#dd_phone').value.trim();
    const address = $('#dd_address').value.trim();
    const city = $('#dd_city').value.trim();
    const state = $('#dd_state').value.trim();
    const country = $('#dd_country').value;
    if(!name || !phone || !address || !country){
      if(errEl) errEl.textContent = 'Name, phone, address and country are required.';
      return;
    }
    closeDeliveryDetailsModal();
    onSubmit({ name, phone, address, city, state, country });
  };
  $('#deliveryDetailsBtn').addEventListener('click', submit);
}
function closeDeliveryDetailsModal(){ $('#deliveryDetailsOverlay')?.remove(); }

// Best-effort, informational-only shipping estimate shown inside the
// delivery modal for CJ-fulfilled products (README §19). Deliberately
// silent on any failure — an unreachable/unconfigured CJ backend must
// never block or alarm a shopper mid-checkout; the authoritative shipping
// method is still whatever CJ actually ships with once cj-order.js runs
// server-side right after payment is verified.
async function cjRefreshShippingEstimate(product){
  const el = $('#dd_shippingEstimate');
  const vid = product && product.physical && product.physical.cj && product.physical.cj.variantId;
  const base = cjBackendUrl();
  if(!el || !vid || !base) { if(el) el.textContent=''; return; }
  const countryEl = $('#dd_country');
  const country = countryEl ? countryEl.value : 'Nigeria';
  const iso2 = {nigeria:'NG','united states':'US','united kingdom':'GB',ghana:'GH',kenya:'KE','south africa':'ZA'}[String(country).toLowerCase()] || 'NG';
  el.textContent = 'Checking shipping…';
  try{
    const r = await withTimeout(cjApiPost('/cj-shipping', {endCountryCode: iso2, products:[{vid, quantity:1}]}), 8000, 'timeout');
    if(r && r.ok && r.options && r.options[0]){
      const o = r.options[0];
      el.textContent = `Estimated shipping: ${o.logisticName} — $${o.logisticPrice}${o.logisticAging?' ('+o.logisticAging+')':''}`;
    } else {
      el.textContent = '';
    }
  }catch{
    el.textContent = '';
  }
}

// Same brief-beat pattern used just before the Paystack iframe opens —
// see startPaystackCheckout(). Pure reassurance UI, no logic depends on it.
function showPaymentPartnerOverlay(){
  if($('#paymentPartnerOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'paymentPartnerOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(8,11,28,.92);z-index:950;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;';
  overlay.innerHTML = `
    <div class="spinner" style="width:34px;height:34px;border:3px solid rgba(255,255,255,.15);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;"></div>
    <div class="text-2" style="font-weight:600;">Contacting payment partner…</div>`;
  document.body.appendChild(overlay);
}
function hidePaymentPartnerOverlay(){ $('#paymentPartnerOverlay')?.remove(); }

/* ---------------- PENDING PAYMENTS (client-side delivery safety net) ----
   A Paystack charge succeeding does NOT guarantee our own verify server
   was reachable, or that a popup blocker let the download tab through.
   Every reference gets parked here the instant Paystack confirms it, and
   only removed once we've actually delivered something to the shopper —
   so a dropped connection retries automatically instead of the shopper
   just losing their money's worth. */
function getPendingPayments(){ return lsGet(LS_KEYS.pendingPayments, []); }
function addPendingPayment(reference, product, email, delivery, variantId){
  const list = getPendingPayments().filter(x=>x.reference!==reference);
  // PHYSICAL-COMMERCE ADDITION: `delivery` is undefined for every existing
  // digital purchase (callers simply don't pass a 4th argument), so this
  // is a pure addition — nothing changes for the digital flow.
  list.push({ reference, productId: product.id, productName: product.name, variantId: variantId||null, email, delivery: delivery || null, at: new Date().toISOString(), attempts: 0 });
  lsSet(LS_KEYS.pendingPayments, list);
}
function removePendingPayment(reference){
  lsSet(LS_KEYS.pendingPayments, getPendingPayments().filter(x=>x.reference!==reference));
}
function bumpPendingAttempt(reference){
  const list = getPendingPayments();
  const entry = list.find(x=>x.reference===reference);
  if(entry) entry.attempts = (entry.attempts||0) + 1;
  lsSet(LS_KEYS.pendingPayments, list);
}
// Retried on every app load, and whenever the shopper taps "Retry" on a
// pending payment in Order History — silent (no toasts) unless it's a
// manual retry, so a phone that reopens the app with 3 old pendings
// doesn't fire off three toasts unprompted.
async function retryPendingPayments(silent){
  const list = getPendingPayments();
  if(!list.length) return;
  for(const entry of list){
    const product = findProduct(entry.productId);
    if(!product) { removePendingPayment(entry.reference); continue; } // product deleted since — nothing to deliver
    await verifyPaystackPayment(entry.reference, product, entry.email, !silent, entry.delivery,entry.variantId);
  }
}
/* Persistent, un-missable result — replaces relying on a toast (which
   auto-dismisses) for the single most important moment in the whole app:
   telling the shopper their file is ready and giving them a real button
   for it, not just an auto-opened tab that a popup blocker can eat
   silently. Stays open until the shopper closes it. */
// Builds a mailto: link pre-filled with everything support needs to sort
// out delivery manually — reference, product, the email the shopper paid
// with, and when — so a shopper tapping "Contact Support" from a pending
// payment never has to type any of that out themselves.
function supportMailtoFor(opts){
  const subject = `Payment support — ref ${opts.reference||'(no reference)'}`;
  const lines = [
    'Hi LEXDEN NOVA support,',
    '',
    'My payment hasn\'t been confirmed yet. Here are the details:',
    '',
    `Reference: ${opts.reference||'(none)'}`,
    opts.productName ? `Product: ${opts.productName}` : '',
    opts.email ? `Email used: ${opts.email}` : '',
    `Date/time: ${new Date().toLocaleString()}`,
    '',
    (opts.message||'').replace(/\n/g,' '),
  ].filter(Boolean);
  return `mailto:lexdendigital@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
}
function showPaymentResultModal(opts){
  $('#paymentResultOverlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'paymentResultOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:950;display:flex;align-items:center;justify-content:center;padding:20px;';
  const isSuccess = opts.status==='success';
  overlay.innerHTML = `
    <div class="card" style="max-width:400px;width:100%;padding:22px;text-align:center;position:relative;">
      <button type="button" aria-label="Close" onclick="closePaymentResultModal()" style="position:absolute;top:10px;right:10px;width:28px;height:28px;border-radius:50%;border:none;background:var(--bg-2,rgba(127,127,127,.15));color:inherit;font-size:15px;line-height:1;cursor:pointer;">✕</button>
      <div style="font-size:36px;margin-bottom:6px;">${isSuccess?'✅':'⏳'}</div>
      <h2 class="font-display" style="margin-bottom:6px;">${isSuccess?'Payment confirmed':'Payment received — confirming…'}</h2>
      <p class="text-2 small" style="margin-bottom:16px;">${escapeHtml(opts.message||'')}</p>
      ${opts.downloadLink?`<button type="button" class="btn btn-primary btn-block" style="margin-bottom:10px;" onclick="forceDownloadFile('${jsStr(opts.downloadLink)}','${jsStr(opts.filename||'')}')">⬇️ Download your file</button>`:''}
      <p class="text-2 small mono" style="margin-bottom:14px;">Ref: ${escapeHtml(opts.reference||'')}</p>
      <div class="flex gap-8">
        ${!isSuccess?`<button class="btn btn-outline" style="flex:1;" onclick="closePaymentResultModal(); retrySinglePendingPayment('${opts.reference}')">Retry now</button>`:''}
        ${!isSuccess
          ?`<a class="btn btn-outline" style="flex:1;" href="${supportMailtoFor(opts)}">Contact Support</a>`
          :`<button class="btn btn-primary btn-block" style="flex:1;" onclick="closePaymentResultModal()">Done</button>`}
      </div>
      ${!isSuccess?`<p class="text-2 small" style="margin-top:12px;">This also keeps retrying quietly in the background, and you can retry any time from Order History.</p>`:''}
    </div>`;
  document.body.appendChild(overlay);
}
function closePaymentResultModal(){ $('#paymentResultOverlay')?.remove(); }
// Generic "you need to be signed in" popup — used wherever a signed-out
// shopper attempts something that requires an account (adding a review,
// etc.), instead of letting the action fail silently or half-complete.
function showSignInPromptModal(message){
  $('#signInPromptOverlay')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'signInPromptOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:950;display:flex;align-items:center;justify-content:center;padding:20px;';
  overlay.innerHTML = `
    <div class="card" style="max-width:360px;width:100%;padding:22px;text-align:center;">
      <div style="font-size:32px;margin-bottom:8px;">🔒</div>
      <h2 class="font-display" style="margin-bottom:6px;">Sign in required</h2>
      <p class="text-2 small" style="margin-bottom:18px;">${escapeHtml(message||'Please sign in to continue.')}</p>
      <div class="flex gap-8">
        <button class="btn btn-outline" style="flex:1;" onclick="closeSignInPromptModal()">Cancel</button>
        <button class="btn btn-primary" style="flex:1;" onclick="closeSignInPromptModal(); navigate('#login')">Sign In</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
function closeSignInPromptModal(){ $('#signInPromptOverlay')?.remove(); }

/* ---------------- NEWSLETTER SIGNUP POPUP ----------------
   Shown once, 5s after the app first loads, to capture an email for the
   newsletter. Gated by localStorage so a visitor is never asked twice —
   once they either subscribe or explicitly dismiss it, ln_newsletter_seen
   is set and maybeShowNewsletterPopup() becomes a no-op on every future
   visit on this device/browser. Skipped on screens where a popup would be
   actively disruptive (auth flows, checkout, the admin portal) — it just
   waits and never fires there, it doesn't reschedule.
   Storage: Firestore "newsletterSubs" collection, keyed by (sanitized)
   email so a repeat signup overwrites instead of creating duplicates —
   same setDoc-by-natural-key approach as likedPosts/wishlists.
   NOTE: this is a new collection, so it needs a matching Firestore
   security rule added (same pattern as feedLikes/leads) before writes
   will actually succeed in production — until then this fails silently,
   same as every other best-effort cloud push in this app. */
function maybeShowNewsletterPopup(){
  if(localStorage.getItem('ln_newsletter_seen')) return;
  const hash = location.hash;
  const blockedRoutes = ['#login','#signup','#checkout','#admin'];
  if(blockedRoutes.some(r=>hash.startsWith(r))) return;
  if(appState.novaOpen) return; // don't stack on top of the chat sheet
  showNewsletterModal();
}
function showNewsletterModal(){
  if($('#newsletterOverlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'newsletterOverlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:950;display:flex;align-items:center;justify-content:center;padding:20px;';
  const prefillEmail = (window.__fbShopper && window.__fbShopper.email) || '';
  overlay.innerHTML = `
    <div class="card" style="max-width:380px;width:100%;padding:22px;position:relative;">
      <button type="button" aria-label="Close" onclick="dismissNewsletterModal()" style="position:absolute;top:10px;right:10px;width:28px;height:28px;border-radius:50%;border:none;background:var(--bg-2,rgba(127,127,127,.15));color:inherit;font-size:15px;line-height:1;cursor:pointer;">✕</button>
      <div style="font-size:32px;margin-bottom:8px;text-align:center;">📩</div>
      <h2 class="font-display" style="margin-bottom:6px;text-align:center;">Stay in the loop</h2>
      <p class="text-2 small" style="margin-bottom:16px;text-align:center;">Get new drops, deals and updates from LEXDEN NOVA straight to your inbox — no spam, unsubscribe any time.</p>
      <div class="form-field" style="margin-bottom:14px;">
        <label>Your email</label>
        <input type="email" id="newsletterEmailInput" autocomplete="email" placeholder="you@example.com" value="${escapeHtml(prefillEmail)}" onkeydown="if(event.key==='Enter') submitNewsletterSignup();">
      </div>
      <button class="btn btn-primary btn-block" id="newsletterSubmitBtn" style="margin-bottom:8px;" onclick="submitNewsletterSignup()">Subscribe</button>
      <a style="display:block;text-align:center;color:var(--text-2);font-size:12.5px;cursor:pointer;" onclick="dismissNewsletterModal()">No thanks</a>
    </div>`;
  document.body.appendChild(overlay);
  setTimeout(()=>{ $('#newsletterEmailInput')?.focus(); }, 50);
}
function closeNewsletterModal(){ $('#newsletterOverlay')?.remove(); }
function dismissNewsletterModal(){
  localStorage.setItem('ln_newsletter_seen', String(Date.now()));
  closeNewsletterModal();
}
async function submitNewsletterSignup(){
  const input = $('#newsletterEmailInput');
  const email = (input?.value||'').trim();
  if(!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){
    toast('Enter a valid email address', 'error');
    input?.focus();
    return;
  }
  const btn = $('#newsletterSubmitBtn');
  if(btn){ btn.disabled = true; btn.textContent = 'Subscribing…'; }
  // Fire the confirmation email immediately on tap, in parallel with the
  // Firestore write rather than waiting on it — the person asked for
  // this to land "immediately", and an email send shouldn't be held up
  // by (or fail because of) a slow cloud write. Fire-and-forget: a failed
  // send here shouldn't block or fail the subscribe action itself.
  sendNovaEmail('newsletter', { email }, { email }).catch(()=>{});
  // Never leave the button on "Subscribing…": give the cloud write 10s, then move on.
  const ok = await Promise.race([pushNewsletterSubToCloud(email), new Promise(r=>setTimeout(()=>r(false), 10000))]);
  localStorage.setItem('ln_newsletter_seen', String(Date.now()));
  closeNewsletterModal();
  toast(ok ? 'You\'re subscribed! 🎉' : 'Saved on this device — will sync once you\'re back online.', ok ? 'success' : 'error');
}
async function pushNewsletterSubToCloud(email){
  if(!window.__fb) return false;
  const { fbDb, doc, setDoc } = window.__fb;
  try{
    const key = email.toLowerCase().replace(/[^a-z0-9@._-]/g,'_');
    await setDoc(doc(fbDb, "newsletterSubs", key), {
      email: email.toLowerCase(),
      at: new Date().toISOString(),
      source: 'popup',
      uid: window.__fbUid || null,
    }, { merge:true });
    return true;
  }catch(e){ console.warn("Newsletter push failed", e); return false; }
}

// Brief full-screen cover shown only while a Google signInWithRedirect is
// resolving (see init()) — avoids a confusing flash of a signed-out screen
// between "app reloaded after Google" and "redirect result applied".
// window.__googleRedirectPromise is now guaranteed to settle within 10
// seconds no matter what (see the BUGFIX note on it), so this cover always
// gets removed by init()'s .then() — but it also offers its own manual
// "skip waiting" escape hatch immediately, for anyone who doesn't want to
// wait that long, and a belt-and-suspenders auto-hide slightly after that
// 10-second ceiling in case anything else ever goes wrong.
let __gsiOverlaySafetyTimer = null;
function showFinishingSignInOverlay(){
  if($('#gsiFinishingOverlay')) return;
  const el = document.createElement('div');
  el.id = 'gsiFinishingOverlay';
  el.style.cssText = 'position:fixed;inset:0;background:var(--bg);z-index:9999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:20px;text-align:center;';
  el.innerHTML = `
    <div class="gsi-spinner"></div>
    <div class="text-2 small">Finishing Google sign-in…</div>
    <a style="color:var(--accent);font-weight:600;cursor:pointer;font-size:12.5px;margin-top:6px;" onclick="dismissFinishingSignInOverlay()">Taking too long? Tap to continue</a>`;
  document.body.appendChild(el);
  __gsiOverlaySafetyTimer = setTimeout(hideFinishingSignInOverlay, 12000);
}
function hideFinishingSignInOverlay(){
  if(__gsiOverlaySafetyTimer){ clearTimeout(__gsiOverlaySafetyTimer); __gsiOverlaySafetyTimer=null; }
  $('#gsiFinishingOverlay')?.remove();
}
// Person manually bails out of the wait — clear the pending flag too so a
// stray late resolution of the redirect promise later doesn't reopen it,
// and so this attempt is never mistaken for "still pending" on a later
// visit.
function dismissFinishingSignInOverlay(){
  localStorage.removeItem('ln_gsi_pending');
  hideFinishingSignInOverlay();
  toast('Still working on it in the background — sign in again if it doesn\'t complete.', 'error');
}
async function retrySinglePendingPayment(reference){
  const entry = getPendingPayments().find(x=>x.reference===reference);
  if(!entry){ toast('Nothing to retry — this was already resolved.'); return; }
  const product = findProduct(entry.productId);
  if(!product){ toast('That product no longer exists — contact support with reference ' + reference, 'error'); return; }
  await verifyPaystackPayment(entry.reference, product, entry.email, true,entry.delivery,entry.variantId);
}

/* ---------------- RELIABLE FILE DOWNLOAD ----------------
   window.open()/a plain <a href target=_blank> only *opens* a file for
   cross-origin URLs (Cloudinary, Drive, etc.) — browsers ignore the
   `download` attribute across origins, so a paid PDF just previews in a
   new tab instead of actually saving to the device. That's the exact
   failure this exists to close: fetch the file as a blob first, then
   trigger the save from a same-origin blob: URL, which *does* force a
   real download. Only falls back to opening the link directly (old
   behavior) if the fetch itself is blocked (e.g. a host without CORS
   headers) — so delivery never just silently does nothing. */
async function forceDownloadFile(url, filename){
  if(!url) return false;
  try{
    const res = await fetch(url, { mode:'cors' });
    if(!res.ok) throw new Error('HTTP '+res.status);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename || (url.split('/').pop().split('?')[0]) || 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(()=>URL.revokeObjectURL(objectUrl), 15000);
    return true;
  }catch(e){
    console.warn('Forced download failed — falling back to opening the link directly', e);
    window.open(url, '_blank');
    return false;
  }
}
// Safe embedding of a value inside a single-quoted onclick="...('...')" string.
function jsStr(s){ return String(s==null?'':s).replace(/\\/g,'\\\\').replace(/'/g,"\\'"); }
// BUGFIX (signup/login hanging forever): a plain fetch() has no built-in
// timeout — if a request stalls on a flaky connection (very common on
// mobile) instead of failing outright, the await on it just never
// resolves or rejects. That left "Create Account" stuck showing "Creating
// account…" forever with no error, looking like the app had silently
// frozen. Wrapping any await that hits the network in withTimeout()
// guarantees it always settles one way or another within a bounded time.
function withTimeout(promise, ms, timeoutMessage){
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage || 'Request timed out — check your connection and try again.')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function downloadFilenameFor(product){
  return ((product && product.name) || 'lexden-nova-file').replace(/[^a-z0-9]+/gi,'-').toLowerCase().replace(/^-+|-+$/g,'') || 'lexden-nova-file';
}

async function verifyPaystackPayment(reference, product, email, showResult, delivery, variantId){
  const c = DB.content;
  // FIX (mega-fix batch #2): this used to hard-stop here — silently
  // skipping verification entirely — whenever the admin's "Verification
  // endpoint URL" field was blank, which is exactly what "payment
  // confirmation isn't working" was: every payment landed here and just
  // showed a "not configured" message instead of ever confirming. The
  // endpoint is now the fixed API_BASE constant, so it can't go unset.
  const verifyEndpoint = `${API_BASE}/api/verify-paystack`;
  if(showResult) toast('Confirming your payment…', 'info');
  try{
    // FIX (v2.0.1): no client-side timeout previously — an unreachable
    // endpoint (e.g. undeployed/misrouted, same root cause as the NOVA
    // "full brain" issue) could leave this hanging far longer than a
    // shopper would wait, with no feedback. 15s hard cap; the existing
    // retry queue (bumpPendingAttempt) already covers picking it back up.
    // SPEED + RELIABILITY: confirm in-line with up to 3 quick attempts
    // (1.2s apart) before falling back to the saved-and-retrying state. Most
    // "failures" right after paying are momentary: Paystack not yet marking
    // the charge successful, or a sleeping server waking up. The server is
    // idempotent, so repeating the call can never double-charge or
    // double-deliver.
    const verifyBody = JSON.stringify({
      reference, uid: window.__fbUid || null, email,
      productId: product.id, productName: product.name,
      ...(variantId?{variantId}:{}),
      ...(delivery ? { delivery } : {}),
      ...(window.__resByRef && window.__resByRef[reference] ? { reservationId: window.__resByRef[reference] } : {}),
      ...resolveAffiliateAttribution(product.id),
    });
    const RETRYABLE = /not yet successful|could not reach|retry automatically|trouble|could not find/i;
    let res = null, data = null, lastErr = null;
    for(let attempt = 1; attempt <= 3; attempt++){
      try{
        res = await withTimeout(
          fetch(verifyEndpoint, { method:'POST', headers:{'Content-Type':'application/json'}, body: verifyBody, keepalive: true }),
          attempt === 1 ? 25000 : 15000,
          'Payment verification timed out'
        );
        data = await res.json();
        lastErr = null;
        if(res.ok && data.ok) break;
        if(!(data && RETRYABLE.test(String(data.error||'')))) break; // a definitive answer (e.g. underpayment) — don't hammer
      }catch(err){
        lastErr = err; res = null; data = null;
      }
      if(attempt < 3) await new Promise(r=>setTimeout(r, 1200));
    }
    if(lastErr && !data) throw lastErr;
    if(res.ok && data.ok){
      logActivity('User', `Completed payment for ${product.name} (ref ${reference})`);
      removePendingPayment(reference);
      // deliveryLink (an admin-set URL — e.g. a Google Drive folder, a
      // Gumroad receipt page, another download host) takes priority over
      // the directly uploaded fileUrl when both are set, since it's the
      // more deliberate choice for that specific product.
      const selectedVariant=(product.variants||[]).find(v=>String(v.id)===String(variantId||''));
      const openOnDelivery = selectedVariant&&(selectedVariant.deliveryLink||selectedVariant.fileUrl) || product.deliveryLink || product.fileUrl;
      if(product._creator && product.productType !== 'PHYSICAL'){
        // Creator digital product: files / access link come from the server,
        // only after it confirms this buyer's entitlement.
        await deliverCreatorPurchase(product, reference);
      } else if(product.productType === 'PHYSICAL'){
        // Physical orders have nothing to download — a shipping-specific
        // confirmation instead of the digital "here's your file" modal.
        showPaymentResultModal({ status:'success', reference, message:'Payment confirmed! Your order will be shipped to the address you provided. You can track its status any time in Order History.' });
      } else if(product.secureDelivery){
        // One-time access link (Classroom etc.): the real URL is never in the
        // catalog; the server issues a personal link after confirming the order.
        const access = await claimSecureAccess(reference);
        showPaymentResultModal({
          status:'success', reference,
          message: access.url
            ? 'Your personal access link is ready. It works once, so open it on the device and Google account you will use for the course. Do not share it.'
            : (access.error || 'Payment confirmed. We could not create your access link just now — find it in Order History, or contact support with your order reference.'),
        });
        const ov = $('#paymentResultOverlay'), anchor = ov && ov.querySelector('p.mono');
        if(access.url && anchor){
          const a = document.createElement('a');
          a.className = 'btn btn-primary btn-block'; a.style.marginBottom = '10px';
          a.href = access.url; a.target = '_blank'; a.rel = 'noopener';
          a.textContent = '🎓 Open your course access';
          anchor.parentNode.insertBefore(a, anchor);
        }
      } else if(openOnDelivery){
        // Triple-checked delivery: fetch the file to a blob and force a
        // real save-to-device (see forceDownloadFile above) — never just
        // window.open(), which mobile browsers routinely block when it
        // fires from an async callback, and which only *previews*
        // cross-origin files anyway instead of downloading them. The
        // modal + its own Download button below is the guaranteed
        // fallback either way, so a paid shopper is never left with
        // nothing.
        const filename = downloadFilenameFor({...product,name:selectedVariant?`${product.name}-${variantLabel(product,selectedVariant)}`:product.name});
        const downloaded = await forceDownloadFile(openOnDelivery, filename);
        showPaymentResultModal({
          status:'success', reference, downloadLink: openOnDelivery, filename,
          message: downloaded
            ? 'Your file has been downloaded to this device — check your Downloads folder if you don\'t see it pop up.'
            : 'Your file is ready. If it didn\'t download automatically, use the button below.',
        });
      } else {
        showPaymentResultModal({ status:'success', reference, message:'Your order has been saved. You can find it any time in Order History.' });
      }
      if(location.hash === '#orders') render();
    } else {
      bumpPendingAttempt(reference);
      if(showResult) showPaymentResultModal({ status:'pending', reference, productName: product && product.name, email, message: (data.error || 'We couldn\'t verify this payment yet — it\'s saved and will keep retrying automatically.') });
    }
  }catch(e){
    console.warn('Payment verification failed', e);
    bumpPendingAttempt(reference);
    if(showResult) showPaymentResultModal({ status:'pending', reference, productName: product && product.name, email, message:'Could not reach the verification server — your payment is saved and this will retry automatically once you\'re back online.' });
  }
}


/* One-time access links: asks the server for a personal link for a paid order. */
async function claimSecureAccess(reference){
  try{
    const r = await authedApi('/api/secure-access', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({reference})}, 25000, 'Creating your access link timed out.');
    const d = await r.json();
    if(d && d.ok && d.data && d.data.url) return {url:d.data.url};
    return {error: d && d.error && d.error.message};
  }catch(e){ return {error: (e&&e.message)||'Could not create your access link.'}; }
}
async function openSecureAccess(reference){
  const a = await claimSecureAccess(reference);
  if(a.url) window.open(a.url,'_blank','noopener'); else showPaymentResultModal({status:'success', reference, message:a.error||'Could not create your access link.'});
}

/* ---------------- CREATOR PURCHASES: delivery + My Library ---------------- */
async function fetchCreatorDownload(productId){
  const r = await authedApi('/api/creator-product-download?productId='+encodeURIComponent(productId), {}, 25000, 'Getting your download timed out.');
  const d = await r.json();
  if(d && d.ok) return d.data;
  throw new Error((d && d.error && d.error.message) || 'Could not get your download.');
}
async function deliverCreatorPurchase(product, reference){
  try{
    // The entitlement is granted a moment after the order is saved; retry briefly.
    let data = null, lastErr = null;
    for(let i=0;i<4 && !data;i++){
      try{ data = await fetchCreatorDownload(product.id); }
      catch(e){ lastErr = e; if(!/not entitled|do not have access/i.test(String(e.message))) break; await new Promise(r=>setTimeout(r,1500)); }
    }
    if(!data) throw lastErr || new Error('not ready');
    const first = (data.links||[])[0];
    if(first){
      const ok = await forceDownloadFile(first.url, first.fileName || downloadFilenameFor(product));
      showPaymentResultModal({ status:'success', reference, downloadLink:first.url, filename:first.fileName||downloadFilenameFor(product),
        message: (ok ? 'Your file has been downloaded — check your Downloads folder.' : 'Your file is ready. If it didn\'t download automatically, use the button below.') + ' You can get it again any time from My Library in your Profile.' });
    } else if(data.externalUrl){
      showPaymentResultModal({ status:'success', reference, downloadLink:data.externalUrl, filename:'',
        message:'Payment confirmed! Your access link is ready — use the button below. You can find it again in My Library.' });
    } else {
      showPaymentResultModal({ status:'success', reference, message:'Payment confirmed! Find your purchase in My Library.' });
    }
  }catch(e){
    console.warn('creator delivery pending', e && e.message);
    showPaymentResultModal({ status:'success', reference, message:'Payment confirmed! Your purchase is being prepared — open My Library in your Profile in a minute to get it.' });
  }
}
window.__libraryCache = null; window.__libraryError = null; window.__myShipments = null;
async function fetchMyShipments(force){
  if(window.__myShipments && !force) return;
  try{
    const r = await authedApi('/api/creator-order-fulfillment', {}, 20000, 'Loading your orders timed out.');
    const d = await r.json();
    window.__myShipments = (d && d.ok) ? (d.data.fulfillments||[]) : [];
  }catch(e){ window.__myShipments = []; }
  if(location.hash === '#library') render();
}
async function confirmShipmentDelivery(orderId, btn){
  if(!confirm('Confirm that you received this order?')) return;
  if(btn){ btn.disabled = true; }
  try{
    const r = await authedApi('/api/creator-order-fulfillment', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ orderId, action:'confirm_delivery' }) }, 25000, 'Confirming timed out.');
    const d = await r.json();
    if(!d.ok) toast((d.error&&d.error.message)||'Could not confirm', 'error'); else toast('Thanks — delivery confirmed', 'success');
  }catch(e){ toast(e.message||'Could not reach the server', 'error'); }
  fetchMyShipments(true);
}
/* Delivery proof: the 6-character code is shown ONLY here, to the signed-in buyer, and only in this one response. */
async function deliveryProof(action, orderId){
  const body = { action, orderId };
  if(action==='authorise_recipient'){
    body.name = (prompt('Full name of the person who will collect this order:')||'').trim(); if(!body.name) return;
    body.phone = (prompt('Their phone number (optional):')||'').trim() || undefined;
  } else if(action==='report_problem'){
    body.reason = (prompt('What went wrong with the delivery?')||'').trim(); if(!body.reason) return;
  } else if(!confirm('Show your delivery code now? Only read it to the rider or pickup person when you have your parcel in hand.')) return;
  try{
    const r = await authedApi('/api/delivery-proof', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) }, 25000, 'The server took too long.');
    const d = await r.json();
    if(!d.ok){ toast((d.error&&d.error.message)||'Could not complete that', 'error'); return; }
    if(action==='issue_code'){
      const c = d.data && d.data.code; const mins = d.data && d.data.expiresAtMs ? Math.max(1, Math.round((d.data.expiresAtMs-Date.now())/60000)) : 10;
      alert('Your delivery code: '+c+'\n\nIt works once and expires in about '+mins+' minutes. Do not share it before you receive your parcel.');
    } else toast(action==='report_problem' ? 'Problem reported. Our team will look into it.' : 'Saved. Give that person your code only when they hand you the parcel.', 'success');
  }catch(e){ toast(e.message||'Could not reach the server', 'error'); }
}
async function fetchLibrary(force){
  if(window.__libraryCache && !force) return;
  try{
    const r = await authedApi('/api/creator-entitlements', {}, 20000, 'Loading your library timed out.');
    const d = await r.json();
    if(d && d.ok){ window.__libraryCache = d.data.entitlements||[]; window.__libraryError = null; }
    else window.__libraryError = (d && d.error && d.error.message) || 'Could not load your library.';
  }catch(e){ window.__libraryError = e.message || 'Could not reach the server.'; }
  if(location.hash === '#library') render();
}
async function openLibraryItem(productId, btn){
  if(btn){ btn.disabled = true; btn.textContent = 'Getting it…'; }
  try{
    const data = await fetchCreatorDownload(productId);
    const first = (data.links||[])[0];
    if(first){ const ok = await forceDownloadFile(first.url, first.fileName||'download'); if(!ok) window.open(first.url,'_blank','noopener'); }
    else if(data.externalUrl){ window.open(data.externalUrl,'_blank','noopener'); }
    else toast('Nothing to download for this item yet.', 'info');
  }catch(e){ toast(e.message||'Could not get your file', 'error'); }
  if(btn){ btn.disabled = false; btn.textContent = 'Download / Open'; }
}
function screenLibrary(){
  if(!window.__fbAuthResolved) return `<div class="screen"><h1 class="screen-title">My Library</h1><div class="text-2 small">Checking your account…</div></div>`;
  if(!window.__fbShopper) return `<div class="screen"><h1 class="screen-title">My Library</h1><div class="card" style="padding:18px;text-align:center;"><div style="margin-bottom:12px;">Sign in to see what you've bought from creators.</div><button class="btn btn-primary" onclick="navigate('#login')">Sign In</button></div></div>`;
  if(!window.__libraryCache && !window.__libraryError){ fetchLibrary(); return `<div class="screen"><h1 class="screen-title">My Library</h1><div class="text-2 small" style="padding:20px;text-align:center;">Loading…</div></div>`; }
  if(window.__libraryError) return `<div class="screen"><h1 class="screen-title">My Library</h1><div class="card" style="padding:16px;"><p class="text-2 small" style="color:var(--error);margin-bottom:10px;">⚠️ ${escapeHtml(window.__libraryError)}</p><button class="btn btn-outline" onclick="window.__libraryError=null;fetchLibrary(true);render();">Retry</button></div></div>`;
  const items = window.__libraryCache;
  if(!window.__myShipments) fetchMyShipments();
  const ships = window.__myShipments || [];
  const shipHtml = ships.length ? `<h2 style="font-size:16px;margin:18px 0 8px;">My physical orders</h2>` + ships.map(f=>`<div class="card" style="padding:14px;margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;gap:8px;"><strong>${escapeHtml(f.productTitle||'Order')}</strong><span class="chip" style="font-size:10px;">${escapeHtml(f.status||'')}</span></div>
      ${f.carrier||f.trackingNumber?`<div class="text-2 small" style="margin-top:6px;">${escapeHtml(f.carrier||'')} ${escapeHtml(f.trackingNumber||'')}${f.trackingUrl&&/^https?:\/\//i.test(f.trackingUrl)?` · <a href="${escapeHtml(f.trackingUrl)}" target="_blank" rel="noopener" style="color:var(--accent);">Track</a>`:''}</div>`:'<div class="text-2 small" style="margin-top:6px;">The seller is preparing your order.</div>'}
      ${f.status==='SHIPPED'?`<button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="confirmShipmentDelivery('${escapeHtml(f.id)}', this)">I received it</button>
        <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;"><button class="btn btn-outline btn-sm" onclick="deliveryProof('issue_code','${escapeHtml(f.id)}')">Get delivery code</button><button class="btn btn-outline btn-sm" onclick="deliveryProof('authorise_recipient','${escapeHtml(f.id)}')">Someone else will collect</button><button class="btn btn-outline btn-sm" onclick="deliveryProof('report_problem','${escapeHtml(f.id)}')">Problem with delivery</button></div>`:''}
      <button class="btn btn-outline btn-sm" style="margin-top:8px;" onclick="rpOpen('${escapeHtml(f.id)}','${escapeHtml(String(f.productTitle||'').replace(/'/g,''))}')">Report a problem</button>
      ${rp.orderId && rp.orderId===f.id ? rpForm() : ''}
    </div>`).join('') : '';
  return `<div class="screen"><h1 class="screen-title">My Library</h1>
    ${items.length ? items.map(i=>`<div class="card" style="padding:14px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
      <div><div style="font-weight:700;">${escapeHtml(i.productTitle||'Purchase')}</div><div class="text-2 small">Digital purchase</div></div>
      <div style="display:flex;flex-direction:column;gap:6px;"><button class="btn btn-primary btn-sm" onclick="openLibraryItem('${escapeHtml(i.productId)}', this)">Download / Open</button>${i.orderId?`<button class="btn btn-outline btn-sm" onclick="rpOpen('${escapeHtml(i.orderId)}','${escapeHtml(String(i.productTitle||'').replace(/'/g,''))}')">Report a problem</button>`:''}</div></div>${rp.orderId && rp.orderId===i.orderId ? rpForm() : ''}`).join('') : '<div class="card" style="padding:18px;text-align:center;" ><div class="text-2 small">Nothing here yet. Digital products you buy from creators will appear here.</div></div>'}
    ${shipHtml}
    ${libraryDisputesHtml()}
  </div>`;
}

/* =========================================================
   STAGE K — seller pages, creator "More" tab, buyer disputes
   All dynamic text goes through escapeHtml.
   ========================================================= */
// ---------- public seller page (#seller/<username> or #seller/id:<uid>) ----------
window.__sellerCache = window.__sellerCache || {};
function sellerHash(c){ return c && c.sellerUsername ? '#seller/'+encodeURIComponent(c.sellerUsername) : (c && c.sellerId ? '#seller/id:'+encodeURIComponent(c.sellerId) : ''); }
async function fetchSeller(key){
  const e = window.__sellerCache[key] = window.__sellerCache[key] || { loading:true };
  e.loading = true;
  try{
    const qs = key.startsWith('id:') ? 'id='+encodeURIComponent(key.slice(3)) : 'u='+encodeURIComponent(key);
    const r = await withTimeout(fetch(API_BASE+'/api/creator-seller?'+qs, {cache:'no-store'}), 15000, 'Loading this seller timed out.');
    const d = await r.json();
    if(d && d.ok){ e.data = d.data; e.error = ''; e.notFound = false; }
    else { e.notFound = r.status===404; e.error = (d && d.error && d.error.message) || 'Could not load this seller.'; }
  }catch(err){ e.error = err.message || 'Could not reach the server.'; }
  e.loading = false;
  if(location.hash.startsWith('#seller/')) render();
}
window.__sellerUpdates = window.__sellerUpdates || {};
async function fetchSellerUpdates(uid){
  if(!uid || window.__sellerUpdates[uid]) return;
  window.__sellerUpdates[uid] = { loading:true, list:[] };
  try{
    const r = await withTimeout(fetch(API_BASE+'/api/creator-updates?creatorId='+encodeURIComponent(uid), {cache:'no-store'}), 12000, 'timeout');
    const d = await r.json(); window.__sellerUpdates[uid] = { loading:false, list:(d && d.ok && d.data.updates) || [] };
  }catch(e){ window.__sellerUpdates[uid] = { loading:false, list:[] }; }
  if(location.hash.startsWith('#seller/')) render();
}
function sellerUpdatesHtml(uid){
  fetchSellerUpdates(uid);
  const u = (window.__sellerUpdates[uid]||{}).list || [];
  if(!u.length) return '';
  return `<div class="card" style="padding:14px;margin-bottom:14px;"><h3 style="font-size:14px;margin-bottom:8px;">Latest updates</h3>${u.slice(0,5).map(x=>`<div style="padding:8px 0;border-top:1px solid var(--border);"><div style="white-space:pre-wrap;">${escapeHtml(x.text)}</div><div class="text-2 small">${escapeHtml(new Date(x.createdAtMs).toLocaleDateString())}</div></div>`).join('')}</div>`;
}
function screenSeller(rawKey){
  let key = ''; try{ key = decodeURIComponent(rawKey||''); }catch(e){ key = rawKey||''; }
  const e = window.__sellerCache[key];
  const back = `<div style="margin-bottom:10px;"><button class="btn btn-outline btn-sm" onclick="history.length>1?history.back():navigate('#home')">← Back</button></div>`;
  if(!e){ fetchSeller(key); return `<div class="screen">${back}<div class="text-2 small" style="padding:20px;text-align:center;">Loading seller…</div></div>`; }
  if(e.loading && !e.data) return `<div class="screen">${back}<div class="text-2 small" style="padding:20px;text-align:center;">Loading seller…</div></div>`;
  if(e.notFound) return `<div class="screen">${back}<div class="card" style="padding:18px;text-align:center;">This seller page is not available.</div></div>`;
  if(!e.data) return `<div class="screen">${back}<div class="card" style="padding:16px;"><p class="text-2 small" style="color:var(--error);">⚠️ ${escapeHtml(e.error||'Could not load.')}</p><button class="btn btn-outline" onclick="delete window.__sellerCache['${escapeHtml(key).replace(/'/g,'')}'];render();">Retry</button></div></div>`;
  const s = e.data.seller;
  const mapped = (e.data.listings||[]).map(mapCreatorListing).filter(Boolean);
  // make sure the cards can open their detail page
  window.__creatorProducts = window.__creatorProducts || [];
  mapped.forEach(m=>{ if(!window.__creatorProducts.some(x=>x.id===m.id)) window.__creatorProducts.push(m); });
  return `<div class="screen">${back}
    <div class="card" style="padding:18px;margin-bottom:14px;text-align:center;">
      ${s.image?`<img src="${escapeHtml(s.image)}" alt="" style="width:72px;height:72px;border-radius:50%;object-fit:cover;margin-bottom:8px;">`:`<div class="avatar" style="margin:0 auto 8px;">${escapeHtml((s.displayName||'LN').slice(0,2).toUpperCase())}</div>`}
      <h1 class="screen-title" style="margin:0;">${escapeHtml(s.displayName)}${s.verified?' <span class="chip" style="font-size:10px;">verified</span>':''}</h1>
      ${s.username?`<div class="text-2 small">@${escapeHtml(s.username)}</div>`:''}
      ${s.tagline?`<div style="margin-top:6px;">${escapeHtml(s.tagline)}</div>`:''}
      ${s.bio?`<div class="text-2 small" style="margin-top:8px;white-space:pre-wrap;">${escapeHtml(s.bio)}</div>`:''}
      <div class="text-2 small" style="margin-top:8px;">${mapped.length} listing${mapped.length===1?'':'s'}</div>
    </div>
    ${sellerUpdatesHtml(s.id)}
    ${mapped.length ? `<div class="grid-products">${mapped.map(p=>productCard(p)).join('')}</div>` : '<div class="card" style="padding:18px;text-align:center;"><div class="text-2 small">No listings right now.</div></div>'}
  </div>`;
}

// ---------- buyer: report a problem + my disputes ----------
const DISPUTE_REASONS = [['NOT_AS_DESCRIBED','Not as described'],['NOT_RECEIVED','I did not receive it'],['FILE_PROBLEM','File or link problem'],['OTHER','Something else']];
let rp = { orderId:null, title:'', reason:'NOT_AS_DESCRIBED', details:'', busy:false, err:'' };
window.__myDisputes = null;
async function fetchMyDisputes(force){
  if(window.__myDisputes && !force) return;
  try{ window.__myDisputes = (await capi('/api/creator-disputes?role=buyer')).disputes || []; }
  catch(e){ window.__myDisputes = []; }
  if(location.hash === '#library') render();
}
function rpOpen(orderId, title){ rp = { orderId, title:title||'', reason:'NOT_AS_DESCRIBED', details:'', busy:false, err:'' }; render(); }
function rpCancel(){ rp.orderId = null; render(); }
function rpField(k, v){ rp[k] = v; }
async function rpSubmit(){
  if(rp.busy) return;
  rp.busy = true; rp.err = ''; render();
  try{
    await capi('/api/creator-disputes', { action:'open', orderId:rp.orderId, reason:rp.reason, details:rp.details });
    toast('Your report was sent. The seller and our team will look at it.', 'success');
    rp.orderId = null; window.__myDisputes = null; fetchMyDisputes(true);
  }catch(e){ rp.err = creatorErrText(e); }
  rp.busy = false; render();
}
function rpForm(){
  return `<div class="card" style="padding:14px;margin:0 0 10px;border:1px solid var(--warn,#d4af37);">
    <div style="font-weight:700;margin-bottom:6px;">Report a problem: ${escapeHtml(rp.title)}</div>
    <div class="text-2 small" style="margin-bottom:8px;">Use this within 14 days of buying. The seller's earning for this order is put on hold until our team decides.</div>
    <select class="input" onchange="rpField('reason',this.value)">${DISPUTE_REASONS.map(r=>`<option value="${r[0]}" ${rp.reason===r[0]?'selected':''}>${escapeHtml(r[1])}</option>`).join('')}</select>
    <textarea class="input" rows="4" maxlength="2000" placeholder="Tell us what went wrong…" style="margin-top:8px;" oninput="rpField('details',this.value)">${escapeHtml(rp.details)}</textarea>
    ${rp.err?`<div class="small" style="color:var(--error);margin-top:6px;">⚠️ ${escapeHtml(rp.err)}</div>`:''}
    <div style="display:flex;gap:8px;margin-top:8px;"><button class="btn btn-primary btn-sm" ${rp.busy?'disabled':''} onclick="rpSubmit()">${rp.busy?'Sending…':'Send report'}</button><button class="btn btn-outline btn-sm" onclick="rpCancel()">Cancel</button></div></div>`;
}
const DISPUTE_STATUS_TEXT = { OPEN:'Open', RESOLVED_REFUND:'Refund approved', RESOLVED_REJECTED:'Closed (no refund)' };
function disputeThreadHtml(d, role){
  const msgs = (d.messages||[]).map(m=>`<div style="margin:6px 0;padding:8px 10px;border-radius:10px;background:var(--surface-2,rgba(128,128,128,.12));"><div class="text-2 small" style="font-weight:700;">${escapeHtml(m.by==='buyer'?'Buyer':m.by==='creator'?'Seller':'LEXDEN NOVA team')}</div><div style="white-space:pre-wrap;font-size:14px;">${escapeHtml(m.text)}</div></div>`).join('');
  const reply = d.status==='OPEN' ? `<div style="display:flex;gap:6px;margin-top:6px;"><input id="dmsg_${escapeHtml(d.id)}" class="input" maxlength="2000" placeholder="Write a reply…" style="flex:1;"><button class="btn btn-primary btn-sm" onclick="disputeReply('${escapeHtml(d.id)}','${role}')">Send</button></div>` : '';
  return `<div class="card" style="padding:12px;margin-bottom:10px;">
    <div style="display:flex;justify-content:space-between;gap:8px;"><strong>${escapeHtml(d.productTitle||'Order')}</strong><span class="chip" style="font-size:10px;">${escapeHtml(DISPUTE_STATUS_TEXT[d.status]||d.status||'')}</span></div>
    <div class="text-2 small">${escapeHtml((DISPUTE_REASONS.find(r=>r[0]===d.reason)||[0,d.reason])[1])}</div>
    ${msgs}${d.status!=='OPEN'&&d.resolutionNote?`<div class="text-2 small" style="margin-top:6px;">Decision: ${escapeHtml(d.resolutionNote)}</div>`:''}${reply}</div>`;
}
async function disputeReply(id, role){
  const el = document.getElementById('dmsg_'+id); const text = el ? el.value.trim() : '';
  if(text.length < 2){ toast('Write a message first', 'error'); return; }
  try{
    await capi('/api/creator-disputes', { action:'message', disputeId:id, text });
    toast('Reply sent', 'success');
    if(role==='creator'){ cx.disputes = null; cxLoad(true); } else { window.__myDisputes = null; fetchMyDisputes(true); }
  }catch(e){ toast(creatorErrText(e), 'error'); }
}
function libraryDisputesHtml(){
  if(!window.__myDisputes){ fetchMyDisputes(); return ''; }
  const list = window.__myDisputes;
  return list.length ? `<h2 style="font-size:16px;margin:18px 0 8px;">My reports</h2>`+list.map(d=>disputeThreadHtml(d,'buyer')).join('') : '';
}

// ---------- creator: More tab ----------
let cx = { profile:null, policies:null, notes:null, disputes:null, loading:false, error:'', info:'', busy:false, form:null };
async function cxLoad(force){
  if(cx.loading) return;
  if(!force && cx.profile && cx.notes && cx.disputes) return;
  cx.loading = true; cx.error = '';
  try{
    const [p, n, d] = await Promise.all([ capi('/api/creator-profile'), capi('/api/creator-notifications'), capi('/api/creator-disputes?role=creator') ]);
    cx.profile = p.profile; cx.policies = p.policies; cx.notes = n; cx.disputes = d.disputes || [];
    if(!cx.form) cx.form = { username:p.profile.username||'', tagline:p.profile.tagline||'', bio:p.profile.bio||'' };
  }catch(e){ cx.error = creatorErrText(e); }
  cx.loading = false;
  if(location.hash==='#creator' && creatorTab==='store') render();
}

const LEADS_MAX_STORED = 20;
async function pushLeadToCloud(data){
  if(!window.__fb) return false;
  const { fbDb, doc, setDoc, collection, getDocs, deleteDoc } = window.__fb;
  try{
    await setDoc(doc(fbDb, "leads", Date.now().toString()), { ...data, at:new Date().toISOString() });
    // Keep only the most recent LEADS_MAX_STORED messages so the admin
    // inbox doesn't grow forever — prune anything older, best-effort.
    try{
      const snap = await getDocs(collection(fbDb, "leads"));
      const all = []; snap.forEach(d=>all.push({ id:d.id, at:d.data().at||'' }));
      all.sort((a,b)=> new Date(b.at||0) - new Date(a.at||0));
      const extra = all.slice(LEADS_MAX_STORED);
      await Promise.all(extra.map(l=>deleteDoc(doc(fbDb, "leads", l.id)).catch(()=>{})));
    }catch(pruneErr){ console.warn('Lead prune failed', pruneErr); }
    return true;
  }catch(e){ console.warn("Lead push failed", e); return false; }
}

async function trackProductClick(id){
  // Local + shared aggregate counter, same pattern as views/wishlists —
  // feeds trendingScore() below. Kept separate from the individual
  // "clicks/{timestamp}_{id}" event log underneath (admin analytics only,
  // write-only from a shopper's perspective) since that collection can't
  // be read back client-side to compute a live per-product total.
  const counts = {...DB.productClickCounts};
  counts[id] = (counts[id]||0) + 1;
  DB.productClickCounts = counts;
  pushProductClickCountToCloud(id);
  if(!window.__fb) return;
  const { fbDb, doc, setDoc } = window.__fb;
  try{
    await setDoc(doc(fbDb, "clicks", Date.now().toString()+"_"+id), { productId:id, at:new Date().toISOString() });
  }catch(e){ console.warn("Click track failed", e); }
}

function logActivity(who, what){
  const log = lsGet(LS_KEYS.activityLog, []);
  log.unshift({time:new Date().toISOString(), who, what});
  lsSet(LS_KEYS.activityLog, log.slice(0,80));
}

/* ---------------- SHOPPER MEMORY (for NOVA AI personalization) ----------------
   Everything here is derived from data the app ALREADY stores on-device
   (activity log, wishlist, cached orders, currency, theme) — no new
   collection is created, nothing is sent anywhere. This just gives NOVA
   a single, cheap-to-read "who is this person, what have they been doing"
   snapshot so its answers can reference real history instead of treating
   every message as the first one ever sent. Cached order data is
   refreshed opportunistically by fetchMyOrders() into LS_KEYS.pendingPayments'
   neighbor below; if that cache is empty NOVA simply omits order-specific
   lines rather than guessing. */
const LS_ORDER_CACHE = 'ln_orders_cache';
function cacheOrdersForNova(orders){
  try{ lsSet(LS_ORDER_CACHE, (orders||[]).slice(0,20)); }catch(e){}
}
// Derives a whole-years-old age from a "YYYY-MM-DD" date-of-birth string.
// Returns null for anything missing/unparseable/out-of-range rather than
// guessing — callers (shopperProfile, NOVA) must treat null as "unknown",
// not as age 0.
function ageFromDob(dob){
  if(!dob) return null;
  const d = new Date(dob);
  if(isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if(m < 0 || (m===0 && now.getDate() < d.getDate())) age--;
  return (age >= 0 && age < 130) ? age : null;
}
function shopperProfile(){
  const activity = lsGet(LS_KEYS.activityLog, []).filter(e=>e.who==='User');
  const wishlistIds = lsGet(LS_KEYS.wishlist, []);
  const orders = lsGet(LS_ORDER_CACHE, []);
  const products = DB.products;
  const wishlistProducts = wishlistIds.map(id=>products.find(p=>p.id===id)).filter(Boolean);
  // shopper.name/shopper.dob are collected at signup (window.__fbShopper) —
  // surfaced here so NOVA can personalize by first name and adjust tone for
  // a younger audience without every caller re-deriving this itself.
  const shopperAcct = window.__fbShopper || {};
  const firstName = (shopperAcct.name||'').trim().split(/\s+/)[0] || '';
  const age = ageFromDob(shopperAcct.dob);
  const isTeen = age!=null && age < 18;

  // Pull product names/categories mentioned in recent activity strings
  // (view/click events are logged as free text like "Viewed product X")
  // so we can infer interest even without a structured event schema.
  const viewedNames = [];
  const catCounts = {};
  activity.forEach(e=>{
    const m = /Viewed product (.+)|Clicked (.+)|Added to wishlist: (.+)|Searched "(.+)"/.exec(e.what||'');
    if(m){
      const name = m[1]||m[2]||m[3]||m[4];
      if(name) viewedNames.push(name);
    }
  });
  products.forEach(p=>{
    if(viewedNames.some(n=>n && p.name && n.toLowerCase().includes(p.name.toLowerCase().slice(0,10)))){
      catCounts[p.category] = (catCounts[p.category]||0)+1;
    }
  });
  wishlistProducts.forEach(p=>{ catCounts[p.category] = (catCounts[p.category]||0)+2; });
  const topCategory = Object.entries(catCounts).sort((a,b)=>b[1]-a[1])[0]?.[0] || null;

  const firstSeen = activity.length ? activity[activity.length-1].time : null;
  const isReturning = activity.length > 3;
  const purchasedIds = orders.map(o=>o.productId).filter(Boolean);
  const hasPurchased = purchasedIds.length > 0;

  return {
    isReturning, firstSeen, visitCount: activity.length,
    wishlistCount: wishlistProducts.length, wishlistProducts,
    topCategory, orders, hasPurchased, purchasedIds,
    lastActivity: activity.slice(0,6),
    signedIn: !!(window.__fbUid),
    currency: currentCurrency(),
    firstName, age, isTeen,
  };
}

/* ---------------- APP STATE (runtime, not persisted) ---------------- */
const appState = {
  route:'#home',
  productFilters:{ category:'all', kind:'all', price:'all', priceMin:null, priceMax:null, sort:'popular', q:'' },
  selectedVariants:{},
  priceFilterOpen:false,
  wishlistSort:'newest',
  novaOpen:false,
  adminAuthed:false,
  adminTab:'dashboard',
  theme: lsGet(LS_KEYS.theme, 'dark'),
  novaPendingOffer: null,
  // PHASE 3: PWA install/update banners — runtime-only, driven by
  // browser events (beforeinstallprompt / service worker updatefound).
  canInstall:false,
  updateAvailable:false,
  // "More feed" pagination — how many ranked posts screenFeedList() shows
  // before the shopper taps "Load more". Resets to the initial page size
  // any time the feed list screen is opened fresh.
  feedShownCount:12,
};


// ---------- pickup stations (public list + business application) ----------
// Shown only when the server has PICKUP_STATIONS_ENABLED. Buyers cannot pick a station at checkout yet.
let ps = { data:null, mine:null, loading:false, err:'', info:'', busy:false, form:{ businessType:'PHARMACY' } };
async function psLoad(){
  if(ps.loading) return; ps.loading = true;
  try{ const r = await withTimeout(fetch(API_BASE+'/api/pickup-stations', {cache:'no-store'}), 12000, 'timeout'); const d = await r.json(); ps.data = (d && d.ok) ? d.data : { enabled:false, stations:[] }; }
  catch(e){ ps.data = { enabled:false, stations:[] }; }
  try{ const r2 = await authedApi('/api/pickup-stations?mine=1', {}, 12000, 'timeout'); const d2 = await r2.json(); ps.mine = (d2 && d2.ok) ? d2.data.stations : []; }catch(e){ ps.mine = []; }
  ps.loading = false; if(location.hash==='#pickup') render();
}
async function psSubmit(){
  if(ps.busy) return; ps.busy = true; ps.err = ''; ps.info = ''; render();
  try{
    const r = await authedApi('/api/pickup-stations', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ action:'submit', details: ps.form }) }, 20000, 'Timed out.');
    const d = await r.json();
    if(d && d.ok){ ps.info = 'Sent. We will review it and tell you here.'; ps.form = { businessType:'PHARMACY' }; ps.mine = null; psLoad(); } else ps.err = (d && d.error && d.error.message) || 'Could not send.';
  }catch(e){ ps.err = e.message || 'Could not reach the server. Sign in and try again.'; }
  ps.busy = false; render();
}
function psField(k, v){ ps.form[k] = v; }
function screenPickup(){
  if(!ps.data && !ps.loading) psLoad();
  const d = ps.data;
  const back = `<div style="margin-bottom:10px;"><button class="btn btn-outline btn-sm" onclick="history.length>1?history.back():navigate('#home')">← Back</button></div>`;
  if(!d) return `<div class="screen">${back}<div class="text-2 small" style="padding:20px;text-align:center;">Loading…</div></div>`;
  if(!d.enabled) return `<div class="screen">${back}<h1 class="screen-title">Pickup stations</h1><div class="card" style="padding:18px;text-align:center;"><div class="text-2 small">Pickup stations are not open yet.</div></div></div>`;
  const F = ps.form, inp = (k,l,ph)=>`<div class="form-field"><label>${l}</label><input class="input" maxlength="200" placeholder="${ph||''}" value="${escapeHtml(F[k]||'')}" oninput="psField('${k}',this.value)"></div>`;
  const types = ['PHARMACY','SUPERMARKET','RETAIL_SHOP','LOGISTICS_AGENT','MALL_KIOSK','POST_OFFICE_AGENT','OTHER_BUSINESS'];
  return `<div class="screen">${back}<h1 class="screen-title">Pickup stations</h1>
    <p class="text-2 small">Collect a parcel from a staffed shop instead of your door. You always need your delivery code to collect.</p>
    ${d.stations.length ? d.stations.map(s=>`<div class="card" style="padding:12px;margin-bottom:8px;"><div style="font-weight:700;">${escapeHtml(s.name)}</div><div class="text-2 small">${escapeHtml(s.address)}, ${escapeHtml(s.city)}${s.state?', '+escapeHtml(s.state):''}</div><div class="text-2 small">Open: ${escapeHtml(s.openingHours)}</div></div>`).join('') : '<div class="card" style="padding:14px;text-align:center;"><div class="text-2 small">No approved stations yet.</div></div>'}
    <div class="card" style="padding:16px;margin-top:14px;"><h3 style="font-size:15px;margin-bottom:6px;">Run a shop? Become a pickup station</h3>
      <div class="text-2 small" style="margin-bottom:8px;">Sign in first. Only staffed businesses with a real premises are accepted, never homes.</div>
      ${inp('name','Business name')}${inp('address','Street address')}${inp('city','City')}${inp('state','State')}${inp('openingHours','Opening hours','Mon-Sat 9am-6pm')}${inp('managerName','Manager name')}${inp('contactPhone','Contact phone')}
      <div class="form-field"><label>Type of business</label><select class="input" onchange="psField('businessType',this.value)">${types.map(t=>`<option value="${t}" ${F.businessType===t?'selected':''}>${t.replace(/_/g,' ').toLowerCase()}</option>`).join('')}</select></div>
      ${ps.err?`<div class="small" style="color:var(--error);">⚠️ ${escapeHtml(ps.err)}</div>`:''}${ps.info?`<div class="small" style="color:#2ee6a6;">✓ ${escapeHtml(ps.info)}</div>`:''}
      <button class="btn btn-primary" ${ps.busy?'disabled':''} onclick="psSubmit()">${ps.busy?'Sending…':'Send for review'}</button>
      ${(ps.mine||[]).map(m=>`<div class="text-2 small" style="margin-top:8px;">${escapeHtml(m.name)}: <b>${escapeHtml(m.state.replace(/_/g,' ').toLowerCase())}</b>${m.reviewNote?' · '+escapeHtml(m.reviewNote):''}</div>`).join('')}
    </div></div>`;
}
