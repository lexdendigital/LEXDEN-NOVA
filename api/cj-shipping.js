// /api/cj-shipping.js
// CJ freight calculation. Public generic quotes remain available to admin/MCP;
// storefront quotes are persisted server-side and must be validated at payment verification.
'use strict';

const crypto = require('node:crypto');
const { setCors, cjFetch, writeSyncLog } = require('./cj-shared');
const { getDb } = require('./affiliate/shared');
const { resolveProductSelection } = require('./product-variants');
const { getCommercePricingPolicy, calculateShippingCharge, rateForCurrency, selectShippingServices, sortShippingOptions, shippingRatio } = require('./commerce-pricing');

function countryToIso2(value) {
  const text = String(value || '').trim();
  if (text.toUpperCase() === 'UK') return 'GB';
  if (text.toUpperCase() === 'EU') return null; // a region is not a country-of-origin code
  if (/^[A-Z]{2}$/.test(text)) return text;
  return ({
    nigeria: 'NG', china: 'CN', 'united states': 'US', 'united states of america': 'US',
    'united kingdom': 'GB', uk: 'GB', ghana: 'GH', kenya: 'KE', 'south africa': 'ZA',
    poland: 'PL', germany: 'DE', france: 'FR', netherlands: 'NL', italy: 'IT', spain: 'ES',
  })[text.toLowerCase()] || null;
}

function roundTotal(value, currency) {
  return currency === 'NGN' ? Math.ceil(value) : Math.round(value * 100) / 100;
}

function stockRowsFromResponse(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  // CJ integrations may return raw rows or wrap warehouse rows under data/list.
  // Prefer warehouse-specific arrays so quantities are never treated as a total
  // for every warehouse.
  for (const key of ['list', 'rows', 'byWarehouse', 'warehouseList', 'inventories', 'warehouses', 'data']) {
    if (Array.isArray(data[key])) return data[key];
  }
  for (const key of ['data', 'stock', 'result']) {
    if (data[key] && typeof data[key] === 'object') {
      const nested = stockRowsFromResponse(data[key]);
      if (nested.length) return nested;
    }
  }
  return [data];
}

function stockQuantity(row) {
  for (const key of ['storageNum', 'stockNum', 'num', 'quantity', 'qty', 'availableStock', 'inventoryNum', 'total', 'stock']) {
    if (row && row[key] != null && row[key] !== '') {
      const n = Number(row[key]);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return null;
}

function stockOriginCountry(row) {
  if (!row || typeof row !== 'object') return null;
  for (const key of ['area', 'areaCode', 'countryCode', 'country', 'storageCountryCode', 'warehouseCountryCode']) {
    const code = countryToIso2(row[key]);
    if (code) return code;
  }
  return null;
}

module.exports = async (req, res) => {
  setCors(req, res);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const body = req.body || {};
  const endCountryCode = countryToIso2(body.endCountryCode || body.destinationCountry || 'NG');
  const startCountryCode = countryToIso2(body.startCountryCode || 'CN');
  const products = Array.isArray(body.products) ? body.products.slice(0, 20) : [];
  const checkoutQuote = typeof body.productId === 'string' && body.productId.length > 0;
  const currency = String(body.currency || 'NGN').toUpperCase();

  if (!endCountryCode || (!checkoutQuote && !startCountryCode)) {
    return res.status(200).json({ ok: false, error: 'Choose a supported delivery country before checking shipping.' });
  }
  if (!products.length || products.some(p => !p || !p.vid)) {
    return res.status(200).json({ ok: false, error: 'Provide at least one product with a variant id.' });
  }
  if (checkoutQuote && (!['NGN', 'USD'].includes(currency) || products.length !== 1)) {
    return res.status(200).json({ ok: false, error: 'The checkout shipping request is invalid. Refresh and try again.' });
  }

  const started = Date.now();
  try {
    let db = null;
    let settingsDoc = {};
    let product = null;
    let selection = null;
    let productVariantId = null;
    let policy = getCommercePricingPolicy({});
    if (checkoutQuote) {
      db = getDb();
      const [productsSnap, settingsSnap] = await Promise.all([
        db.doc('catalog/products').get(),
        db.doc('catalog/settings').get(),
      ]);
      const productsData = productsSnap.exists ? productsSnap.data() || {} : {};
      settingsDoc = settingsSnap.exists ? settingsSnap.data() || {} : {};
      const catalogList = Array.isArray(productsData.list) ? productsData.list : [];
      product = catalogList.find(p => p && String(p.id) === String(body.productId));
      if (!product || product.status !== 'published' || product.productType !== 'PHYSICAL' || !product.physical || !product.physical.cj) {
        return res.status(200).json({ ok: false, error: 'This physical item is not available for supplier shipping checkout.' });
      }
      const variantId = body.variantId == null ? null : String(body.variantId);
      selection = resolveProductSelection(product, variantId, currency, settingsDoc);
      if (!selection) {
        return res.status(200).json({ ok: false, error: 'Choose an available product option and refresh shipping.' });
      }
      productVariantId = selection.variant && selection.variant.cjVariantId
        ? String(selection.variant.cjVariantId)
        : String(product.physical.cj.variantId || '');
      if (!productVariantId || String(products[0].vid) !== productVariantId) {
        return res.status(200).json({ ok: false, error: 'The selected product option changed. Refresh the shipping quote.' });
      }
      const mappedCountry = new Set((product.physical.shippingCountries || []).map(countryToIso2).filter(Boolean));
      if (mappedCountry.size && !mappedCountry.has(endCountryCode)) {
        return res.status(200).json({ ok: false, error: 'This product is not configured for delivery to that country.' });
      }
      policy = getCommercePricingPolicy(settingsDoc);
    }

    // For storefront checkout, derive origin countries from the LIVE warehouse
    // inventory for the exact selected variant. Never trust the browser's origin.
    let sourceCountryCodes = [startCountryCode];
    if (checkoutQuote) {
      const stockR = await cjFetch('/product/stock/queryByVid', { query: { vid: productVariantId } });
      if (!stockR.ok) {
        await writeSyncLog({ event: 'shipping.calc', success: false, message: 'Could not verify live warehouse inventory before freight quote', tookMs: Date.now() - started, detail: { productId: product.id, variantId: productVariantId, code: stockR.code || null } });
        return res.status(200).json({ ok: false, error: 'Live stock location could not be verified. No payment has been taken; please retry.' });
      }
      const stockRows = stockRowsFromResponse(stockR.data);
      sourceCountryCodes = [...new Set(stockRows
        .filter(row => {
          const qty = stockQuantity(row);
          return qty != null && qty > 0 && stockOriginCountry(row);
        })
        .map(stockOriginCountry))];

      // Fallback only to supplier-origin metadata, never to a client-supplied origin.
      if (!sourceCountryCodes.length) {
        const catalogOrigin = countryToIso2(product.physical.cj.sourceCountry || product.physical.sourceCountry);
        if (catalogOrigin && stockRows.some(row => {
          const qty = stockQuantity(row);
          return qty != null && qty > 0;
        })) sourceCountryCodes = [catalogOrigin];
      }
      if (!sourceCountryCodes.length) {
        await writeSyncLog({ event: 'shipping.calc', success: false, message: 'No verifiable stocked warehouse origin for this CJ variant', tookMs: Date.now() - started, detail: { productId: product.id, variantId: productVariantId } });
        return res.status(200).json({ ok: false, error: 'NOVA could not verify a stocked shipping origin for this variant. No payment has been taken.' });
      }

      // Query a bounded number of origins, preferring Nigeria if it really has stock.
      sourceCountryCodes.sort((a, b) => (a === endCountryCode ? -1 : b === endCountryCode ? 1 : 0));
      sourceCountryCodes = sourceCountryCodes.slice(0, 5);
    }

    const freightResults = await Promise.all(sourceCountryCodes.map(async origin => ({
      origin,
      result: await cjFetch('/logistic/freightCalculate', {
        method: 'POST',
        body: {
          startCountryCode: origin,
          endCountryCode,
          products: products.map(p => ({
            vid: String(p.vid),
            quantity: Math.max(1, parseInt(p.quantity, 10) || 1),
          })),
        },
      }),
    })));
    const tookMs = Date.now() - started;
    const successfulResults = freightResults.filter(entry => entry.result && entry.result.ok);
    if (!successfulResults.length) {
      const firstFailure = freightResults.find(entry => entry.result && !entry.result.ok);
      const errorCode = firstFailure && firstFailure.result.code;
      await writeSyncLog({
        event: 'shipping.calc',
        success: false,
        message: firstFailure && firstFailure.result.message || 'No freight calculation succeeded',
        tookMs,
        detail: { endCountryCode, products, checkoutQuote, sourceCountryCodes },
      });
      return res.status(200).json({
        ok: false,
        error: errorCode === 'RATE_LIMITED'
          ? 'Shipping is busy right now. Please try again in a moment.'
          : 'No valid shipping method was returned for this destination and stocked origin.',
      });
    }

    const raw = successfulResults.flatMap(entry => {
      const data = entry.result.data;
      const rows = Array.isArray(data) ? data : (data && data.list) || [];
      return rows.map(option => ({ ...option, startCountryCode: entry.origin }));
    });
    let options = raw.map(o => ({
      logisticName: String(o.logisticName || o.logisticNameEn || ''),
      logisticPrice: o.logisticPrice != null ? Number(o.logisticPrice) : null,
      currency: 'USD',
      logisticAging: o.logisticAging || o.aging || null,
      startCountryCode: countryToIso2(o.startCountryCode) || startCountryCode,
    })).filter(o => o.logisticName && o.logisticPrice != null && Number.isFinite(o.logisticPrice) && o.logisticPrice >= 0);

    if (!options.length) {
      await writeSyncLog({ event: 'shipping.calc', success: true, message: '0 valid options', tookMs, detail: { endCountryCode } });
      return res.status(200).json({ ok: false, error: 'No valid shipping method was returned for this destination.' });
    }

    if (checkoutQuote) {
      const quoteTtlMs = policy.shipping.quoteTtlMinutes * 60 * 1000;
      const createdAt = new Date();
      const expiresAt = new Date(createdAt.getTime() + quoteTtlMs);
      const displayRate = rateForCurrency(settingsDoc, currency);
      const productAmountUSD = currency === 'USD'
        ? Number(selection.price)
        : (displayRate ? Number(selection.price) / displayRate : null);
      options = selectShippingServices(options, settingsDoc, {
        productAmountUSD,
        productAmountMajor: Number(selection.price),
        currency,
        processingDays: policy.shipping.processingDays,
      });
      if (!options.length) {
        await writeSyncLog({
          event: 'shipping.calc',
          success: true,
          message: 'No route meets NOVA service-level, speed and affordability rules',
          tookMs: Date.now() - started,
          detail: { endCountryCode, productId: product.id, currency, rawRouteCount: raw.length },
        });
        return res.status(200).json({
          ok: false,
          error: 'No delivery option currently meets NOVA’s speed and affordability rules for this product. Choose another item or contact support.',
        });
      }
      const quoteOptions = [];
      for (const option of options) {
        const shippingAmountMajor = calculateShippingCharge(option.logisticPrice, currency, settingsDoc);
        if (shippingAmountMajor == null) continue;
        const productAmountMajor = Number(selection.price);
        const ratio = shippingRatio(shippingAmountMajor, productAmountMajor);
        // Recheck after FX and payment-fee buffers. Do not send checkout options
        // that already violate the shopper-facing affordability cap.
        if (policy.shipping.enforceShippingRatioBlock && ratio !== null
          && ratio >= policy.shipping.highShippingItemPriceRatioBlock) continue;
        const quoteId = crypto.randomUUID();
        const totalAmountMajor = roundTotal(productAmountMajor + shippingAmountMajor, currency);
        const blockedByPricingPolicy = false;
        const quoteData = {
          quoteId,
          status: 'open',
          blockedByPricingPolicy,
          shippingRatio: ratio,
          productId: String(product.id),
          variantId: selection.variantId || null,
          cjVariantId: productVariantId,
          quantity: 1,
          currency,
          productAmountMajor,
          shippingAmountMajor,
          totalAmountMajor,
          shippingAmountUSD: option.logisticPrice,
          logisticName: option.logisticName,
          logisticAging: option.logisticAging,
          serviceLevel: option.serviceLevel,
          serviceLabel: option.serviceLabel,
          deliveryEstimate: option.deliveryEstimate,
          estimatedOrderToDoorMinDays: option.estimatedOrderToDoorMinDays,
          estimatedOrderToDoorMaxDays: option.estimatedOrderToDoorMaxDays,
          processingAllowanceDays: option.processingAllowanceDays,
          requiresExplicitChoice: option.requiresExplicitChoice === true,
          serviceRationale: option.serviceRationale || null,
          startCountryCode: option.startCountryCode || startCountryCode,
          endCountryCode,
          createdAt,
          expiresAt,
        };
        await db.collection('shippingQuotes').doc(quoteId).create(quoteData);
        quoteOptions.push({
          ...option,
          quoteId,
          currency,
          productAmountMajor,
          shippingAmountMajor,
          totalAmountMajor,
          shippingRatio: ratio,
          blockedByPricingPolicy,
          quoteExpiresAt: expiresAt.toISOString(),
        });
      }
      if (!quoteOptions.length) {
        return res.status(200).json({
          ok: false,
          error: 'No route meets NOVA’s delivery and affordability rules after fees and currency conversion. Choose a locally stocked alternative or another product.',
        });
      }
      await writeSyncLog({
        event: 'shipping.calc',
        success: true,
        message: `${quoteOptions.length} checkout options quoted`,
        tookMs: Date.now() - started,
        detail: { endCountryCode, productId: product.id, currency, quoteCount: quoteOptions.length },
      });
      return res.status(200).json({ ok: true, currency, productAmountMajor: selection.price, quoteExpiresAt: expiresAt.toISOString(), options: quoteOptions });
    }

    const genericSettings = (() => {
      try { return settingsDoc; } catch { return {}; }
    })();
    options = sortShippingOptions(options, genericSettings);
    await writeSyncLog({ event: 'shipping.calc', success: true, message: `${options.length} options`, tookMs: Date.now() - started, detail: { endCountryCode } });
    return res.status(200).json({ ok: true, options });
  } catch (e) {
    await writeSyncLog({ event: 'shipping.calc', success: false, message: e.message, tookMs: Date.now() - started });
    return res.status(200).json({ ok: false, error: 'Shipping calculation failed. No payment has been taken.' });
  }
};

module.exports.stockRowsFromResponse = stockRowsFromResponse;
module.exports.stockQuantity = stockQuantity;
module.exports.stockOriginCountry = stockOriginCountry;
