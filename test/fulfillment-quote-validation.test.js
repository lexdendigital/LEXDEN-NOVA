'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{validateProviderNeutralQuote}=require('../api/fulfillment/quote-validation'),{buildSupplierMapping}=require('../api/fulfillment/product-mapping'),{getShippingPolicy}=require('../api/fulfillment/policy');
const product={id:'p1',physical:{supplierId:'s1',routing:{primarySupplierId:'s1',active:true},supplierMappings:[buildSupplierMapping({supplierId:'s1',providerKey:'provider-a',externalProductId:'ep1',status:'MAPPED',approvedForFulfillment:true,variantMappings:[{novaVariantId:'v1',externalVariantId:'ev1'}]})]}};
const base={product,selection:{variantId:'v1',price:45000},delivery:{country:'Nigeria',state:'Ogun',city:'Agbara',postalCode:'112001'},payment:{currency:'NGN',amountMinor:9750000,paidAt:'2026-10-30T11:00:00Z'},reference:'PAY-1',quantity:2,suppliers:[{id:'s1',providerKey:'provider-a',active:true}],quote:{quoteId:'q1',status:'open',productId:'p1',variantId:'v1',quantity:2,currency:'NGN',destination:{countryCode:'NG',region:'Ogun',city:'Agbara',postalCode:'112001'},endCountryCode:'NG',startCountryCode:'CN',supplierId:'s1',providerKey:'provider-a',externalProductId:'ep1',externalVariantId:'ev1',shippingMethod:'Air',logisticName:'Air',productAmountMajor:90000,shippingAmountMajor:7500,shippingAmountUSD:5,supplierShippingCostUSD:5,estimatedOrderToDoorMaxDays:6,stockVerified:true,shippingVerified:true,deliveryVerified:true,totalAmountMajor:97500,createdAt:new Date('2026-10-30T10:00:00Z'),expiresAt:new Date('2026-10-30T13:00:00Z')}};
test('valid provider quote is converted into trusted delivery and fulfillment snapshots',()=>{const r=validateProviderNeutralQuote(base);assert.equal(r.ok,true);assert.equal(r.fulfillment.externalVariantId,'ev1');assert.equal(r.delivery.shippingOriginCountry,'CN');});
for(const[n,fn,code]of[['expired',o=>o.payment.paidAt='2026-10-30T14:00:00Z','QUOTE_EXPIRED'],['product',o=>o.quote.productId='x','QUOTE_PRODUCT_MISMATCH'],['variant',o=>o.quote.variantId='x','QUOTE_PRODUCT_MISMATCH'],['quantity',o=>o.quote.quantity=1,'QUOTE_QUANTITY_MISMATCH'],['currency',o=>o.quote.currency='USD','QUOTE_CURRENCY_MISMATCH'],['country',o=>o.delivery.country='Ghana','QUOTE_DESTINATION_MISMATCH'],['region',o=>o.delivery.state='Lagos','QUOTE_DESTINATION_MISMATCH'],['tampered total',o=>o.quote.totalAmountMajor=1,'QUOTE_AMOUNT_MISMATCH'],['underpayment',o=>o.payment.amountMinor=1,'QUOTE_AMOUNT_MISMATCH'],['supplier',o=>o.quote.supplierId='x','QUOTE_SUPPLIER_MISMATCH'],['provider',o=>o.quote.providerKey='x','QUOTE_SUPPLIER_MISMATCH'],['external variant',o=>o.quote.externalVariantId='x','QUOTE_VARIANT_MAPPING_CHANGED'],['disabled supplier',o=>o.suppliers[0].active=false,'QUOTE_SUPPLIER_MISMATCH'],['reused quote',o=>{o.quote.status='reserved';o.quote.usedBy='OTHER';},'QUOTE_UNAVAILABLE']])test('rejects changed '+n,()=>{const o=structuredClone(base);fn(o);assert.equal(validateProviderNeutralQuote(o).code,code);});
test('allows repeat verification for same reserved reference',()=>{const o=structuredClone(base);o.quote.status='reserved';o.quote.usedBy='PAY-1';assert.equal(validateProviderNeutralQuote(o).ok,true);});

test('quote validation does not invent 15-day or US$15 limits',()=>{
 const o=structuredClone(base);
 o.quote.supplierShippingCostUSD=24;
 o.quote.shippingAmountUSD=24;
 o.quote.estimatedOrderToDoorMaxDays=28;
 assert.equal(validateProviderNeutralQuote(o).ok,true);
});
test('quote validation enforces only an explicitly configured central cap',()=>{
 const o=structuredClone(base);
 o.quote.supplierShippingCostUSD=24;
 o.quote.shippingAmountUSD=24;
 const result=validateProviderNeutralQuote({...o,policy:getShippingPolicy({shippingPolicy:{maxShippingUSD:20}})});
 assert.equal(result.ok,false);
 assert.equal(result.code,'SHIPPING_TOO_EXPENSIVE');
});
