'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createCjAdapter}=require('../api/fulfillment/providers/cj');
function route(body,capture){return async(req,res)=>{if(capture)capture(req);return res.status(200).json(body);};}
function setup(overrides={}){
  const calls=[];
  const handlers={
    products:route({ok:true,categories:[{id:'cat'}],page:1,pageSize:20,total:1,products:[{pid:'p1'}]}),
    product:route({ok:true,product:{pid:'p1',sourceData:{password:'hidden'}},variants:[{vid:'v1',sourceData:{accessToken:'hidden'}}]}),
    stock:route({ok:true,stock:{v1:{total:8,inStock:true,byWarehouse:[{area:'CN',qty:8}]}}}),
    shipping:route({ok:true,options:[{logisticName:'CJPacket',logisticPrice:3.25,logisticAging:'8-12 days'}]}),
    order:route({ok:true,cj:{orderId:'CJ-1',shipmentOrderId:'SHIP-1',status:'PAID',fundingStatus:'paid'}}),
    orders:route({ok:true,order:{orderId:'CJ-1',orderStatus:'PROCESSING',trackNumber:'TR-1'}}),
    tracking:route({ok:true,carrier:'CJPacket',status:'In transit',events:[{time:'2026-10-30',description:'Departed',location:'Shenzhen'}]}),
    ...(overrides.handlers||{})
  };
  const cjFetch=async(path,options)=>{calls.push({path,options});return overrides.cjFetchResult||{ok:true,requestId:'req-1',data:{amount:21}};};
  return {adapter:createCjAdapter({handlers,cjFetch}),calls};
}
test('declares existing global CJ capabilities only',()=>assert.deepEqual(setup().adapter.getCapabilities(),['getCategories','searchProducts','getProduct','getVariants','checkStock','getWarehouseInventory','quoteShipping','createOrder','getOrder','getTracking','getFundingRequirements']));
test('health check probes the existing global CJ API',async()=>{const {adapter,calls}=setup();const r=await adapter.healthCheck();assert.equal(calls[0].path,'/product/getCategory');assert.equal(r.ok,true);assert.equal(r.data.authenticated,true);});
test('health failure does not invent connectivity',async()=>{const {adapter}=setup({cjFetchResult:{ok:false,code:'NOT_CONFIGURED',message:'missing'}});const r=await adapter.healthCheck();assert.equal(r.ok,false);assert.equal(r.code,'NOT_CONFIGURED');});
test('categories and product search reuse existing CJ route',async()=>{let req;const {adapter}=setup({handlers:{products:route({ok:true,mode:'search',page:2,pageSize:10,total:1,products:[{pid:'p2'}],categories:[{id:'cat'}]},r=>{req=r;})}});const s=await adapter.searchProducts({keyword:'cable',page:2,pageSize:10});assert.equal(req.query.keyword,'cable');assert.equal(s.data.products[0].pid,'p2');const c=await adapter.getCategories();assert.equal(c.ok,true);assert.equal(req.query.mode,'categories');});
test('product details and variants strip private raw supplier payloads',async()=>{const {adapter}=setup();const p=await adapter.getProduct({externalProductId:'p1'});assert.equal(p.data.product.pid,'p1');assert.equal(Object.hasOwn(p.data.product,'sourceData'),false);assert.equal(Object.hasOwn(p.data.variants[0],'sourceData'),false);const v=await adapter.getVariants({externalProductId:'p1'});assert.equal(v.data.variants[0].vid,'v1');});
test('stock and warehouse lookups preserve live quantities',async()=>{const {adapter}=setup();const s=await adapter.checkStock({externalVariantId:'v1'});assert.equal(s.data.availableQuantity,8);assert.equal(s.data.warehouses[0].warehouse,'CN');const w=await adapter.getWarehouseInventory({externalVariantId:'v1'});assert.deepEqual(w.data.warehouses,[{warehouse:'CN',countryCode:'CN',quantity:8}]);});
test('stock errors are not converted into success or out-of-stock',async()=>{const {adapter}=setup({handlers:{stock:route({ok:true,stock:{},errors:{v1:'Rate limited'}})}});const r=await adapter.checkStock({externalVariantId:'v1'});assert.equal(r.ok,false);assert.equal(r.code,'CJ_STOCK_UNVERIFIED');});
test('shipping requests use explicit origin, destination and quantity',async()=>{let req;const {adapter}=setup({handlers:{shipping:route({ok:true,options:[{logisticName:'CJPacket',logisticPrice:3.25,logisticAging:'8-12 days'}]},r=>{req=r;})}});const q=await adapter.quoteShipping({externalVariantId:'v1',originCountryCode:'CN',destinationCountryCode:'NG',quantity:2});assert.deepEqual(req.body.products,[{vid:'v1',quantity:2}]);assert.equal(req.body.startCountryCode,'CN');assert.equal(req.body.endCountryCode,'NG');assert.equal(Object.hasOwn(req.body,'productId'),false);assert.equal(q.data.options[0].supplierShippingCost,3.25);});
test('shipping rejects missing origin and invalid quantities',async()=>{const {adapter,calls}=setup();await assert.rejects(()=>adapter.quoteShipping({externalVariantId:'v1',destinationCountryCode:'NG'}),/origin country code is required/i);const r=await adapter.quoteShipping({externalVariantId:'v1',originCountryCode:'CN',destinationCountryCode:'NG',quantity:0});assert.equal(r.code,'INVALID_QUANTITY');assert.equal(calls.length,0);});
test('order creation delegates to the legacy route and requires an external order ID',async()=>{let req;const {adapter}=setup({handlers:{order:route({ok:true,cj:{orderId:'CJ-1',fundingStatus:'paid'}},r=>{req=r;})}});const r=await adapter.createOrder({orderReference:'PAY-1'});assert.deepEqual(req.body,{reference:'PAY-1'});assert.equal(r.data.externalOrderId,'CJ-1');});
test('created CJ order with funding exception is retained as created',async()=>{const {adapter}=setup({handlers:{order:route({ok:false,error:'funding_required',cj:{orderId:'CJ-2',fundingStatus:'cj_balance_insufficient'}})}});const r=await adapter.createOrder({orderReference:'PAY-2'});assert.equal(r.ok,true);assert.equal(r.data.externalOrderId,'CJ-2');assert.equal(r.data.fundingRequired,true);});
test('order lookup and tracking use existing CJ routes',async()=>{const {adapter}=setup();const o=await adapter.getOrder({externalOrderId:'CJ-1'});assert.equal(o.data.supplierStatus,'PROCESSING');const t=await adapter.getTracking({trackingNumber:'TR-1'});assert.equal(t.data.carrier,'CJPacket');assert.equal(t.data.events[0].location,'Shenzhen');});
test('funding requirements read wallet only and never pay or top up',async()=>{const {adapter,calls}=setup();const r=await adapter.getFundingRequirements();assert.deepEqual(calls.map(c=>c.path),['/shopping/pay/getBalance']);assert.equal(r.data.providerFundingModel,'CJ_WALLET');assert.equal(r.data.walletBalance,21);});
test('missing identifiers fail closed before remote calls',async()=>{const {adapter,calls}=setup();await assert.rejects(()=>adapter.getProduct({}),/external CJ product or variant ID/i);await assert.rejects(()=>adapter.checkStock({}),/external CJ variant ID/i);await assert.rejects(()=>adapter.createOrder({}),/order reference is required/i);assert.equal(calls.length,0);});
test('legacy CJ route failures remain failures',async()=>{const {adapter}=setup({handlers:{product:route({ok:false,error:'CJ product not found'})}});const r=await adapter.getProduct({externalProductId:'missing'});assert.equal(r.ok,false);assert.equal(r.message,'CJ product not found');});
