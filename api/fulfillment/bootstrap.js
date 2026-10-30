'use strict';
const registry=require('./registry');
const {createCjAdapter}=require('./providers/cj');
function registerBuiltInProviders(targetRegistry=registry,options={}){
  const existing=targetRegistry.listProviders().find(item=>item.providerKey==='cj');
  if(existing)return existing;
  const factory=options.adapterFactory||createCjAdapter;
  return targetRegistry.registerProvider('cj',factory(options.adapterOptions||{}));
}
module.exports={registerBuiltInProviders};
