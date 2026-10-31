'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const state=fs.readFileSync(path.join(__dirname,'..','js','state.js'),'utf8');
const support=fs.readFileSync(path.join(__dirname,'..','js','support.js'),'utf8');

test('physical checkout uses the NOVA custom picker, not a native delivery select',()=>{
  assert.match(state,/customSelect\('dd_shippingMethod','',\[\]/);
  assert.doesNotMatch(state,/<select[^>]*id=["']dd_shippingMethod["']/i);
  assert.match(state,/function renderCjShippingServices\(/);
  assert.match(state,/function selectCjShippingService\(/);
  assert.doesNotMatch(state,/No supplier can currently verify a delivery option for this address/);
});

test('checkout waits for the shopper to choose one of the available service quotes',()=>{
  assert.match(state,/routeSelect\.value='';/);
  assert.match(state,/btn\)btn\.disabled=true/);
  assert.match(state,/serviceLabel/);
  assert.match(state,/estimated order-to-door time/i);
});

test('selected NOVA quote id and exact supplier carrier are carried into checkout details',()=>{
  assert.match(state,/const quoteId=routeSelect&&routeSelect\.value/);
  assert.match(state,/shippingQuoteId:quote\.quoteId/);
  assert.match(state,/shippingMethod:quote\.logisticName/);
  assert.match(state,/shippingServiceLevel:quote\.serviceLevel/);
});


test('shipping quote failures expose a real retry link and rerun the same safe lookup',()=>{
  assert.match(state,/function renderCjShippingRetryLink\(/);
  assert.match(state,/link\.textContent='Please retry'/);
  assert.match(state,/link\.addEventListener\('click'/);
  assert.match(state,/cjRefreshShippingEstimate\(product,selectedVariant\)/);
  assert.match(state,/cjShippingQuoteCanRetry\(r\)/);
  assert.match(state,/aria-live="polite"/);
});

test('shipping quote gets a longer bounded request window than the former 15-second cutoff',()=>{
  assert.match(state,/const requestTimeoutMs=65000/);
  assert.match(state,/requestTimeoutMs\+5000/);
  assert.match(support,/async function cjApiPost\(path, body, timeoutMs\)/);
  assert.match(support,/Math\.min\(Number\(timeoutMs\), 90000\)/);
  assert.match(support,/code:timedOut \? 'TIMEOUT' : 'NETWORK_ERROR'/);
});

test('shipping retry does not enable payment or weaken quote validation',()=>{
  assert.match(state,/if\(btn\)btn\.disabled=true/);
  assert.match(state,/shippingQuoteId\s*\|\|/);
  assert.match(state,/shipping quote is missing or expired/i);
});

test('manual delivery retry reuses an idempotency key for the same quote payload',()=>{
  assert.match(state,/function createCjShippingRequestId\(/);
  assert.match(state,/previousAttempt\.fingerprint===fingerprint/);
  assert.match(state,/quotePayload\.requestId=requestId/);
  assert.match(state,/cjRefreshShippingEstimate\(product,selectedVariant,true\)/);
});

test('the backend deduplicates in-flight and completed retries for the same request ID',()=>{
  const route=fs.readFileSync(path.join(__dirname,'..','api','fulfillment-shipping-quote.js'),'utf8');
  assert.match(route,/const requestCache=new Map\(\)/);
  assert.match(route,/cache\.get\(requestId\)/);
  assert.match(route,/existing\.fingerprint!==fingerprint/);
  assert.match(route,/entry\.promise/);
});
