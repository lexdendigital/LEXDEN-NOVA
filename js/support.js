'use strict';
/* ---------------- PAGES (storefront / admin / creator) ----------------
   The storefront (index.html), the admin portal (admin/) and the creator
   workspace (creator/) are separate pages that share the files in js/.
   Each page sets window.__PAGE ('admin' | 'creator'; the storefront leaves it
   unset) and window.__BASE ('../' for the two sub-folders) before loading scripts. */
function pageUrl(rel, hash){
  const u = new URL((window.__BASE || '') + (rel || ''), location.href);
  u.search = ''; u.hash = hash || '';
  return u.href;
}
function goToPage(rel, hash){ location.replace(pageUrl(rel, hash)); }
// Address of the storefront itself (used for links people share).
function storeUrl(hash){ return pageUrl('index.html', hash); }


/* Detects the real platform behind a pasted URL (YouTube, TikTok, Vimeo,
   Facebook, Instagram, direct video file, or plain image) and builds an
   embeddable URL where needed, so admins can paste any normal share link
   and it just works — no manual "embed code" wrangling required. */
function parseMediaUrl(raw){
  const url = (raw||'').trim();
  if(!url) return null;
  let m = url.match(/(?:youtube\.com\/watch\?v=|youtube\.com\/shorts\/|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/live\/)([\w-]{6,})/i);
  if(m) return {type:'embed', platform:'youtube', url, embed:`https://www.youtube.com/embed/${m[1]}`};
  m = url.match(/tiktok\.com\/[^/]+\/video\/(\d+)/i);
  if(m) return {type:'embed', platform:'tiktok', url, embed:`https://www.tiktok.com/embed/v2/${m[1]}`};
  if(/tiktok\.com\//i.test(url)) return {type:'embed', platform:'tiktok', url, embed:`https://www.tiktok.com/embed/v2/${encodeURIComponent(url)}`};
  m = url.match(/vimeo\.com\/(\d+)/i);
  if(m) return {type:'embed', platform:'vimeo', url, embed:`https://player.vimeo.com/video/${m[1]}`};
  if(/facebook\.com\/.+\/videos\/|fb\.watch\//i.test(url)) return {type:'embed', platform:'facebook', url, embed:`https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(url)}&show_text=false`};
  if(/instagram\.com\/(reel|p|tv)\//i.test(url)) return {type:'embed', platform:'instagram', url, embed:`${url.replace(/\/$/,'')}/embed`};
  if(/\.(mp4|webm|mov|m4v|ogg)(\?|#|$)/i.test(url)) return {type:'video', url};
  return {type:'image', url};
}
function normalizeMedia(item){
  if(!item) return null;
  const url = (typeof item === 'object' && item.url) ? item.url : item;
  return parseMediaUrl(url);
}
function guessMediaType(url){ const m = parseMediaUrl(url); return m ? m.type : 'image'; }
/* ---------------- ERROR CODES ----------------
   Some upload failures are things only an admin can fix (a Cloudinary
   preset misconfigured, the upload server unreachable, a garbled server
   response) — showing the raw technical message for those to a shopper
   (or even to the admin, repeatedly, mid-task) reads as broken and gives
   them nothing to act on. Those get a short, stable code instead — the
   same underlying cause always maps to the same code — and the code's
   real explanation + fix live in one place: the admin portal's "Error
   Codes" tab (see adminErrorCodes()), sourced from this exact object so
   the two can never drift apart. Plain user-actionable messages (wrong
   file type, a slow connection) are left as normal English — a code
   would only make those more cryptic, not less. */
const ERROR_CODES = {
  E01: {
    title: 'Upload preset has "Async" turned on',
    cause: 'The Cloudinary upload preset in use has Async delivery enabled, so Cloudinary accepts the file but never sends back a usable file URL.',
    fix: 'Cloudinary Dashboard → Settings → Upload → Upload presets → edit the preset → turn Async OFF → Save.'
  },
  E02: {
    title: 'Upload server unreachable',
    cause: 'The app could not reach Cloudinary at all — almost always a wrong cloud name/preset in the app config, or the device is offline.',
    fix: 'Check window.__CLOUDINARY_CLOUD_NAME and __CLOUDINARY_UPLOAD_PRESET near the top of index.html, and confirm there\'s a working connection.'
  },
  E03: {
    title: 'Unexpected upload response',
    cause: 'Cloudinary responded, but not with the shape the app expects — usually an HTML error/captive-portal page, or a connection that dropped mid-upload.',
    fix: 'Check the browser console right after the failure — the raw response snippet is logged alongside this error. Retry on a stronger connection.'
  },
  E99: {
    title: 'Unknown upload error',
    cause: 'An upload failed in a way that doesn\'t match a known cause above.',
    fix: 'Check the browser console for the full technical error logged alongside this code.'
  },
};
// Builds the message shown to whoever hit the failure. Coded errors (see
// ERROR_CODES above) get a short, stable, support-friendly line; anything
// else falls back to its own plain-English message, unchanged.
function uploadErrorMessage(e){
  const code = e && e.code;
  if(code && ERROR_CODES[code]){
    return `Upload failed (${code}) — if this keeps happening, message lexdendigital@gmail.com with this code and the time: ${new Date().toLocaleString()}.`;
  }
  return 'Upload failed — ' + ((e && e.message) || 'please try again.');
}
async function cloudinaryUploadFile(file, maxSizeMB){
  maxSizeMB = maxSizeMB || 25;
  if(file.size > maxSizeMB*1024*1024){
    throw new Error(`File too large — ${maxSizeMB}MB max`);
  }
  // Work out the file's extension and Cloudinary "resource_type" ourselves,
  // and generate our own public_id, BEFORE uploading. Why: when the upload
  // preset has "Async" turned on, Cloudinary's immediate response is just
  // {status:"pending", batch_id:...} — no url, no format, and (critically)
  // no public_id unless *we* send one ourselves. Without an explicit
  // public_id, a pending response gives the browser nothing to build a
  // delivery URL from, which is why uploads used to silently fail and
  // required copying the URL from the Cloudinary dashboard by hand.
  // Sending our own public_id means we always know exactly where the file
  // will live the instant the upload is accepted, Async or not.
  const origName = (file.name || 'upload').toLowerCase();
  const dotIdx = origName.lastIndexOf('.');
  const ext = dotIdx > -1 ? origName.slice(dotIdx+1).replace(/[^a-z0-9]/g,'') : '';
  const mime = file.type || '';
  let guessedResourceType = 'raw'; // pdfs/zips/docs etc. default here
  if(mime.startsWith('image/') || ext === 'pdf') guessedResourceType = 'image'; // Cloudinary treats PDFs as "image"
  else if(mime.startsWith('video/') || mime.startsWith('audio/')) guessedResourceType = 'video';
  const rand = `web_${Date.now().toString(36)}${Math.random().toString(36).slice(2,8)}`;
  // Raw files (zip, docs, etc.) conventionally keep their extension baked
  // into the public_id itself in Cloudinary; image/video public_ids stay
  // extension-free and get ".ext" appended at delivery time instead.
  const generatedPublicId = (guessedResourceType === 'raw' && ext) ? `${rand}.${ext}` : rand;

  const formData = new FormData();
  formData.append('file', file);
  formData.append('upload_preset', window.__CLOUDINARY_UPLOAD_PRESET);
  formData.append('public_id', generatedPublicId);
  let res;
  try{
    // FIX: this previously had no timeout at all — a stalled upload on a
    // shaky mobile connection (common on Nigerian mobile data) would hang
    // this await forever with no error and no way for the caller's UI to
    // recover, which is exactly what "the site just freezes" looks like
    // from the outside. Every upload path in the app (product images,
    // profile pictures, feed posts, logos, avatars) shares this one
    // function, so this single fix covers all of them.
    res = await withTimeout(
      fetch(`https://api.cloudinary.com/v1_1/${window.__CLOUDINARY_CLOUD_NAME}/auto/upload`, {
        method: 'POST',
        body: formData
      }),
      30000,
      'Upload timed out — check your connection and try again.'
    );
  }catch(networkErr){
    // fetch() itself throws on a network/CORS failure, before there's any
    // HTTP response to read — this is what happens if CLOUDINARY_CLOUD_NAME
    // is wrong (a typo'd cloud name 404s at the DNS/CORS layer) or the
    // device is offline, and it used to look identical to every other
    // failure. Callers can now tell them apart from the message alone.
    // withTimeout()'s own rejection (a plain Error, no .code) falls into
    // this same catch and is re-thrown as-is a few lines down, so a timeout
    // still surfaces its own clear message instead of being overwritten.
    if(networkErr && networkErr.message === 'Upload timed out — check your connection and try again.') throw networkErr;
    const err = new Error('Could not reach Cloudinary — check the cloud name/preset or your connection.');
    err.code = 'E02';
    throw err;
  }
  // Read the body ONCE as text first — res.json() consumes the stream, so
  // if it fails we'd otherwise have no way to see what actually came back.
  // Parsing text->JSON ourselves means a non-JSON response (HTML error
  // page, captive-portal page, a mobile carrier's data-compression proxy
  // rewriting the body, etc.) is visible instead of silently becoming
  // "no data" and falling into a vague error.
  let rawText = '';
  try{ rawText = await res.text(); }catch(readErr){ /* body unreadable — rawText stays '' */ }
  let data = null;
  try{ data = rawText ? JSON.parse(rawText) : null; }catch(parseErr){ /* not JSON — data stays null, rawText still has it */ }
  // A preset with "Async: true" makes Cloudinary return immediately with
  // {status:"pending", batch_id:...} instead of the finished file's
  // secure_url — the request succeeds (HTTP 200) but there's no URL in the
  // response. The base file is already stored and deliverable the instant
  // this response lands though ("Async" only defers *eager*/pre-generated
  // transformations, never the original asset) — so build the delivery URL
  // ourselves from the public_id, resource_type and extension we already
  // worked out before uploading, instead of treating this as a failure.
  if(res.ok && data && !data.secure_url && (data.status==='pending' || data.batch_id)){
    console.warn('Cloudinary preset has Async enabled — building delivery URL from the public_id generated client-side.');
    const rt = data.resource_type || guessedResourceType;
    const dtype = data.type || 'upload';
    const ver = data.version ? `v${data.version}/` : '';
    const extSuffix = (rt !== 'raw' && ext) ? `.${ext}` : '';
    data.secure_url = `https://res.cloudinary.com/${window.__CLOUDINARY_CLOUD_NAME}/${rt}/${dtype}/${ver}${generatedPublicId}${extSuffix}`;
  }
  if(!res.ok || !data || !data.secure_url){
    if(data && data.error && data.error.message){
      const err = new Error(data.error.message);
      err.code = 'E03';
      throw err;
    }
    // No usable error.message — this means the response was HTTP-ok-ish
    // but not the JSON shape Cloudinary normally sends. Log a snippet of
    // the actual body instead of a bare status code, since THIS is what
    // tells you whether it's an HTML page (network/proxy/captive-portal
    // interference), a truncated response (connection dropped mid-upload
    // on a weak connection), or something else entirely.
    const snippet = rawText ? rawText.replace(/\s+/g,' ').trim().slice(0,120) : '(empty response body)';
    console.warn(`Upload failed (HTTP ${res.status}) — server said: ${snippet}`);
    const err = new Error(`Upload failed (HTTP ${res.status}) — server said: ${snippet}`);
    err.code = 'E03';
    throw err;
  }
  return data.secure_url;
}

/* Admin media upload — lets the admin attach a file straight from their
   device instead of only pasting a URL. Uploads to Cloudinary (unsigned
   upload preset), then fills the matching URL field with the returned
   secure_url so everything downstream (gallery rendering, saveProduct,
   etc.) works exactly as it already did for pasted links. `prefix` is the
   shared id stem for a given media slot group — 'f_media' for the product
   form, 'fp_media' for feed posts — so this one function drives both:
   the URL input is #{prefix}{slotIndex} and its status text is
   #{prefix}FileStatus{slotIndex}. */
async function uploadMediaFile(prefix, slotIndex, inputEl){
  const file = inputEl.files && inputEl.files[0];
  if(!file) return;
  const statusEl = $('#'+prefix+'FileStatus'+slotIndex);
  if(statusEl) statusEl.textContent = 'Uploading…';
  try{
    const url = await cloudinaryUploadFile(file);
    const urlInput = $('#'+prefix+slotIndex);
    if(urlInput) urlInput.value = url;
    if(statusEl) statusEl.textContent = '✅ Uploaded';
    toast('File uploaded', 'success');
  }catch(e){
    console.warn('Media upload failed', e);
    if(statusEl) statusEl.textContent = e.code ? `❌ Upload failed (${e.code})` : '❌ '+e.message;
    toast(uploadErrorMessage(e), 'error');
    inputEl.value = '';
  }
}
function productMedia(p){
  return (p.gallery||[]).map(normalizeMedia).filter(Boolean).slice(0,8);
}
// Domain that generates a real per-item Open Graph preview (title,
// description, image) for shared links. GitHub Pages serves one static
// index.html to every URL, so a crawler hitting a raw #product/123 or
// #feed/123 hash link only ever sees the site's generic default tags —
// the hash isn't even sent to the server. Sharing through this domain's
// /product/:id and /feed/:id routes instead lets a serverless function
// look the item up and answer with its actual title/image before
// redirecting a real visitor's browser straight into the app.
// FIX: this used to point at a separate, standalone Vercel project
// (lexden-nova-links) that pre-rendered social-share meta tags. That
// functionality has since been folded into the same Render backend as
// everything else — server.js already serves /product/:id and /feed/:id
// itself (see its own comment: "Mirrors vercel.json's rewrites"). Pointing
// this at the old standalone Vercel URL meant every shared product/feed
// link, and the entire sitemap.xml, was sending people to a second,
// separate deployment instead of the one this app actually maintains —
// fixed by pointing it at the real backend.
const NOVA_LINKS_BASE = 'https://lexden-nova.onrender.com';
// FIX (mega-fix batch #2): single canonical backend URL, used by every
// feature that needs one (NOVA AI assistant, payment verification, CJ
// dropshipping). Before this, the admin had to separately paste this
// SAME URL into 3 different settings fields (each defaulting to blank,
// each a leftover from when they were 3 separate Vercel deployments) —
// if any one of them was ever left blank or went stale, that ONE
// feature silently stopped working while everything else kept running,
// which is exactly what "payment confirmation/Gemini assistant not
// working" turned out to be. There's now one source of truth; the old
// per-feature input boxes are gone from the admin UI (see below).
const API_BASE = NOVA_LINKS_BASE;
// A feed post can now be tagged to MULTIPLE products (admin can select
// several when creating/editing a post). Reads the new productIds array
// when present, and falls back to the old single productId field for any
// post saved before this change — so existing feed posts already in
// Firestore keep working without a data migration.
function feedPostProductIds(post){
  if(!post) return [];
  if(Array.isArray(post.productIds) && post.productIds.length) return post.productIds;
  return post.productId ? [post.productId] : [];
}

/* =========================================================
   LEXDEN NOVA CREATOR — Stage B (user-facing application flow)
   Talks to the Stage A backend: /api/creator-application,
   /api/creator-documents. Same async-cache + re-render pattern as the
   affiliate program (window.__affiliatesCache, fetchAffiliatesFromCloud)
   — see window.__creatorAppCache below.
   ========================================================= */
window.__creatorAppCache = null;
window.__creatorAppError = null;
// Authenticated call to our backend with automatic recovery: the Render
// server may be waking up (cold start) and Firebase tokens can be stale.
// On 401/502/503/504 or a network failure we warm the server, force a fresh
// ID token and retry once, so shoppers never see a bogus "session expired".
async function authedApi(path, init, timeoutMs, timeoutMsg){
  const user = fbAuth.currentUser;
  if(!user) throw Object.assign(new Error('Please sign in first.'), {code:'NO_USER'});
  let lastErr = null;
  for(let attempt=0; attempt<2; attempt++){
    try{
      const token = await user.getIdToken(attempt>0);
      const headers = Object.assign({}, (init&&init.headers)||{}, {'Authorization':'Bearer '+token});
      const r = await withTimeout(fetch(API_BASE+path, Object.assign({}, init, {headers})), attempt? Math.max(timeoutMs,30000) : timeoutMs, timeoutMsg||'The server took too long to respond.');
      if(attempt===0 && [401,502,503,504].includes(r.status)){
        try{ if(typeof warmBackend==='function') warmBackend(); }catch(_){}
        lastErr = new Error('retry'); continue;
      }
      return r;
    }catch(e){
      lastErr = e;
      if(attempt===0){ try{ if(typeof warmBackend==='function') warmBackend(); }catch(_){} continue; }
    }
  }
  throw lastErr || new Error('Could not reach the server.');
}

async function fetchCreatorApplication(force){
  if(window.__creatorAppCache && !force) return window.__creatorAppCache;
  const user = fbAuth.currentUser;
  if(!user){ window.__creatorAppError = 'Not signed in.'; return null; }
  try{
    const r = await authedApi('/api/creator-application', {}, 20000, 'Loading your application timed out.');
    const d = await r.json();
    if(d && d.ok){ window.__creatorAppCache = d.data; window.__creatorAppError = null; return d.data; }
    window.__creatorAppError = (d && d.error && d.error.message) || 'Could not load your application.';
    return null;
  }catch(e){
    window.__creatorAppError = e.message || 'Could not reach the server.';
    return null;
  }
}
/* =========================================================
   CREATOR WORKSPACE — Products / Orders / Money tabs
   Every call goes through capi() -> authedApi() (retry + fresh token).
   All dynamic text is escaped with escapeHtml.
   ========================================================= */
let creatorTab = 'home';
async function capi(path, body, timeoutMs){
  const init = body ? { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) } : {};
  const r = await authedApi(path, init, timeoutMs||25000, 'The server took too long. Please try again.');
  let d = null; try{ d = await r.json(); }catch(e){}
  if(d && d.ok) return d.data;
  const err = new Error((d && d.error && (d.error.message || d.error)) || 'Something went wrong.');
  err.errors = (d && d.error && d.error.errors) || []; err.code = d && d.error && d.error.code;
  throw err;
}
function creatorErrText(e){
  const list = (e && e.errors || []).map(x=>x.message).filter(Boolean);
  return list.length ? list.join(' · ') : (e && e.message) || 'Something went wrong.';
}
const cwNaira = v => '₦' + Number(v||0).toLocaleString(undefined,{maximumFractionDigits:2});
// ---- Generic custom dropdown ----
// Replaces every remaining native <select> in the app (sort pills, admin
// form pickers, currency, rating, etc) with the same in-page .csel widget
// the sign-up wizard already uses below, so no OS/browser picker sheet
// ever opens anywhere in the app — every dropdown is styled, positioned,
// and themed the same way as the rest of the UI.
//
// A rendered instance registers its optional onPick side-effect (a real
// JS function reference, not a re-serialized string) in cselRegistry,
// keyed by id. Picking an option updates that element's DOM directly
// (button label + active option) rather than triggering a full render(),
// so a dropdown sitting inside an otherwise-uncontrolled form (e.g. the
// admin product editor) doesn't wipe out whatever the admin has already
// typed into the other fields — that matches exactly how the native
// <select onchange> it replaces used to behave. A same-id hidden <input>
// keeps the value available to every existing `$('#id').value` read site
// (form submit handlers) with zero changes needed there.
// Pass sm:true for the compact pill-sized variant (sort/currency pickers
// that sit beside other pill buttons) instead of the full-width form one.
const cselRegistry = {};
function customSelect(id, value, options, placeholder, onPick, sm){
  const norm = options.map(o=>typeof o==='string'?{value:o,label:o}:o);
  cselRegistry[id] = { onPick: onPick||null };
  const sel = norm.find(o=>String(o.value)===String(value));
  return `
  <input type="hidden" id="${id}" value="${escapeHtml(value==null?'':value)}">
  <div class="csel ${sm?'csel-sm':''}" id="csel_${id}">
    <button type="button" class="csel-btn ${sel?'':'placeholder'}" onclick="event.stopPropagation();toggleCustomSelect('${id}')">
      <span>${escapeHtml(sel?sel.label:(placeholder||''))}</span><span class="csel-arrow">▾</span>
    </button>
    <div class="csel-panel">
      ${norm.map(o=>`<div class="csel-opt ${String(o.value)===String(value)?'active':''}" onclick="pickCustomSelect('${id}','${jsStr(o.value)}',this)">${escapeHtml(o.label)}</div>`).join('')}
    </div>
  </div>`;
}
function closeAllCustomSelects(){
  $all('.csel.open').forEach(o=>o.classList.remove('open'));
  $all('.csel-host').forEach(h=>h.classList.remove('csel-host'));
}
function toggleCustomSelect(id){
  const el = $('#csel_'+id);
  if(!el) return;
  const wasOpen = el.classList.contains('open');
  closeAllCustomSelects();
  if(wasOpen) return;
  // Let the list escape the rounded card around it, open upward when there is no room below,
  // and align to the right edge when it would run off the screen.
  const host = el.closest('.card,.section'); if(host) host.classList.add('csel-host');
  el.classList.remove('up','right'); el.classList.add('open');
  const panel = el.querySelector('.csel-panel'); const r = el.getBoundingClientRect();
  const ph = Math.min(panel.scrollHeight, 260), pw = Math.max(panel.offsetWidth, 150);
  const below = window.innerHeight - r.bottom, above = r.top;
  if(below < ph + 12 && above > below) el.classList.add('up');
  if(r.left + pw > window.innerWidth - 8) el.classList.add('right');
  const act = panel.querySelector('.csel-opt.active'); if(act) panel.scrollTop = Math.max(0, act.offsetTop - 40);
}
function pickCustomSelect(id, value, optEl){
  const hidden = $('#'+id);
  if(hidden) hidden.value = value;
  const wrap = $('#csel_'+id);
  if(wrap){
    const labelEl = wrap.querySelector('.csel-btn span');
    if(labelEl && optEl) labelEl.textContent = optEl.textContent;
    const btnEl = wrap.querySelector('.csel-btn');
    if(btnEl) btnEl.classList.remove('placeholder');
    wrap.querySelectorAll('.csel-opt').forEach(o=>o.classList.remove('active'));
    if(optEl) optEl.classList.add('active');
    closeAllCustomSelects();
  }
  const entry = cselRegistry[id];
  if(entry && entry.onPick) entry.onPick(value);
}
// Writes a small trigger document that a Cloud Function watches (see
// functions/index.js) to fan the notification out to every device that
// has enabled notifications — a phone can't push to OTHER phones on its
// own, so this is the one piece that genuinely needs a server-side
// component, not just client code.
async function notifyNewFeedPost(post){
  if(!window.__fb) return;
  const { fbDb, doc, setDoc } = window.__fb;
  try{
    await setDoc(doc(fbDb, "feedNotify", post.id), {
      postId: post.id, title: post.title, body: (post.body||'').slice(0,140),
      coverUrl: post.coverUrl||'', at: new Date().toISOString(),
    });
  }catch(e){ console.warn('Notify trigger failed', e); }
}

// ============================================================
// CJ DROPSHIPPING — Admin panel (README §33). Everything here talks to
// the Vercel backend's /api/cj-*.js routes (never to CJ directly — the
// browser never sees a CJ token, see cj-shared.js). Settings persist the
// same way NOVA AI Setup / Payments do: into DB.content via
// pushSettingsToCloud(). Sync Logs read Firestore's cjSyncLogs collection
// directly with the signed-in admin's own Firebase Auth session — the
// same read pattern adminLeads()/adminUsers() already use elsewhere in
// this file — since firestore.rules makes that collection admin-read-only
// anyway (see the updated firestore.rules).
// ============================================================
function cjBackendUrl(){
  // FIX (mega-fix batch #2): used to read an admin-editable "CJ backend
  // API base URL" field that defaulted to blank — every CJ call below
  // failed with "Set the CJ backend API base URL below first" until the
  // admin manually pasted in the one URL that's always correct anyway.
  return `${API_BASE}/api`;
}
async function cjApiPost(path, body){
  const base = cjBackendUrl();
  if(!base) return {ok:false, error:'Set the CJ backend API base URL below first.'};
  try{
    const r = await withTimeout(fetch(base+path, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body||{})}), 20000, 'CJ backend did not respond in time.');
    return await r.json();
  }catch(e){
    return {ok:false, error:e.message||'Could not reach the CJ backend.'};
  }
}

/* ---------------- shared data helpers (feed/product counters, media, text) ---------------- */

/* Shared Cloudinary unsigned-upload helper. Every "upload from device"
   button in the app (product gallery, feed post media, branding logo,
   signup avatar) funnels through this one function, so there's a single
   implementation to maintain and — importantly — a single place that
   surfaces Cloudinary's OWN error message back to whoever's uploading,
   instead of a generic "upload failed" that hides the real reason
   (wrong preset name, preset still signed, unsupported file type, etc).
   Throws an Error with a human-readable message on any failure. */
/* Media speed fix: every upload was being displayed at its full original
   size — a multi-megabyte photo or video downloaded in full just to show
   a small thumbnail. Cloudinary can resize/compress on the fly via its
   URL, so this rewrites any Cloudinary-hosted URL to request the best
   format for the viewer's browser (f_auto), the best quality for that
   format (q_auto), and a sensible max width — which is the single
   biggest lever for "media taking too long to load". Pasted external
   links (not hosted on Cloudinary) are returned unchanged. */
function cldOptimize(url, width){
  if(!url || typeof url !== 'string') return url;
  const marker = '/upload/';
  const idx = url.indexOf(marker);
  if(!url.includes('res.cloudinary.com') || idx===-1) return url;
  if(/\/upload\/[^/]*f_auto/.test(url)) return url; // already optimized
  const w = width ? `,w_${width}` : '';
  return url.slice(0, idx+marker.length) + `f_auto,q_auto${w}/` + url.slice(idx+marker.length);
}
/* Renders one media item — image, direct video, or a platform embed
   (YouTube/TikTok/Vimeo/Facebook/Instagram) — used for the main viewer
   and when a thumbnail is tapped. `big` = full player controls/autoplay. */
function mediaHtml(m, big){
  if(!m) return '';
  if(m.type==='embed') return `<div style="position:relative;width:100%;height:100%;background:#000;"><iframe src="${m.embed}" style="width:100%;height:100%;border:0;" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy" referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
  if(m.type==='video') return `<video src="${cldOptimize(m.url, 960)}" preload="metadata" ${big?'controls':'muted'} playsinline${big?' autoplay':''}></video>`;
  return `<img src="${cldOptimize(m.url, big?960:400)}" alt="" loading="lazy">`;
}
// First real paragraph of a feed post's body, trimmed to a reasonable
// share-message length — long-form posts shouldn't dump their entire body
// into a WhatsApp message.
function firstParagraph(text, maxLen){
  maxLen = maxLen || 220;
  const para = (text||'').split(/\n\s*\n/).map(s=>s.trim()).find(Boolean) || (text||'').trim();
  return para.length > maxLen ? para.slice(0, maxLen-1).trim()+'…' : para;
}
// Own Firestore collections, kept separate from the admin-only catalog/*
// docs — the same reasoning as /reviews: any shopper needs to be able to
// write here, not just the admin, so it can't live inside catalog/settings.
// "likedPosts/{uid}" mirrors "wishlists/{uid}" exactly (per-shopper doc,
// owner-writable). "feedLikes/{postId}" holds the shared running count,
// updated with increment() so concurrent likes from different shoppers
// can't clobber each other. Both fail silently (console.warn only) if the
// matching security rule hasn't been added yet, exactly like pushWishlistToCloud —
// a like button not syncing to the cloud yet should never break the UI.
async function pushLikedPostsToCloud(){
  if(!window.__fb || !window.__fbUid) return;
  const { fbDb, doc, setDoc } = window.__fb;
  try{
    await setDoc(doc(fbDb, "likedPosts", window.__fbUid), { ids: DB.likedPosts });
  }catch(e){ console.warn("Liked-posts push failed", e); /* non-critical, no toast */ }
}
// FIX (v2.0.2 — "likes disappearing"): the old updateDoc()+setDoc-fallback
// pattern assumed ANY updateDoc failure meant "doc doesn't exist yet" and
// reacted by overwriting the whole document with just this one delta — but
// updateDoc can also fail on a transient network blip, a dropped connection,
// or any other transient Firestore error while the doc very much still
// exists with its real accumulated count. When that happened, the fallback
// silently replaced the whole document with just the current click's delta
// (clamped to 0 if negative), wiping out every previous like. A single
// setDoc(..., {merge:true}) with increment() does the same "create if
// missing, increment if present" job atomically in one call, with no
// failure path that can ever nuke existing counts.
async function pushFeedLikeCountToCloud(postId, delta){
  if(!window.__fb) return;
  const { fbDb, doc, setDoc, increment } = window.__fb;
  try{
    await setDoc(doc(fbDb, "feedLikes", postId), { count: increment(delta) }, { merge: true });
  }catch(e){ console.warn("Feed-like count push failed", e); /* non-critical, no toast */ }
}
async function pullFeedLikesFromCloud(){
  if(!window.__fb) return;
  const { fbDb, collection, getDocs, doc, getDoc } = window.__fb;
  try{
    const snap = await getDocs(collection(fbDb, "feedLikes"));
    const counts = {};
    snap.forEach(d=>{ counts[d.id] = (d.data()||{}).count || 0; });
    DB.feedLikeCounts = counts;
  }catch(e){ console.warn("Feed-like counts pull failed", e); }
  if(window.__fbUid){
    try{
      const likedSnap = await getDoc(doc(fbDb, "likedPosts", window.__fbUid));
      const cloudIds = likedSnap.exists() ? (likedSnap.data().ids||[]) : [];
      // Same merge-not-overwrite approach as the wishlist pull — anything
      // liked on this device as a guest right before signing in survives.
      const merged = Array.from(new Set([...(DB.likedPosts||[]), ...cloudIds]));
      DB.likedPosts = merged;
      if(merged.length !== cloudIds.length) pushLikedPostsToCloud();
    }catch(e){ console.warn("Liked-posts pull failed", e); }
  }
}
// "feedViews/{postId}" — same shared-counter pattern as feedLikes/productViews.
// Called once per genuine navigation to a feed post (see render()), giving
// feedHotScore a real "people are opening this" signal independent of likes,
// so a post that's being read a lot but not yet liked isn't invisible to
// ranking or to relatedFeedPosts()'s popularity tiebreak.
async function trackFeedView(id){
  const post = DB.feed.find(p=>p.id===id);
  if(!post) return;
  const counts = {...DB.feedViewCounts};
  counts[id] = (counts[id]||0) + 1;
  DB.feedViewCounts = counts;
  if(!window.__fb) return;
  // Same overwrite-on-any-failure fix as pushFeedLikeCountToCloud — see the
  // comment there for why the old updateDoc()+setDoc-fallback pattern could
  // silently reset an existing count instead of only creating a missing doc.
  const { fbDb, doc, setDoc, increment } = window.__fb;
  try{ await setDoc(doc(fbDb, "feedViews", id), { count: increment(1) }, { merge: true }); }
  catch(e){ console.warn("Feed view push failed", e); }
}
async function pullFeedViewCountsFromCloud(){
  if(!window.__fb) return;
  const { fbDb, collection, getDocs } = window.__fb;
  try{
    const snap = await getDocs(collection(fbDb, "feedViews"));
    const counts = {};
    snap.forEach(d=>{ counts[d.id] = (d.data()||{}).count || 0; });
    DB.feedViewCounts = counts;
  }catch(e){ console.warn("Feed view counts pull failed", e); }
}
async function pushProductWishlistCountToCloud(id, delta){
  if(!window.__fb) return;
  const { fbDb, doc, setDoc, increment } = window.__fb;
  try{ await setDoc(doc(fbDb, "productWishlists", id), { count: increment(delta) }, { merge: true }); }
  catch(e){ console.warn("Product wishlist-count push failed", e); }
}
async function pushProductClickCountToCloud(id){
  if(!window.__fb) return;
  const { fbDb, doc, setDoc, increment } = window.__fb;
  try{ await setDoc(doc(fbDb, "productClicks", id), { count: increment(1) }, { merge: true }); }
  catch(e){ console.warn("Product click-count push failed", e); }
}
async function pullProductInterestFromCloud(){
  if(!window.__fb) return;
  const { fbDb, collection, getDocs } = window.__fb;
  try{
    const snap = await getDocs(collection(fbDb, "productViews"));
    const counts = {};
    snap.forEach(d=>{ counts[d.id] = (d.data()||{}).count || 0; });
    DB.productViewCounts = counts;
  }catch(e){ console.warn("Product view counts pull failed", e); }
  try{
    const snap2 = await getDocs(collection(fbDb, "productWishlists"));
    const counts2 = {};
    snap2.forEach(d=>{ counts2[d.id] = (d.data()||{}).count || 0; });
    DB.productWishlistCounts = counts2;
  }catch(e){ console.warn("Product wishlist counts pull failed", e); }
  try{
    const snap3 = await getDocs(collection(fbDb, "productClicks"));
    const counts3 = {};
    snap3.forEach(d=>{ counts3[d.id] = (d.data()||{}).count || 0; });
    DB.productClickCounts = counts3;
  }catch(e){ console.warn("Product click counts pull failed", e); }
  try{
    const snap4 = await getDocs(collection(fbDb, "productShares"));
    const counts4 = {};
    snap4.forEach(d=>{ counts4[d.id] = (d.data()||{}).count || 0; });
    DB.productShareCounts = counts4;
  }catch(e){ console.warn("Product share counts pull failed", e); }
  try{
    const snap5 = await getDocs(collection(fbDb, "feedShares"));
    const counts5 = {};
    snap5.forEach(d=>{ counts5[d.id] = (d.data()||{}).count || 0; });
    DB.feedShareCounts = counts5;
  }catch(e){ console.warn("Feed share counts pull failed", e); }
}
// Sums the like-counts of every feed post that links to this product
// (post.productIds — see feedPostProductIds), using data the feed already
// tracks in DB.feedLikeCounts.
function feedLikesForProduct(id){
  return DB.feed.filter(post=>feedPostProductIds(post).includes(id)).reduce((sum,post)=>sum+(DB.feedLikeCounts[post.id]||0), 0);
}
// The actual "dynamic trending" score: real cross-shopper signals only
// (views + wishlist adds + feed likes on linked posts + clicks + shares),
// weighted toward higher-intent actions since a wishlist add, a share, or
// a like says a lot more than a page view. Products with zero signal
// simply score 0 — no fabricated numbers.
function trendingScore(p){
  const views = DB.productViewCounts[p.id]||0;
  const wishlists = DB.productWishlistCounts[p.id]||0;
  const likes = feedLikesForProduct(p.id);
  const clicks = DB.productClickCounts[p.id]||0;
  const shares = DB.productShareCounts[p.id]||0;
  // Weights: a share is the single strongest signal (someone chose to put
  // their own name behind recommending it to someone else) → 4. A wishlist
  // add is a close second (real purchase intent) → 3. A click-through from
  // a card is a genuine "I wanted to know more" → 2, same tier as a feed
  // like. A view is the weakest, lowest-intent signal → 1.
  return views*1 + wishlists*3 + likes*2 + clicks*2 + shares*4;
}
// Returns the live-computed trending list. Ranks by real signal first;
// once enough products have accumulated activity to fill the list this
// entirely replaces the old static trending:true admin flag. Until then
// (cold start / a fresh install with no traffic yet), it backfills with
// admin-flagged trending products, then top-rated, so the section is never
// empty or arbitrary while data is still accumulating.
function computeTrendingProducts(products, limit){
  limit = limit || 6;
  const scored = products.map(p=>({p, score:trendingScore(p)})).filter(x=>x.score>0);
  scored.sort((a,b)=>b.score-a.score);
  const result = scored.map(x=>x.p);
  if(result.length < limit){
    const have = new Set(result.map(p=>p.id));
    const backfill = products.filter(p=>p.trending && !have.has(p.id));
    backfill.forEach(p=>{ if(result.length<limit){ result.push(p); have.add(p.id); } });
  }
  if(result.length < limit){
    const have = new Set(result.map(p=>p.id));
    products.slice().sort((a,b)=>b.rating-a.rating).forEach(p=>{ if(result.length<limit && !have.has(p.id)){ result.push(p); have.add(p.id); } });
  }
  return result.slice(0,limit);
}
// "Featured for You" — personalizes the admin's featured:true picks using
// shopperProfile()'s inferred topCategory/wishlist interest, so a returning
// shopper sees featured items relevant to them first instead of the same
// fixed list every visitor gets. Falls back to the plain admin-featured
// order for a first-time visitor with no inferred interest yet — this never
// shows something un-featured, it only re-sorts what the admin already chose.
function computeFeaturedForYou(products, sp, limit){
  limit = limit || 8;
  const featured = products.filter(p=>p.featured);
  if(!sp || !sp.topCategory) return featured.slice(0,limit);
  const inCategory = featured.filter(p=>p.category===sp.topCategory);
  const rest = featured.filter(p=>p.category!==sp.topCategory);
  return [...inCategory, ...rest].slice(0,limit);
}

// FEED RANKING — a real "hot" score instead of showing posts in raw
// creation order forever. Same idea as Hacker News/Reddit "hot" ranking:
// engagement (likes) matters, but decays with age so a well-liked post
// from months ago doesn't permanently bury everything newer. A brand-new
// post with zero likes yet still starts with a small positive score (the
// "+1" below) so it's never literally invisible before its first like.
const FEED_RANK_GRAVITY = 1.6; // higher = faster decay, favors recency more
function feedHotScore(post){
  const likes = DB.feedLikeCounts[post.id] || 0;
  // Views (see trackFeedView) are a weaker signal than a like — someone
  // opening a post is lower-intent than choosing to like it — but a post
  // getting read heavily with no likes yet was previously invisible to
  // ranking entirely. Weighting it at 1/3 a like lets real read-traffic
  // move a fresh post up before it earns its first like. A share is the
  // strongest signal here too — weighted above a like, same reasoning as
  // trendingScore above.
  const views = DB.feedViewCounts[post.id] || 0;
  const shares = DB.feedShareCounts[post.id] || 0;
  const ageHours = Math.max(0, (Date.now() - new Date(post.date||0).getTime()) / 36e5);
  return (likes + views*0.33 + shares*1.5 + 1) / Math.pow(ageHours + 2, FEED_RANK_GRAVITY);
}
