// /api/affiliate/abandon-emails.js
//
// Lifecycle recovery processor for product views, started checkouts and
// started sign-ups. Cron-callable. It never trusts "email sent" alone:
// before each send it checks whether the shopper has already completed
// the purchase/account so completed actions suppress stale reminders.

const { getDb } = require('./shared');
const { queueEmailBackground } = require('../email-shared');
const { getAuth } = require('firebase-admin/auth');

const HOUR = 60 * 60 * 1000;
const BATCH_LIMIT = 150;

function toMs(v){
  if(!v) return 0;
  if(typeof v.toMillis === 'function') return v.toMillis();
  if(v instanceof Date) return v.getTime();
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : 0;
}
function due(v, waitMs, now){ return toMs(v.ts) > 0 && now - toMs(v.ts) >= waitMs; }

async function hasBought(db, v){
  if(!v.email || !v.productId) return false;
  const snap = await db.collection('orders')
    .where('email','==',v.email)
    .where('productId','==',v.productId)
    .limit(1).get();
  return !snap.empty;
}
async function accountExists(email){
  if(!email) return false;
  try{ await getAuth().getUserByEmail(email); return true; }
  catch(e){
    if(e && e.code === 'auth/user-not-found') return false;
    throw e;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type','application/json; charset=utf-8');
  res.setHeader('Cache-Control','no-store');

  let db;
  try{ db = getDb(); }
  catch(e){ return res.status(500).json({ok:false,error:e.message}); }

  let snap;
  try{
    // Single-field query avoids requiring a new composite Firestore index.
    // Per-event timing is checked in JS below.
    snap = await db.collection('productViewEvents')
      .where('emailed','==',false)
      .limit(BATCH_LIMIT).get();
  }catch(e){
    return res.status(500).json({ok:false,error:'Query failed: '+e.message});
  }

  const now = Date.now();
  let sent=0, skipped=0, waiting=0, errors=0;

  for(const doc of snap.docs){
    const v=doc.data()||{};
    const type=v.eventType || 'product_view';
    try{
      if(!v.email){ await doc.ref.update({emailed:true,skipReason:'missing_email'}); skipped++; continue; }

      if(type === 'checkout_started'){
        const stage=Number(v.stage||0);
        const waitMs=stage===0 ? 2*HOUR : 22*HOUR; // ~2h, then ~24h total
        if(!due(v,waitMs,now)){ waiting++; continue; }
        if(await hasBought(db,v)){
          await doc.ref.update({emailed:true,completed:true,skipReason:'order_completed'});
          skipped++; continue;
        }
        queueEmailBackground({
          templateKey: stage===0 ? 'checkout_recovery_1' : 'checkout_recovery_2',
          to:{email:v.email,name:v.name||undefined},
          params:{
            FIRSTNAME:(v.name||'').split(' ')[0]||undefined,
            product_name:v.productName||'your selected item',
            product_url:v.productUrl||'https://lexdendigital.github.io/LEXDEN-NOVA/index.html#products',
            checkout_url:v.checkoutUrl||v.productUrl||'https://lexdendigital.github.io/LEXDEN-NOVA/index.html#products',
            variant:v.variant||undefined,
            amount:v.amount||undefined,
          }
        });
        if(stage===0) await doc.ref.update({stage:1,ts:new Date(),emailed:false,lastEmail:'checkout_recovery_1'});
        else await doc.ref.update({stage:2,emailed:true,lastEmail:'checkout_recovery_2'});
        sent++; continue;
      }

      if(type === 'signup_started'){
        if(!due(v,6*HOUR,now)){ waiting++; continue; }
        if(await accountExists(v.email)){
          await doc.ref.update({emailed:true,completed:true,skipReason:'account_created'});
          skipped++; continue;
        }
        queueEmailBackground({
          templateKey:'signup_recovery',
          to:{email:v.email,name:v.name||undefined},
          params:{
            FIRSTNAME:(v.name||'').split(' ')[0]||undefined,
            signup_url:v.signupUrl||'https://lexdendigital.github.io/LEXDEN-NOVA/index.html#signup'
          }
        });
        await doc.ref.update({emailed:true,lastEmail:'signup_recovery'});
        sent++; continue;
      }

      // Legacy/normal product-view abandonment remains exactly one reminder.
      if(!due(v,1*HOUR,now)){ waiting++; continue; }
      if(!v.productId){ await doc.ref.update({emailed:true,skipReason:'missing_product'}); skipped++; continue; }
      if(await hasBought(db,v)){
        await doc.ref.update({emailed:true,completed:true,skipReason:'order_completed'});
        skipped++; continue;
      }
      queueEmailBackground({
        templateKey:'abandoned_product',
        to:{email:v.email,name:v.name||undefined},
        params:{
          product_name:v.productName||'that product',
          product_url:v.productUrl||'https://lexdendigital.github.io/LEXDEN-NOVA/index.html'
        }
      });
      await doc.ref.update({emailed:true,lastEmail:'abandoned_product'});
      sent++;
    }catch(e){
      errors++;
      console.error('lifecycle email failed for '+doc.id+':',e.message);
    }
  }

  return res.status(200).json({ok:true,sent,skipped,waiting,errors,checked:snap.size});
};
