'use strict';

/* ---------------- DESKTOP AMBIENT PARTICLES ---------------- */
function spawnParticles(){
  if(window.innerWidth < 1024){ $all('.particle').forEach(el=>el.remove()); return; }
  if($('.particle')) return;
  for(let i=0;i<14;i++){
    const el = document.createElement('div');
    el.className='particle';
    const size = 3+Math.random()*5;
    el.style.width = el.style.height = size+'px';
    el.style.left = Math.random()*100+'vw';
    el.style.top = Math.random()*100+'vh';
    el.style.background = i%2? 'var(--accent)' : 'var(--accent-2)';
    el.style.animation = `novaFloat ${4+Math.random()*4}s ease-in-out infinite`;
    el.style.animationDelay = (Math.random()*3)+'s';
    document.body.appendChild(el);
  }
}

/* ---------------- PWA: INSTALL PROMPT + SERVICE WORKER ----------------
   Kept together, right before init(), so all the install/update wiring
   for Phase 3 lives in one place. */
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault(); // stop Chrome's default mini-infobar; we show our own banner instead
  deferredInstallPrompt = e; // save the reference now — prompt() can still be called on it later
  // Per request: don't flash the banner in immediately — wait 10s so it
  // doesn't compete with the very first thing a shopper sees on load.
  setTimeout(() => {
    if(!deferredInstallPrompt) return; // installed or dismissed in the meantime
    appState.canInstall = true;
    render();
  }, 10000);
});
window.addEventListener('appinstalled', () => {
  logActivity('User', 'Installed app to home screen');
  lsSet(LS_KEYS.installDismissed, true);
  appState.canInstall = false;
  deferredInstallPrompt = null;
  render();
});

/* ---------------- INIT ---------------- */
// ---- Boot-time query-string deep links ----
// Query strings (unlike #hash fragments) ARE sent to the server and ARE
// distinct, indexable URLs — this is the other half of the indexing fix
// in updateSeoForRoute(): a search engine (or a shared link) landing on
// index.html?product=xyz / ?s=xyz now gets translated into the matching
// in-app hash route on load, so these URLs actually work as entry points
// and not just as SEO promises. ?s= also backs the WebSite SearchAction
// JSON-LD in <head> (Google's sitelinks searchbox).
function applyBootQueryString(){
  const params = new URLSearchParams(location.search);
  const productId = params.get('product');
  const feedId = params.get('feed') || params.get('post');
  const searchTerm = params.get('s');
  if(productId && findProduct(productId)){
    location.hash = '#product/'+productId;
  } else if(feedId && DB.feed.find(x=>x.id===feedId)){
    location.hash = '#feed/'+feedId;
  } else if(params.has('service')){
    location.hash = '#service';
  } else if(searchTerm){
    appState.productFilters.q = searchTerm;
    location.hash = '#products';
  }
}
function init(){
  seedIfNeeded();
  // If the real catalog has not arrived after 15s (no signal, Firebase blocked),
  // stop showing skeletons and let the person retry instead of waiting forever.
  setTimeout(()=>{ if(!window.__catalogLoaded){ window.__catalogLoaded = true; window.__catalogFailed = true; try{ render(); }catch(e){} } }, 15000);
  applyTheme();
  applyBootQueryString();
  if(!location.hash) location.hash = '#home';
  updateCatalogSchema();
  render();
  spawnParticles();
  tryRefreshExchangeRates();
  registerServiceWorker();
  // Sweep any payments from a previous session that never got confirmed
  // (closed the app mid-verification, connection dropped, etc.) — waits
  // for Firebase's window.__fb bridge to exist first since verification
  // doesn't strictly need it, but window.__fbUid does for accurate order
  // attribution.
  setTimeout(()=>{ retryPendingPayments(true); }, 1500);
  setTimeout(warmBackend, 800);
  setTimeout(maybeShowNewsletterPopup, 5000);
  document.addEventListener('keydown', e=>{ if(e.key==='Escape' && appState.novaOpen) toggleNova(false); });
  // Close the custom price-range popover on any outside click/tap, same
  // UX a native <select> gives you for free — needed here since this is a
  // plain div, not a real dropdown element.
  document.addEventListener('click', e=>{
    if(appState.priceFilterOpen && !e.target.closest('#priceFilterRow')){
      appState.priceFilterOpen = false;
      rerenderProductList();
    }
  });
  // Basic global error guard so a single bad render doesn't blank the app
  window.addEventListener('error', e=>{ console.error('LEXDEN NOVA error:', e.error||e.message); });
  // Finish a Google sign-in that used signInWithRedirect (standalone PWA /
  // in-app browsers — see window.__signInWithGoogle). Resolves to null on
  // every normal page load where no redirect sign-in was pending, so this
  // is a no-op the vast majority of the time. If a redirect WAS just sent
  // (a fresh, recent ln_gsi_pending timestamp), show a brief "Finishing
  // sign-in…" cover instead of letting the person glimpse a signed-out
  // screen while it resolves — window.__googleRedirectPromise always
  // settles within 10s regardless of what the SDK does, so this can never
  // hang forever (see the BUGFIX note on that promise).
  const __gsiPendingRaw = Number(localStorage.getItem('ln_gsi_pending')) || 0;
  if(__gsiPendingRaw > 0 && (Date.now() - __gsiPendingRaw) < 5*60*1000) showFinishingSignInOverlay();
  if(window.__googleRedirectPromise){
    window.__googleRedirectPromise.then(user=>{
      hideFinishingSignInOverlay();
      if(user){
        toast('Signed in!', 'success');
        if(!applyPendingFeedLikeIfAny()) navigate('#profile');
        setTimeout(render, 250);
      }else if(window.__googleRedirectError){
        const code = window.__googleRedirectError.code;
        if(code && code!=='auth/popup-closed-by-user' && code!=='auth/cancelled-popup-request'){
          toast(
            (code==='auth/unauthorized-domain') ? 'This site isn\'t authorized for Google sign-in yet — the domain needs to be added in Firebase Console → Authentication → Settings → Authorized domains.'
            : (code==='auth/operation-not-allowed') ? 'Google sign-in isn\'t enabled for this app yet — enable it in Firebase Console → Authentication → Sign-in method.'
            : (code==='auth/network-request-failed') ? 'Network problem — check your connection and try again.'
            : `Google sign-in failed: ${code}.`,
            'error'
          );
        }
      }else if(window.__googleRedirectSilentFail){
        // Sent to Google, came back, but Firebase couldn't complete the
        // exchange — no thrown error, just nothing. See the BUGFIX note on
        // window.__googleRedirectPromise for why this happens; it's almost
        // always an installed-app/in-app-browser storage issue, not
        // anything wrong with the account itself.
        toast('Google sign-in didn\'t finish. If you installed this as an app, try signing in from your regular browser (Chrome) first — or use email sign-in instead.', 'error');
        window.__googleRedirectSilentFail = false;
      }
    });
  }
}
captureAffiliateAttribution();
init();
