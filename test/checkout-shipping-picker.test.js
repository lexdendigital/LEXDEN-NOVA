'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const state=fs.readFileSync(path.join(__dirname,'..','js','state.js'),'utf8');

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
