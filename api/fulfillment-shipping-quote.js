'use strict';
const {setCors}=require('./cj-shared');
const {createShippingQuoteService}=require('./fulfillment/shipping-quotes');
const service=createShippingQuoteService();

// Browser retries reuse one request ID. Keep the completed result briefly and
// coalesce concurrent retries so a browser timeout cannot launch a second set
// of stock/freight calls while the original supplier lookup is still running.
const requestCache=new Map();
const REQUEST_CACHE_TTL_MS=2*60*1000;
const REQUEST_IN_PROGRESS_LEASE_MS=2*60*1000;
const REQUEST_ID_PATTERN=/^[A-Za-z0-9_-]{16,80}$/;

function createHandler(options={}){
  const quoteService=options.service||service;
  const cache=options.requestCache||requestCache;
  const now=options.now||Date.now;

  async function runQuoteOnce(requestId,payload){
    const fingerprint=JSON.stringify(payload);
    const currentTime=now();

    for(const [key,entry] of cache){
      const staleInFlight=entry.inFlight&&currentTime-entry.startedAt>REQUEST_IN_PROGRESS_LEASE_MS;
      if((!entry.inFlight&&entry.expiresAt<=currentTime)||staleInFlight)cache.delete(key);
    }

    const existing=cache.get(requestId);
    if(existing){
      if(existing.fingerprint!==fingerprint){
        return {
          statusCode:409,
          body:{ok:false,code:'QUOTE_REQUEST_CONFLICT',error:'This delivery retry no longer matches the current address or product details. Please request a fresh quote.'}
        };
      }
      return {statusCode:200,body:await existing.promise};
    }

    const entry={
      fingerprint,
      inFlight:true,
      startedAt:currentTime,
      expiresAt:currentTime+REQUEST_CACHE_TTL_MS,
      promise:null
    };
    entry.promise=Promise.resolve().then(()=>quoteService.quote(payload)).then(result=>{
      entry.inFlight=false;
      if(result&&result.ok===true){
        entry.expiresAt=now()+REQUEST_CACHE_TTL_MS;
      }else{
        cache.delete(requestId);
      }
      return result;
    }).catch(error=>{
      cache.delete(requestId);
      throw error;
    });
    cache.set(requestId,entry);
    return {statusCode:200,body:await entry.promise};
  }

  return async function fulfillmentShippingQuoteHandler(req,res){
    setCors(req,res);
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Cache-Control','no-store');
    if(req.method==='OPTIONS')return res.status(204).end();
    if(req.method!=='POST')return res.status(405).json({ok:false,error:'Method not allowed.'});

    const b=req.body&&typeof req.body==='object'?req.body:{};
    const payload={
      productId:b.productId,
      variantId:b.variantId,
      quantity:b.quantity,
      destinationCountryCode:b.destinationCountryCode||b.countryCode,
      destinationRegion:b.destinationRegion||b.region,
      destinationCity:b.destinationCity||b.city,
      destinationPostalCode:b.destinationPostalCode||b.postalCode,
      destinationAddress1:b.destinationAddress1||b.address1||b.address,
      currency:b.currency
    };

    try{
      const requestId=typeof b.requestId==='string'&&REQUEST_ID_PATTERN.test(b.requestId)?b.requestId:null;
      const result=requestId
        ? await runQuoteOnce(requestId,payload)
        : {statusCode:200,body:await quoteService.quote(payload)};
      return res.status(result.statusCode).json(result.body);
    }catch(e){
      console.error('Provider-neutral shipping quote failed:',e&&e.code||'UNEXPECTED_ERROR');
      return res.status(200).json({ok:false,code:'SHIPPING_QUOTE_FAILED',retryable:true,error:'A live supplier delivery quote could not be completed. No payment has been taken.'});
    }
  };
}

module.exports=createHandler();
module.exports.createHandler=createHandler;
