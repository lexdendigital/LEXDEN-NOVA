'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {getShippingPolicy,conservativeDeliveryDays,evaluateShippingPolicy}=require('../api/fulfillment/policy');

test('no delivery-time or freight ceiling is invented by default',()=>{
  const p=getShippingPolicy({});
  assert.equal(p.maxDeliveryDays,null);
  assert.equal(p.maxShippingUSD,null);
  assert.equal(p.maxShippingUSDPerFulfillment,null);
  assert.equal(p.maxShippingUSDPerOrder,null);
});

test('centrally configured limits are read exactly, without hidden 15-unit clamps',()=>{
  const p=getShippingPolicy({content:{shippingPolicy:{
    maxDeliveryDays:30,
    maxShippingUSD:40,
    maxShippingUSDPerFulfillment:45,
    maxShippingUSDPerOrder:55,
  }}});
  assert.equal(p.maxDeliveryDays,30);
  assert.equal(p.maxShippingUSD,40);
  assert.equal(p.maxShippingUSDPerFulfillment,45);
  assert.equal(p.maxShippingUSDPerOrder,55);
});

test('verified route is not rejected merely for exceeding the former 15/15 assumptions',()=>{
  const p=getShippingPolicy({});
  const result=evaluateShippingPolicy({
    shippingUSD:24,
    totalMaxDeliveryDays:28,
    stockVerified:true,
    shippingVerified:true,
    deliveryVerified:true,
    policy:p,
  });
  assert.equal(result.eligible,true);
  assert.deepEqual(result.reasons,[]);
});

test('an explicitly configured central limit is enforced',()=>{
  const p=getShippingPolicy({shippingPolicy:{maxDeliveryDays:30,maxShippingUSD:25}});
  assert.equal(evaluateShippingPolicy({
    shippingUSD:25,
    totalMaxDeliveryDays:30,
    stockVerified:true,
    shippingVerified:true,
    deliveryVerified:true,
    policy:p,
  }).eligible,true);
  assert.deepEqual(evaluateShippingPolicy({
    shippingUSD:25.01,
    totalMaxDeliveryDays:30,
    stockVerified:true,
    shippingVerified:true,
    deliveryVerified:true,
    policy:p,
  }).reasons,['SHIPPING_TOO_EXPENSIVE']);
  assert.deepEqual(evaluateShippingPolicy({
    shippingUSD:10,
    totalMaxDeliveryDays:31,
    stockVerified:true,
    shippingVerified:true,
    deliveryVerified:true,
    policy:p,
  }).reasons,['DELIVERY_TOO_SLOW']);
});

test('unknown stock, shipping or delivery estimate remains unverified',()=>{
  const p=getShippingPolicy({});
  assert.equal(evaluateShippingPolicy({shippingUSD:5,totalMaxDeliveryDays:10,stockVerified:false,shippingVerified:true,deliveryVerified:true,policy:p}).eligible,false);
  assert.equal(evaluateShippingPolicy({shippingUSD:null,totalMaxDeliveryDays:10,stockVerified:true,shippingVerified:true,deliveryVerified:true,policy:p}).eligible,false);
  assert.equal(evaluateShippingPolicy({shippingUSD:5,totalMaxDeliveryDays:null,stockVerified:true,shippingVerified:true,deliveryVerified:true,policy:p}).eligible,false);
});

test('business-day ETA is normalized conservatively',()=>{
  assert.equal(conservativeDeliveryDays({deliveryRange:'3-7 business days'},2),12);
});
