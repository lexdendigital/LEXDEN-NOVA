'use strict';
const {setCors}=require('./cj-shared');
const {createShippingQuoteService}=require('./fulfillment/shipping-quotes');
const service=createShippingQuoteService();
module.exports=async function(req,res){
setCors(req,res);res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('Cache-Control','no-store');
if(req.method==='OPTIONS')return res.status(204).end();
if(req.method!=='POST')return res.status(405).json({ok:false,error:'Method not allowed.'});
const b=req.body&&typeof req.body==='object'?req.body:{};
try{return res.status(200).json(await service.quote({productId:b.productId,variantId:b.variantId,quantity:b.quantity,destinationCountryCode:b.destinationCountryCode||b.countryCode,destinationRegion:b.destinationRegion||b.region,destinationCity:b.destinationCity||b.city,destinationPostalCode:b.destinationPostalCode||b.postalCode,destinationAddress1:b.destinationAddress1||b.address1||b.address,currency:b.currency}));}
catch(e){console.error('Provider-neutral shipping quote failed:',e&&e.code||'UNEXPECTED_ERROR');return res.status(200).json({ok:false,code:'SHIPPING_QUOTE_FAILED',error:'A live supplier delivery quote could not be completed. No payment has been taken.'});}
};