'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createProviderRegistry}=require('../api/fulfillment/registry');
const {registerBuiltInProviders}=require('../api/fulfillment/bootstrap');
test('registers main-store CJ as REGISTERED with UNKNOWN health',()=>{const r=createProviderRegistry();const result=registerBuiltInProviders(r);assert.equal(result.providerKey,'cj');assert.equal(result.registrationState,'REGISTERED');assert.equal(r.listProviders()[0].healthState,'UNKNOWN');assert.ok(result.capabilities.includes('createOrder'));});
test('does not replace a CJ adapter already registered',()=>{const r=createProviderRegistry();const a={getCapabilities(){return ['checkStock'];},async healthCheck(){return {ok:true,data:{}};},async checkStock(){return {ok:true,data:{}};}};r.registerProvider('cj',a);const result=registerBuiltInProviders(r,{adapterFactory(){throw new Error('must not run');}});assert.deepEqual(result.capabilities,['checkStock']);});
