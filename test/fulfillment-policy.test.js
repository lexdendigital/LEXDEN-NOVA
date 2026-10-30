'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {getShippingPolicy,conservativeDeliveryDays,evaluateShippingPolicy}=require('../api/fulfillment/policy');

test('hard limits cannot be relaxed above NOVA defaults',()=>{
  const p=getShippingPolicy({content:{shippingPolicy:{maxDeliveryDays:90,maxShippingUSD:99,maxShippingUSDPerFulfillment:50,maxShippingUSDPerOrder:70}}});
  assert.equal(p.maxDeliveryDays,15);
  assert.equal(p.maxShippingUSD,15);
  assert.equal(p.maxShippingUSDPerFulfillment,15);
  assert.equal(p.maxShippingUSDPerOrder,15);
});

for(const [shipping,days,eligible] of [[14.99,14,true],[15,15,true],[15.01,10,false],[5,16,false]]){
  test('shipping policy '+shipping+' USD / '+days+' days',()=>{
    assert.equal(evaluateShippingPolicy({
      shippingUSD:shipping,
      totalMaxDeliveryDays:days,
      stockVerified:true,
      shippingVerified:true,
      policy:getShippingPolicy({})
    }).eligible,eligible);
  });
}

test('unknown stock, shipping or ETA never becomes eligible',()=>{
  const p=getShippingPolicy({});
  assert.equal(evaluateShippingPolicy({shippingUSD:null,totalMaxDeliveryDays:10,stockVerified:true,shippingVerified:false,policy:p}).eligible,false);
  assert.equal(evaluateShippingPolicy({shippingUSD:5,totalMaxDeliveryDays:null,stockVerified:true,shippingVerified:true,policy:p}).eligible,false);
  assert.equal(evaluateShippingPolicy({shippingUSD:5,totalMaxDeliveryDays:10,stockVerified:false,shippingVerified:true,policy:p}).eligible,false);
});

test('business-day ETA is normalized conservatively',()=>{
  assert.equal(conservativeDeliveryDays({deliveryRange:'3-7 business days'},2),12);
});
