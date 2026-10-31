'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHandler}=require('../api/fulfillment-shipping-quote');

function makeResponse(){
  return {
    statusCode:200,
    headers:{},
    setHeader(name,value){this.headers[name]=value;return this;},
    status(code){this.statusCode=Number(code)||200;return this;},
    json(body){this.body=body;return this;},
    end(){this.ended=true;return this;}
  };
}
async function invoke(handler,body){
  const res=makeResponse();
  await handler({method:'POST',headers:{origin:'https://lexdendigital.github.io'},body},res);
  return res;
}
const request={
  productId:'product-1',
  variantId:'variant-1',
  quantity:1,
  destinationCountryCode:'NG',
  destinationRegion:'Lagos',
  destinationCity:'Ikorodu',
  destinationAddress1:'Example Street 1',
  currency:'NGN',
  requestId:'nova_req_123456789012'
};

test('concurrent retries with the same request ID share one supplier quote operation',async()=>{
  let calls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const result={ok:true,quoteExpiresAt:new Date(Date.now()+60000).toISOString(),options:[{quoteId:'quote-1'}]};
  const handler=createHandler({
    service:{async quote(){calls++;await gate;return result;}},
    requestCache:new Map()
  });

  const first=invoke(handler,{...request});
  await Promise.resolve();
  const second=invoke(handler,{...request});
  await Promise.resolve();
  assert.equal(calls,1,'the second request must join the first request, not call the supplier again');
  release();

  const [a,b]=await Promise.all([first,second]);
  assert.equal(a.statusCode,200);
  assert.equal(b.statusCode,200);
  assert.deepEqual(a.body,result);
  assert.deepEqual(b.body,result);

  const afterCompletion=await invoke(handler,{...request});
  assert.deepEqual(afterCompletion.body,result);
  assert.equal(calls,1,'a late retry must reuse the completed quote response');
});

test('a request ID cannot be reused for a different delivery address or product payload',async()=>{
  let calls=0;
  const handler=createHandler({
    service:{async quote(){calls++;return{ok:true,quoteExpiresAt:new Date(Date.now()+60000).toISOString(),options:[]};}},
    requestCache:new Map()
  });
  await invoke(handler,{...request});
  const changed=await invoke(handler,{...request,destinationCity:'Abeokuta'});

  assert.equal(changed.statusCode,409);
  assert.equal(changed.body.code,'QUOTE_REQUEST_CONFLICT');
  assert.equal(calls,1);
});

test('failed supplier quotes are not cached, allowing a later retry to run again',async()=>{
  let calls=0;
  const handler=createHandler({
    service:{async quote(){
      calls++;
      return calls===1
        ? {ok:false,code:'API_UNAVAILABLE'}
        : {ok:true,quoteExpiresAt:new Date(Date.now()+60000).toISOString(),options:[{quoteId:'quote-2'}]};
    }},
    requestCache:new Map()
  });
  const first=await invoke(handler,{...request});
  const second=await invoke(handler,{...request});

  assert.equal(first.body.ok,false);
  assert.equal(second.body.ok,true);
  assert.equal(calls,2);
});

test('legacy callers without an idempotency token retain normal quote behaviour',async()=>{
  let calls=0;
  const handler=createHandler({
    service:{async quote(){calls++;return{ok:true,options:[]};}},
    requestCache:new Map()
  });
  await invoke(handler,{...request,requestId:undefined});
  await invoke(handler,{...request,requestId:undefined});
  assert.equal(calls,2);
});
