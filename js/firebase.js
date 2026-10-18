import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, doc, getDoc, setDoc, collection, getDocs, deleteDoc, query, where, orderBy, updateDoc, increment, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, updateProfile,
  signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, signOut,
  fetchSignInMethodsForEmail, sendPasswordResetEmail,
  EmailAuthProvider, reauthenticateWithCredential, getAdditionalUserInfo
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getMessaging, getToken, onMessage, isSupported as fcmIsSupported
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging.js";

// LEXDEN NOVA Firebase project connection keys:
const firebaseConfig = {
  apiKey: "AIzaSyBk4WD0D5m6386sb62KC-5KKMpUuOLC9fs",
  authDomain: "lexden-nova.firebaseapp.com",
  projectId: "lexden-nova",
  storageBucket: "lexden-nova.firebasestorage.app",
  messagingSenderId: "421157476875",
  appId: "1:421157476875:web:c42a605fdb056c8282450e",
  measurementId: "G-CH8YGCZXMT"
};

// Must exactly match the email hardcoded in firestore.rules' isAdmin()
// check. Now that shoppers can ALSO create email/password accounts (Sign
// Up screen), "has a password-provider account" is no longer enough to
// mean "is the admin" — only this specific email is.
const ADMIN_EMAIL = "ruthanselem2@gmail.com";
window.__ADMIN_EMAIL = ADMIN_EMAIL;
// Flips to true the moment Firebase's onAuthStateChanged fires for the
// first time (see the listener below) — screenProfile() uses this to
// avoid showing "Guest Explorer" before we actually know if someone's
// signed in.
window.__fbAuthResolved = false;
// BUGFIX (Profile screen stuck on "Checking your account…" forever): on a
// slow/flaky connection, Firebase Auth's very first onAuthStateChanged
// firing can be delayed well beyond what feels reasonable — and until it
// fires, __fbAuthResolved above never flips, so the loading state had no
// way out short of a refresh. This forces it after 7s so the screen can
// fall back to a "Guest" state rather than hang indefinitely; if the real
// auth state resolves after that (a few seconds late is normal on a bad
// connection), the listener below still updates everything correctly the
// moment it does.
setTimeout(()=>{
  if(!window.__fbAuthResolved){
    window.__fbAuthResolved = true;
    console.warn('onAuthStateChanged had not fired after 7s — falling back to guest view.');
    if(typeof window.render === 'function') window.render();
  }
}, 7000);

// Cloudinary unsigned-upload target — replaces Firebase Storage for product
// media (admin) and avatar (sign-up) uploads. The "lexden-nova" preset must
// be set to "Unsigned" in Cloudinary dashboard -> Settings -> Upload; that
// preset's settings are now where upload access control lives (see the
// storage_rules.txt note elsewhere — that file is no longer used).
// IMPORTANT: the preset's "Async" option must be OFF. When Async is on,
// Cloudinary's response has no secure_url (just a pending status/batch_id),
// so the browser never gets a file URL back — this is what caused every
// upload to report "Upload failed (HTTP 200)" even though the file itself
// uploaded fine.
const CLOUDINARY_CLOUD_NAME = "z4nut80g";
const CLOUDINARY_UPLOAD_PRESET = "lexden-nova";
// Mirrored onto window because this file's other script block (the classic,
// non-module <script> below) cannot see plain module-scoped consts — same
// reason ADMIN_EMAIL above is mirrored. Skipping this step is what caused
// the admin Unlock button to silently fail (see ADMIN_LOCAL_PASSWORD below).
window.__CLOUDINARY_CLOUD_NAME = CLOUDINARY_CLOUD_NAME;
window.__CLOUDINARY_UPLOAD_PRESET = CLOUDINARY_UPLOAD_PRESET;

// ---- Admin gate: real Firebase Authentication, no client-side secret ----
// SECURITY FIX: this used to be a hardcoded local password
// (ADMIN_LOCAL_PASSWORD) checked entirely in the browser — anyone who
// opened dev tools could read it straight out of this file. That's gone.
// The ONLY gate now is a real signInWithEmailAndPassword() call, and the
// ONLY thing that actually enforces admin access is firestore.rules'
// isAdmin() check on the signed-in user's email server-side — this
// client-side check is just a UX convenience so the wrong account gets a
// clear message instead of a confusing permission-denied deeper in.
// ADMIN_EMAIL itself isn't secret (it's just which account is the admin
// account — same as any "sign in with this email" flow) so it's fine to
// keep it visible here for that message.
// SPEED FIX ("signing in forever"): signInWithEmailAndPassword has no
// built-in timeout, so a stalled connection used to hang the button
// indefinitely with no way out but a refresh. withTimeout() (defined
// further down this file, hoisted like any function declaration — see its
// own comment for where it was first introduced) guarantees this always
// settles either way within 8 seconds.

const fbApp = initializeApp(firebaseConfig);
const fbDb = getFirestore(fbApp);
const fbAuth = getAuth(fbApp);
const googleProvider = new GoogleAuthProvider();

// BUGFIX (shopper sign-in "disappearing" after a few hours, reported on an
// installed Android PWA): Firebase Auth persists the session in IndexedDB.
// Android is free to silently wipe an installed app's site storage — not
// on any fixed schedule, just whenever the OS wants space back — unless
// that storage is explicitly marked "persistent". Asking for persistence
// here doesn't guarantee it's granted, but it removes this as a cause on
// any device where it does succeed. Safe no-op if unsupported/denied.
// On-device debug log — a lightweight substitute for remote/USB debugging
// for anyone testing this PWA on a single phone with no computer to plug
// it into. Every entry is timestamped and kept in localStorage (capped so
// it can't grow forever); visit #debuglog inside the app to read it back
// on the SAME device, any time, even after the app's been closed.
window.__novaLog = function(msg){
  try{
    const KEY = 'ln_debug_log';
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    list.push({ t: Date.now(), msg: String(msg) });
    while(list.length > 300) list.shift();
    localStorage.setItem(KEY, JSON.stringify(list));
  }catch(e){}
  console.log(msg);
};

if(navigator.storage && navigator.storage.persist){
  navigator.storage.persist().then(granted=>{
    window.__novaLog('Persistent storage ' + (granted ? 'granted' : 'NOT granted (session may be evicted by the OS)'));
  }).catch(()=>{});
}

// ---- Push notifications (Firebase Cloud Messaging) ----
// PASTE YOUR OWN VAPID KEY HERE: Firebase Console → Project Settings →
// Cloud Messaging → "Web configuration" → Web Push certificates →
// generate/copy the key pair's public key. Without this, notification
// permission requests will quietly fail (nothing breaks, they just won't
// work) — see requestNotificationPermission() below.
const FCM_VAPID_KEY = "BGUBzHuN0jOIY9dfqxy49-ET_tUQ2OcMTU3bHdxuyBkJMP3d_HWSMRDa5cOm9MIp7huc5W62K_kYWRwiGUJeKWo";
let fbMessaging = null;
window.__enableNotifications = async function(){
  try{
    if(!(await fcmIsSupported())){ toast('Notifications are not supported on this browser.', 'error'); return false; }
    if(FCM_VAPID_KEY.startsWith('PASTE_')){ toast('Notifications are not set up yet — ask the developer to add a VAPID key.', 'error'); return false; }
    const perm = await Notification.requestPermission();
    if(perm !== 'granted'){ toast('Notifications permission was not granted.', 'error'); return false; }
    if(!fbMessaging) fbMessaging = getMessaging(fbApp);
    const reg = await navigator.serviceWorker.getRegistration('./');
    const token = await getToken(fbMessaging, { vapidKey: FCM_VAPID_KEY, serviceWorkerRegistration: reg });
    if(!token) return false;
    await setDoc(doc(fbDb, "fcmTokens", token), { token, at: new Date().toISOString(), ua: navigator.userAgent.slice(0,120) });
    localStorage.setItem('ln_notif_enabled', '1');
    toast('Notifications enabled — you\'ll get an alert for important updates.', 'success');
    return true;
  }catch(e){
    console.warn('Enable notifications failed', e);
    toast('Could not enable notifications right now.', 'error');
    return false;
  }
};
window.__notificationsEnabled = function(){ return localStorage.getItem('ln_notif_enabled')==='1'; };
// Foreground messages (app open in an active tab) — background messages
// while the app is closed/minimized are handled by firebase-messaging-sw.js.
fcmIsSupported().then(supported=>{
  if(!supported) return;
  fbMessaging = getMessaging(fbApp);
  onMessage(fbMessaging, payload=>{
    const title = payload.notification?.title || 'LEXDEN NOVA';
    const body = payload.notification?.body || '';
    toast(`🔔 ${title} — ${body}`, 'success');
  });
});

// Make these reachable from the existing plain-JS code below:
// The classic <script> further down uses the bare name `fbAuth` (payment mode,
// creator application, affiliates). A module-scoped const is invisible there,
// which made those calls throw ReferenceError — the admin Payments toggle sat
// on "Loading…" forever. A window property IS visible as a bare identifier.
window.fbAuth = fbAuth;
window.__fb = {
  fbDb, fbAuth, doc, getDoc, setDoc, collection, getDocs, deleteDoc, query, where, orderBy, updateDoc, increment, limit,
  signInWithEmailAndPassword, signOut,
};
// Used by the shopper Profile screen's "confirm your password" step
// before saving profile-info changes (see openProfilePasswordConfirm).
// Email/password shoppers only — a Google-signed shopper has no
// LEXDEN NOVA password to confirm, so that flow is skipped for them.
window.__novaReauth = async function(password){
  const user = fbAuth.currentUser;
  if(!user || !user.email) throw new Error('Not signed in');
  const cred = EmailAuthProvider.credential(user.email, password);
  await reauthenticateWithCredential(user, cred);
};

// Shoppers sign in with Google via this helper (called from the Profile
// screen). Distinct from admin sign-in (email/password, see tryAdminLogin)
// — we tell the two apart below using the Firebase Auth provider id, not
// just "anonymous vs not", so a shopper's Google account is never treated
// as an admin session.
//
// BUGFIX: signInWithPopup silently fails (or throws auth/popup-blocked /
// auth/operation-not-supported-in-this-environment) inside an installed
// PWA (standalone display mode) and inside most in-app browsers, because
// there's no real "opener" window for the popup to talk back to — this is
// exactly the environment this app runs in once someone installs it. In
// that case (and as a fallback if a popup gets blocked even in a normal
// browser tab) we use signInWithRedirect instead, which navigates away and
// back instead of opening a popup. The result of a redirect sign-in is
// picked up by getRedirectResult() below, right after the app reloads.
// BUGFIX (Google sign-in that "never ends" when opened from the home-screen
// icon): this used to route installed-PWA sign-ins straight to
// signInWithRedirect(), on the old assumption that an installed app can't
// open a popup. On Android that assumption is often wrong for apps
// installed via Chrome — but more importantly, redirect is genuinely
// unreliable there: the OS can hand the Google consent screen to a
// separate browser process, and the trip back to the installed app's own
// window never happens — not a slow finish, a sign-in that can never
// complete, no matter how long you wait. Trying signInWithPopup FIRST
// regardless of standalone/installed status — and only falling back to
// redirect if the popup itself is genuinely blocked or unsupported — fixes
// this because a popup either succeeds or fails fast, in the same window,
// with no OS-level handoff involved.
function isStandalonePWA(){
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
    || window.navigator.standalone === true;
}
// A flag in localStorage (survives the full-page navigation to
// accounts.google.com and back — sessionStorage can be dropped by some
// Android WebViews/PWA shells on that trip) records that a redirect
// sign-in is in flight, so the very next load can tell "no redirect
// happened" apart from "a redirect happened but Firebase came back with
// nothing" and explain the difference instead of just quietly landing
// back on the login screen.
const GSI_PENDING_KEY = 'ln_gsi_pending';
window.__signInWithGoogle = async function(){
  try{
    const result = await signInWithPopup(fbAuth, googleProvider);
    // Google accounts are pre-verified by Google itself, so only Welcome
    // applies here (never Email Verification) — and only for a brand-new
    // account, not a returning sign-in.
    if(getAdditionalUserInfo(result)?.isNewUser){
      noteDeviceSignIn(result.user.uid); // signing up IS the security event; skip the redundant new-device alert
      sendNovaEmail('welcome', { email: result.user.email, name: result.user.displayName }, {}).catch(()=>{});
    }
    return result.user;
  }catch(err){
    if(err && (err.code==='auth/popup-blocked' || err.code==='auth/operation-not-supported-in-this-environment')){
      // Popup genuinely isn't available here — fall back to redirect
      // rather than dead-ending. (This is the one case redirect is still
      // used at all; see the BUGFIX note above for why it's no longer the
      // default for installed apps.)
      localStorage.setItem(GSI_PENDING_KEY, String(Date.now()));
      await signInWithRedirect(fbAuth, googleProvider);
      return null;
    }
    console.warn("Google sign-in failed", err);
    throw err;
  }
};
// Picks up the result of a signInWithRedirect() call above once the page
// reloads after the Google auth flow. Must run once at startup, before
// anything else needs to know the sign-in state.
//
// The flag now stores a timestamp (not just '1') so a flag left behind by
// an attempt the person abandoned days ago (closed the tab mid-flow, etc.)
// doesn't get mistaken for "we're returning from Google right now" on some
// unrelated later visit — only a flag younger than 5 minutes counts.
const __gsiPendingAt = Number(localStorage.getItem(GSI_PENDING_KEY)) || 0;
const __gsiWasPending = __gsiPendingAt > 0 && (Date.now() - __gsiPendingAt) < 5*60*1000;
if(__gsiPendingAt > 0 && !__gsiWasPending) localStorage.removeItem(GSI_PENDING_KEY);
window.__googleRedirectPromise = new Promise(resolve=>{
  let settled = false;
  const finish = (user, opts)=>{
    if(settled) return;
    settled = true;
    localStorage.removeItem(GSI_PENDING_KEY);
    if(opts && opts.error) window.__googleRedirectError = opts.error;
    if(opts && opts.silentFail) window.__googleRedirectSilentFail = true;
    resolve(user || null);
  };
  // BUGFIX ("Finishing Google sign-in…" cover never went away): on some
  // Android browser/WebView combinations, getRedirectResult() has been
  // observed to simply never resolve — no result, no error, nothing — if
  // the storage it relies on got disrupted by the round trip to Google.
  // Previously that meant the promise below (and the loading cover shown
  // while waiting on it) could hang forever with no way back into the app.
  // This hard 10-second timeout guarantees it always settles no matter
  // what the SDK does.
  const timer = setTimeout(()=>{ finish(null, { silentFail: __gsiWasPending }); }, 10000);
  getRedirectResult(fbAuth).then(result=>{
    clearTimeout(timer);
    if(!result && __gsiWasPending){
      // We definitely sent the person to Google (the flag was set) but
      // came back with no user AND no thrown error — Firebase couldn't
      // complete the exchange, most likely because the storage it relies
      // on to match the return trip up with the outbound request didn't
      // survive (common inside an installed PWA/home-screen app on
      // Android, where the OS can hand the Google consent screen to a
      // separate browser process).
      finish(null, { silentFail:true });
      return;
    }
    finish(result ? result.user : null);
    if(result && getAdditionalUserInfo(result)?.isNewUser){
      noteDeviceSignIn(result.user.uid);
      sendNovaEmail('welcome', { email: result.user.email, name: result.user.displayName }, {}).catch(()=>{});
    }
  }).catch(err=>{
    clearTimeout(timer);
    console.warn("Google redirect sign-in failed", err);
    finish(null, { error: err });
  });
});

// Looks up whether an email already has an account, so the Login screen
// can tell "wrong password" apart from "no account exists yet" and offer
// to send the person to Sign Up instead of just saying "incorrect".
// Returns true/false, or null if the check itself couldn't be completed
// (treat null as "unknown" rather than assuming either answer).
window.__checkEmailExists = async function(email){
  try{
    const methods = await fetchSignInMethodsForEmail(fbAuth, email);
    return methods.length > 0;
  }catch(e){
    console.warn("Email existence check failed", e);
    return null;
  }
};

// Shopper email/password sign-in (Login page). Kept separate from
// tryAdminLogin's email/password flow only in intent — isAdminUser()
// below is what actually decides admin vs shopper for any given account,
// so a shopper email/password account is never mistaken for an admin one.
window.__emailSignIn = async function(email, password){
  const result = await signInWithEmailAndPassword(fbAuth, email, password);
  return result.user;
};

// ---- Brevo transactional emails (Welcome, Verify, Reset, Contact,
// Security, Admin) — all sent through the /api/send-email and
// /api/send-auth-email Vercel functions, which are the only things that
// ever hold BREVO_API_KEY. Reuses the SAME Vercel deployment already
// configured for payment verification (Admin → Payments → "Verification
// endpoint URL") rather than adding a second endpoint field to configure —
// send-email.js and send-auth-email.js live in that same /api folder.
// BUGFIX ("Sending…" stuck forever — only a hard refresh clears it): every
// fetch() below used to have no timeout at all, so if the Vercel function
// cold-started slowly, Brevo hung, or the connection just stalled without
// ever firing a browser network error, the awaited promise could sit
// pending indefinitely — otpSending never flips back to false because
// nothing ever resolves or rejects it. A plain setTimeout() can't help
// here since it doesn't cancel the underlying request; this wraps fetch in
// an AbortController so a stalled request is force-failed after a fixed
// window and the caller's catch block runs like any other network error.
async function fetchWithTimeout(url, options, timeoutMs){
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs || 20000);
  try{
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
function novaApiBase(){
  // FIX (mega-fix batch #2): used to re-derive this by regex-parsing the
  // admin's "Verification endpoint URL" field (removed — see the
  // API_BASE comment above). Now just the one constant, always present.
  return API_BASE;
}
async function sendNovaEmail(templateKey, to, params){
  const base = novaApiBase();
  if(!base) { console.warn('sendNovaEmail skipped — no payment verify endpoint configured yet (Admin → Payments)'); return false; }
  try{
    const r = await fetchWithTimeout(base+'/api/send-email', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ templateKey, to, params })
    }, 20000);
    return r.ok;
  }catch(e){ console.warn('sendNovaEmail failed', templateKey, e); return false; }
}
async function sendNovaAuthEmail(type, email, name){
  const base = novaApiBase();
  if(!base) return false;
  try{
    const r = await fetch(base+'/api/send-auth-email', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ type, email, name })
    });
    return r.ok;
  }catch(e){ console.warn('sendNovaAuthEmail failed', type, e); return false; }
}
// ---- Sign-up email OTP (verify BEFORE the account exists) ----
// Three-step round trip against /api/send-otp, /api/verify-otp and
// /api/confirm-email-verified (all in the same Vercel project as
// send-email.js). Returns {ok, error} shapes so callers can show the
// server's exact message instead of a generic failure.
async function sendSignupOtpCode(email){
  const base = novaApiBase();
  if(!base) return { ok:false, error:'Email service is not configured yet — contact support.' };
  try{
    const r = await fetchWithTimeout(base+'/api/send-otp', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email })
    }, 20000);
    const data = await r.json().catch(()=>({}));
    if(!r.ok) return { ok:false, error: data.error || 'Could not send the code.' };
    return { ok:true };
  }catch(e){
    console.warn('sendSignupOtpCode failed', e);
    if(e && e.name==='AbortError') return { ok:false, error:'That took too long — the email server may be waking up. Please try again.' };
    return { ok:false, error:'Network problem — check your connection.' };
  }
}
async function verifySignupOtpCode(email, code){
  const base = novaApiBase();
  if(!base) return { ok:false, error:'Email service is not configured yet — contact support.' };
  try{
    const r = await fetchWithTimeout(base+'/api/verify-otp', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ email, code })
    }, 20000);
    const data = await r.json().catch(()=>({}));
    if(!r.ok || !data.ok) return { ok:false, error: data.error || 'Could not verify that code.' };
    return { ok:true, verifiedToken: data.verifiedToken };
  }catch(e){
    console.warn('verifySignupOtpCode failed', e);
    if(e && e.name==='AbortError') return { ok:false, error:'That took too long — please try again.' };
    return { ok:false, error:'Network problem — check your connection.' };
  }
}
async function confirmEmailVerifiedServerSide(uid, email, verifiedToken){
  const base = novaApiBase();
  if(!base || !verifiedToken) return false;
  try{
    const r = await fetch(base+'/api/confirm-email-verified', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ uid, email, verifiedToken })
    });
    return r.ok;
  }catch(e){ console.warn('confirmEmailVerifiedServerSide failed', e); return false; }
}
// "Have we seen this uid sign in on this device before?" — a lightweight,
// no-backend way to fire the Security Alert email on what looks like a new
// device/browser, without building real device-fingerprinting
// infrastructure. Deliberately per-device (localStorage), not per-uid
// globally: a shopper's first sign-in on a SECOND phone should still count
// as "new" for security-alert purposes, same as most real security-alert
// systems key off "new device", not "new account".
function noteDeviceSignIn(uid){
  const key = 'ln_known_device_'+uid;
  if(localStorage.getItem(key)) return false;
  localStorage.setItem(key, String(Date.now()));
  return true;
}

// Forgot-password (Login screen). Sent through Brevo (see sendNovaAuthEmail
// above) so it matches NOVA's own branding instead of Firebase's default
// "via firebaseapp.com" email. Falls back to Firebase's own built-in
// sendPasswordResetEmail only if the Vercel email endpoint isn't
// configured yet (Admin → Payments) — so a shopper is never left with NO
// reset email at all just because Brevo hasn't been set up.
window.__sendPasswordReset = async function(email){
  const sent = await sendNovaAuthEmail('reset', email);
  if(!sent) await sendPasswordResetEmail(fbAuth, email);
};

// Shopper sign-up (Sign-up page). Creates the auth account, sets the
// display name, then hands back the user so the caller can save the
// extra profile fields (address, occupation, photo) to Firestore.
window.__emailSignUp = async function(email, password, displayName){
  const result = await createUserWithEmailAndPassword(fbAuth, email, password);
  if(displayName){
    try{ await updateProfile(result.user, { displayName }); }catch(e){ console.warn('updateProfile failed', e); }
  }
  // BUGFIX: createUserWithEmailAndPassword fires onAuthStateChanged (which
  // builds window.__fbShopper from user.displayName) the moment the account
  // is created — BEFORE the updateProfile() call above has finished. That
  // race left window.__fbShopper.name permanently blank for the rest of the
  // session, which is what made the Profile screen fall back to showing the
  // raw email address where the name should be. Patch it in directly here,
  // now that displayName is guaranteed to be set.
  if(displayName && window.__fbShopper && window.__fbShopper.uid === result.user.uid){
    window.__fbShopper.name = displayName;
  }
  // New account only (createUserWithEmailAndPassword never fires for a
  // returning shopper) — send Welcome. NOT sending a verify-email here
  // anymore: the sign-up wizard now proves the address by OTP code on
  // step 4, BEFORE this function ever runs — see sendSignupOtpCode() /
  // verifySignupOtpCode() and finishSignup()'s confirmEmailVerifiedServerSide()
  // call. Sending a second "click to verify" email after they just typed
  // a code would be confusing and redundant.
  noteDeviceSignIn(result.user.uid); // signing up IS the security event; don't also fire a redundant "new device" alert seconds later
  sendNovaEmail('welcome', { email, name: displayName }, {}).catch(()=>{});
  return result.user;
};

function isAdminUser(user){
  // The admin account is the one specific email/password account matching
  // ADMIN_EMAIL (== firestore.rules' isAdmin()). Shoppers can now also
  // sign up with email/password, so checking the provider alone is no
  // longer enough — it must be THIS email, case-insensitively.
  return !!user && !user.isAnonymous
    && user.providerData.some(p => p.providerId === 'password')
    && (user.email||'').toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

// BUGFIX (this was the actual cause of "signed in with Google, but the
// Profile tab shows signed out again"): signInAnonymously() used to be
// called unconditionally, right here, at page load — running in parallel
// with (not after) the Google redirect sign-in completing. Whichever one
// finished second WON, because signInAnonymously() always replaces
// whatever user is currently signed in. If it landed after the redirect's
// real Google user was set, it silently signed the shopper right back out
// into a fresh anonymous session — with no error, which is exactly what
// was reported. Firebase only ever fires onAuthStateChanged(null) once it
// has fully resolved that there is truly no session at all (nothing
// persisted, no pending redirect) — so starting the anonymous browsing
// session from inside that branch below, instead of eagerly here, makes
// the race impossible: anonymous sign-in can now never run before or
// during a real sign-in.
onAuthStateChanged(fbAuth, user => {
  // Never carry one account's creator status / payment-mode cache to the next.
  if(!window.__lastAuthUid || window.__lastAuthUid !== (user && user.uid)){ window.__creatorAppCache = null; window.__creatorAppError = null; window.__creatorAppFetching = false; window.__paymentModeCache = null; window.__paymentModeError = null; window.__lastAuthUid = user ? user.uid : null; try{ window.__resetCreatorWorkspace && window.__resetCreatorWorkspace(); }catch(e){} }
  // DIAGNOSTIC (temporary — helps pin down the "sign-in disappears after a
  // few hours" report): logs every time Firebase re-evaluates auth state,
  // and what it landed on. If a shopper's session vanishes, checking these
  // logs (via chrome://inspect over USB, or a remote-logging tool) will
  // show whether Firebase itself fired user:null (real session loss —
  // storage got wiped) versus the app just failing to reflect a session
  // that's actually still there (a rendering bug, not an auth bug). Safe
  // to remove once the cause is confirmed.
  window.__novaLog('onAuthStateChanged: ' + (user ? (user.isAnonymous ? 'anonymous' : user.uid) : 'null (no session)'));
  // Every branch below runs once Firebase has told us who (if anyone) is
  // signed in — before that, the very first render (fired by init(), well
  // before this listener can possibly have run) has nothing to go on and
  // shows the "Guest Explorer" signed-out card. Without this flag that
  // first paint is indistinguishable from "actually signed out", so a
  // shopper refreshing right after signing up briefly — but visibly —
  // saw their whole profile disappear before this listener caught up.
  // screenProfile() checks this flag and shows a neutral loading state
  // instead, on every load, until the real answer is in.
  window.__fbAuthResolved = true;
  if(user && isAdminUser(user)){
    window.__fbUid = null;
    window.__fbAdminEmail = user.email;
    window.__fbShopper = null;
    // SPEED FIX (admin "signing in forever" on slow connections): Firebase
    // Auth persists a valid session across reloads on its own (that's the
    // whole point of persistence) — but appState.adminAuthed used to be a
    // plain in-memory flag that reset to false on every page load no
    // matter what, so the admin was forced to re-type email+password and
    // make a brand-new live network round trip through tryAdminLogin()
    // EVERY single time they opened or refreshed #admin, even seconds
    // after a successful login. On a slow/throttled connection that fresh
    // round trip is exactly what was timing out ("Sign-in is taking too
    // long"), even though Firebase had already silently confirmed — with
    // no network call needed at all — that this browser IS the admin.
    // Trusting that here means the dashboard now opens instantly whenever
    // a valid session already exists, and the password form only appears
    // for a genuinely fresh sign-in (first time ever, after Exit Admin, or
    // if Android evicted the session's local storage).
    if(!appState.adminAuthed){
      appState.adminAuthed = true;
      window.__adminCloudAuthed = true;
      if(appState.route === '#admin') renderAdmin();
    }
  } else if(user && !user.isAnonymous){
    // A shopper signed in — either with Google or with email/password
    // via the Sign Up / Login screens.
    const provider = user.providerData.some(p=>p.providerId==='google.com') ? 'google' : 'password';
    window.__fbUid = user.uid;
    window.__fbAdminEmail = null;
    window.__fbShopper = { uid:user.uid, name:user.displayName||'', email:user.email||'', photoURL:user.photoURL||'', provider };
    if(appState.adminAuthed){ appState.adminAuthed = false; window.__adminCloudAuthed = false; }
    window.__novaUpsertUserProfile && window.__novaUpsertUserProfile(window.__fbShopper);
    // Security Alert — fires the first time THIS device/browser sees this
    // uid signed in (see noteDeviceSignIn above). A lightweight stand-in
    // for real device-fingerprinting: no new backend infrastructure, but
    // still a genuine "is this you?" signal for a shopper's existing
    // devices staying silent while a genuinely new one gets flagged.
    if(user.email && noteDeviceSignIn(user.uid)){
      sendNovaEmail('security', { email: user.email, name: user.displayName }, {
        event_type: 'New sign-in',
        device: (navigator.userAgentData?.platform || navigator.platform || 'Unknown device'),
        browser: (navigator.userAgentData?.brands?.map(b=>b.brand).join(', ') || navigator.userAgent.split(' ').slice(-1)[0] || 'Unknown browser'),
        location: 'Not available',
        event_time: new Date().toLocaleString('en-GB', { timeZone:'Africa/Lagos' }) + ' WAT',
      }).catch(()=>{});
    }
    // Pull any previously-saved address/occupation so the Profile screen
    // has them without the shopper re-entering them every session.
    if(window.__novaFetchUserProfile){
      window.__novaFetchUserProfile(user.uid).then(profile=>{
        if(profile && window.__fbShopper && window.__fbShopper.uid===user.uid){
          // Fall back to the name saved in Firestore if the live Firebase
          // Auth user still has no displayName for some reason — never
          // leaves name blank (which is what caused the email address to
          // show in its place on the Profile screen).
          if(!window.__fbShopper.name) window.__fbShopper.name = profile.name||'';
          window.__fbShopper.address = profile.address||'';
          window.__fbShopper.occupation = profile.occupation||'';
          window.__fbShopper.gender = profile.gender||'';
          window.__fbShopper.dob = profile.dob||'';
          window.__fbShopper.country = profile.country||'';
          window.__fbShopper.state = profile.state||'';
          window.__fbShopper.howHeard = profile.howHeard||'';
          window.__fbShopper.profileSetupDone = !!profile.profileSetupDone;
          // BUGFIX (uploaded profile picture "disappearing" after signing
          // out and back in): a manual (email/password) account's photo is
          // only ever saved to the Firestore profile doc (photoURL, set at
          // signup) — Firebase AUTH's own user.photoURL field is never
          // populated for password accounts (updateProfile() above only
          // ever sets displayName), so it's permanently blank here. This
          // used to check only the (always-blank) Auth field and, finding
          // it empty, silently replace the shopper's own uploaded photo
          // with the admin's default gender avatar on every fresh sign-in.
          // Now it prefers the Firestore-saved photoURL first, and only
          // falls back to the gender default if the shopper truly never
          // uploaded one.
          if(!window.__fbShopper.photoURL){
            window.__fbShopper.photoURL = profile.photoURL || (window.defaultAvatarForGender ? window.defaultAvatarForGender(profile.gender) : '');
          }
          if(appState.route==='#profile') render();
        }
      });
    }
  } else if(user){
    // Anonymous browsing session.
    window.__fbUid = user.uid;
    window.__fbAdminEmail = null;
    window.__fbShopper = null;
    // The admin's Firebase session genuinely ended (real sign-out, token
    // revoked, or Android evicted local storage) — drop the UI flag too so
    // a stale "unlocked" admin screen never lingers past the real session.
    if(appState.adminAuthed){ appState.adminAuthed = false; window.__adminCloudAuthed = false; }
  } else {
    // Firebase has now fully confirmed there is no session of any kind —
    // not persisted, not anonymous, not a completing redirect. Only now is
    // it safe to start an anonymous browsing session (see the BUGFIX note
    // above onAuthStateChanged for why this used to run eagerly instead).
    window.__fbUid = null;
    window.__fbAdminEmail = null;
    window.__fbShopper = null;
    if(appState.adminAuthed){ appState.adminAuthed = false; window.__adminCloudAuthed = false; }
    signInAnonymously(fbAuth).catch(err => console.warn("Anon sign-in failed", err));
  }
  // Once we know who we are, pull the shared data and refresh the screen
  window.__novaCloudSync && window.__novaCloudSync();
});

window.__googleSignOut = async function(){
  // BUGFIX: likes (and wishlist) were being read from this DEVICE's
  // localStorage (ln_liked_posts / ln_wishlist) and merged into whichever
  // account happened to be signed in — see pullFeedLikesFromCloud()'s
  // merge step. That merge exists so a GUEST's likes survive their first
  // sign-in, but with nothing clearing it on sign-out, it also meant
  // Account A's likes silently carried over and got written into Account
  // B's cloud doc the moment B signed in on the same device/browser —
  // which is the "already liked" bug reported. Clearing the device-local
  // caches here, before Firebase actually signs out, makes likes (and
  // wishlist) per-account again: the next sign-in starts clean and pulls
  // only that account's own liked posts from the cloud.
  DB.likedPosts = [];
  DB.wishlist = [];
  // No need to also call signInAnonymously() here — signing out fires
  // onAuthStateChanged(null) above, which now starts the anonymous
  // session itself.
  await signOut(fbAuth);
};
