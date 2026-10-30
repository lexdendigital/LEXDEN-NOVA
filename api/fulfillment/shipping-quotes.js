'use strict';

const crypto = require('node:crypto');
const { resolveProductSelection } = require('../product-variants');
const { getCommercePricingPolicy, rateForCurrency, calculateShippingCharge } = require('../commerce-pricing');
const { resolveRegisteredSupplier, resolveSupplierMapping } = require('./product-mapping');
const { getShippingPolicy, conservativeDeliveryDays, evaluateShippingPolicy } = require('./policy');

const clean = (value, max = 180) => value == null ? '' : String(value).trim().slice(0, max);

function iso2(value) {
  const text = clean(value, 80);
  if (/^[A-Za-z]{2}$/.test(text)) return text.toUpperCase();
  return ({
    nigeria: 'NG', ghana: 'GH', kenya: 'KE', 'south africa': 'ZA',
    china: 'CN', poland: 'PL', germany: 'DE', france: 'FR',
    netherlands: 'NL', italy: 'IT', spain: 'ES', 'united kingdom': 'GB',
    uk: 'GB', 'united states': 'US', 'united states of america': 'US',
    canada: 'CA', india: 'IN', turkey: 'TR', australia: 'AU',
  })[text.toLowerCase()] || null;
}

function toUsd(amount, currency, settings) {
  const n = Number(amount);
  const code = clean(currency, 3).toUpperCase();
  if (!Number.isFinite(n) || n < 0 || !/^[A-Z]{3}$/.test(code)) return null;
  const rate = rateForCurrency(settings, code);
  return Number.isFinite(Number(rate)) && Number(rate) > 0 ? n / Number(rate) : null;
}

function routeIds(product) {
  const physical = product && product.physical || {};
  const routing = physical.routing || {};
  if (physical.routing && routing.active === false) return { disabled: true, ids: [] };

  const ids = [];
  const add = value => {
    const id = clean(value);
    if (id && !ids.includes(id)) ids.push(id);
  };

  add(routing.primarySupplierId);
  add(routing.backupSupplierId);
  for (const mapping of Array.isArray(physical.supplierMappings) ? physical.supplierMappings : []) {
    add(mapping && mapping.supplierId);
  }
  add(physical.supplierId);
  return { disabled: false, ids };
}

function destinationAllowed(supplier, countryCode) {
  const countries = Array.isArray(supplier.supportedCountries)
    ? supplier.supportedCountries
    : Array.isArray(supplier.countries) ? supplier.countries : [];
  return !countries.length || countries.some(item =>
    iso2(item && typeof item === 'object' ? (item.countryCode || item.code || item.name) : item) === countryCode
  );
}

function warehouseRows(data, mapping, quantity) {
  const rows = Array.isArray(data && data.warehouses) ? data.warehouses : [];
  if (!rows.length && Number.isFinite(Number(data && data.availableQuantity))) {
    const available = Number(data.availableQuantity);
    const country = iso2(mapping.sourceCountryCode);
    return available >= quantity && country ? [{ countryCode: country, warehouse: null, quantity: available }] : [];
  }
  return rows.flatMap(row => {
    if (!row || typeof row !== 'object') return [];
    const available = Number(row.quantity ?? row.availableQuantity ?? row.stock ?? row.qty);
    if (!Number.isFinite(available) || available < quantity) return [];
    const country = iso2(
      row.countryCode || row.sourceCountryCode || row.originCountryCode ||
      row.country || row.area || row.warehouseCountryCode
    ) || iso2(mapping.sourceCountryCode);
    if (!country) return [];
    return [{
      countryCode: country,
      warehouse: clean(row.warehouseId || row.warehouseCode || row.warehouse || row.name, 120) || null,
      quantity: available,
    }];
  }).sort((a, b) => b.quantity - a.quantity);
}

function supplierCost(mapping, variantMapping, physical, settings) {
  const selected = variantMapping || mapping || {};
  const amount = selected.supplierCost ?? mapping.supplierCost ?? physical.supplierCost;
  const currency = selected.supplierCurrency || mapping.supplierCurrency || physical.supplierCurrency;
  if (amount == null || amount === '') return null;
  const usd = toUsd(amount, currency, settings);
  return usd == null ? null : { amount: Number(amount), currency: clean(currency, 3).toUpperCase(), usd };
}

function deliverySettings(settings) {
  const root = settings && settings.content ? settings.content : (settings || {});
  const saved = root.commercePricingPolicy || {};
  const shipping = saved.shipping || {};
  return {
    max: 15,
    settings: {
      ...settings,
      content: {
        ...root,
        commercePricingPolicy: {
          ...saved,
          shipping: { ...shipping, maxDeliveryDays: 15, allowEconomyOverMaxDays: false },
        },
      },
    },
  };
}

function quotePrecision(input, providerKey) {
  if (providerKey === 'cj') return 'COUNTRY';
  if (clean(input.destinationAddress1 || input.address1, 240)) return 'ADDRESS';
  if (clean(input.destinationPostalCode || input.postalCode, 32)) return 'POSTAL_CODE';
  if (clean(input.destinationCity || input.city, 120) || clean(input.destinationRegion || input.region, 120)) return 'CITY_REGION';
  return 'COUNTRY';
}

function routeScore(candidate) {
  const reliability = Number(candidate.supplier.reliabilityScore);
  const failureRate = Number(candidate.supplier.failureRate);
  const reliabilityPenalty = Number.isFinite(reliability)
    ? (100 - Math.max(0, Math.min(100, reliability))) / 20
    : 2.5;
  const failurePenalty = Number.isFinite(failureRate) ? Math.max(0, failureRate) * 10 : 0;
  const localBonus = candidate.startCountryCode === candidate.destination.countryCode ? -3 : 0;
  const trackingBonus = candidate.trackingCapable ? -0.75 : 0;
  return candidate.totalSupplierCostUSD
    + candidate.totalMaxDeliveryDays * 0.35
    + reliabilityPenalty
    + failurePenalty
    + localBonus
    + trackingBonus;
}

function createShippingQuoteService(options = {}) {
  const registry = options.registry || require('./registry');
  const getDb = options.getDb || require('../affiliate/shared').getDb;
  const now = options.now || (() => new Date());
  const createId = options.createId || (() => crypto.randomUUID());

  async function quote(input = {}) {
    const productId = clean(input.productId);
    const variantId = clean(input.variantId) || null;
    const quantity = input.quantity == null ? 1 : Number(input.quantity);
    const destinationCode = iso2(input.destinationCountryCode || input.countryCode);
    const currency = clean(input.currency || 'NGN', 3).toUpperCase();
    const destination = {
      countryCode: destinationCode,
      region: clean(input.destinationRegion || input.region, 120) || null,
      city: clean(input.destinationCity || input.city, 120) || null,
      postalCode: clean(input.destinationPostalCode || input.postalCode, 32) || null,
      address1: clean(input.destinationAddress1 || input.address1, 240) || null,
    };

    if (!productId) return { ok: false, code: 'PRODUCT_ID_REQUIRED', error: 'A product is required for a delivery quote.' };
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) return { ok: false, code: 'INVALID_QUANTITY', error: 'Enter a valid product quantity.' };
    if (!destinationCode) return { ok: false, code: 'INVALID_DESTINATION', error: 'A valid destination country is required.' };
    if (!['NGN', 'USD'].includes(currency)) return { ok: false, code: 'UNSUPPORTED_CURRENCY', error: 'Choose a supported checkout currency.' };

    const db = getDb();
    const [productsSnap, settingsSnap] = await Promise.all([
      db.doc('catalog/products').get(),
      db.doc('catalog/settings').get(),
    ]);
    const productsDoc = productsSnap.exists ? productsSnap.data() || {} : {};
    const settings = settingsSnap.exists ? settingsSnap.data() || {} : {};
    const products = Array.isArray(productsDoc.list) ? productsDoc.list : [];
    const suppliers = Array.isArray(settings.suppliers) ? settings.suppliers : [];
    const product = products.find(p => p && String(p.id) === productId);

    if (!product || product.status !== 'published' || String(product.productType || '').toUpperCase() !== 'PHYSICAL') {
      return { ok: false, code: 'PRODUCT_NOT_AVAILABLE', error: 'This physical product is not available for delivery.' };
    }

    const selection = resolveProductSelection(product, variantId, currency, settings);
    if (!selection || !Number.isFinite(Number(selection.basePrice))) {
      return { ok: false, code: 'VARIANT_NOT_AVAILABLE', error: 'Choose an available product option before requesting delivery.' };
    }

    const physical = product.physical || {};
    const routing = physical.routing || {};
    const route = routeIds(product);
    if (route.disabled) return { ok: false, code: 'ROUTING_DISABLED', error: 'Supplier routing is disabled for this product.' };

    let ids = route.ids;
    if (!ids.length && physical.cj && physical.cj.productId) {
      const cj = resolveRegisteredSupplier(suppliers, 'cj');
      if (cj.ok) ids = [String(cj.supplier.id)];
    }
    if (!ids.length) return { ok: false, code: 'NO_AUTOMATED_SUPPLIER_ROUTE', error: 'This product has no configured automated supplier route.' };

    const policy = getShippingPolicy(settings);
    const commerce = getCommercePricingPolicy(settings);
    const candidates = [];
    const rejectedRoutes = [];

    await Promise.all(ids.map(async supplierId => {
      const reject = (reason, detail = {}) => rejectedRoutes.push({ supplierId, reason, ...detail });
      const supplier = suppliers.find(s => s && String(s.id) === supplierId);
      if (!supplier || supplier.active === false) return reject('SUPPLIER_DISABLED');

      const providerKey = clean(supplier.providerKey, 64);
      if (!providerKey) return reject('MAPPING_INVALID');

      for (const capability of ['checkStock', 'quoteShipping', 'createOrder']) {
        if (!registry.hasProviderCapability(providerKey, capability)) {
          return reject('CAPABILITY_UNAVAILABLE', { providerKey, capability });
        }
      }

      if (!destinationAllowed(supplier, destinationCode)) return reject('DESTINATION_UNSUPPORTED', { providerKey });

      const resolved = resolveSupplierMapping(product, supplierId, providerKey, selection.variantId, { allowLegacyCj: providerKey === 'cj' });
      if (!resolved.ok) return reject(resolved.code || 'MAPPING_INVALID', { providerKey });

      const mapping = resolved.mapping;
      const variantMapping = resolved.variantMapping;
      const externalVariantId = clean(variantMapping && variantMapping.externalVariantId || mapping.externalVariantId);
      if (!externalVariantId) return reject('MAPPING_INVALID', { providerKey });

      const cost = supplierCost(mapping, variantMapping, physical, settings);
      if (!cost) return reject('PRICE_UNVERIFIED', { providerKey });
      const productCostUsd = cost.usd * quantity;

      const health = await registry.checkProviderHealth(providerKey, { purpose: 'checkout_quote', supplierId });
      if (!health || !health.ok) return reject('API_UNAVAILABLE', { providerKey });

      const stock = await registry.callProvider(providerKey, 'checkStock', {
        externalProductId: mapping.externalProductId,
        externalVariantId,
        quantity,
        destination,
      }, { purpose: 'checkout_quote', supplierId });

      if (!stock || !stock.ok || !stock.data) return reject('STOCK_UNVERIFIED', { providerKey });

      const warehouses = warehouseRows(stock.data, mapping, quantity);
      if (!warehouses.length) return reject('OUT_OF_STOCK', { providerKey });

      const freight = [];
      await Promise.all(warehouses.slice(0, 5).map(async warehouse => {
        const response = await registry.callProvider(providerKey, 'quoteShipping', {
          externalProductId: mapping.externalProductId,
          externalVariantId,
          quantity,
          originCountryCode: warehouse.countryCode,
          destinationCountryCode: destinationCode,
          sourceWarehouse: warehouse.warehouse,
          destinationRegion: destination.region,
          destinationCity: destination.city,
          destinationPostalCode: destination.postalCode,
          destinationAddress1: destination.address1,
        }, { purpose: 'checkout_quote', supplierId });

        if (!response || !response.ok || !response.data || !Array.isArray(response.data.options)) return;

        for (const option of response.data.options) {
          const method = clean(option.shippingMethod || option.logisticName, 160);
          const supplierAmount = Number(option.supplierShippingCost ?? option.logisticPrice);
          const supplierCurrency = clean(option.currency || option.supplierShippingCurrency, 3).toUpperCase();
          const shippingUSD = toUsd(supplierAmount, supplierCurrency, settings);
          const totalMaxDeliveryDays = conservativeDeliveryDays(option, commerce.shipping.processingDays);
          if (!method || shippingUSD == null) continue;

          freight.push({
            logisticName: method,
            supplierShippingCost: supplierAmount,
            supplierShippingCurrency: supplierCurrency,
            supplierShippingCostUSD: shippingUSD,
            logisticAging: option.deliveryRange || option.logisticAging || null,
            totalMaxDeliveryDays,
            startCountryCode: warehouse.countryCode,
            sourceWarehouse: warehouse.warehouse,
            providerRequestId: response.requestId || null,
            quotePrecision: clean(option.quotePrecision, 32) || quotePrecision(input, providerKey),
          });
        }
      }));

      if (!freight.length) return reject('NO_SHIPPING_QUOTE', { providerKey });

      for (const freightOption of freight) {
        const gate = evaluateShippingPolicy({
          shippingUSD: freightOption.supplierShippingCostUSD,
          totalMaxDeliveryDays: freightOption.totalMaxDeliveryDays,
          stockVerified: true,
          shippingVerified: true,
          policy,
        });

        if (!gate.eligible) {
          for (const reason of gate.reasons) {
            reject(reason, {
              providerKey,
              shippingUSD: freightOption.supplierShippingCostUSD,
              totalMaxDeliveryDays: freightOption.totalMaxDeliveryDays,
            });
          }
          continue;
        }

        const totalSupplierCostUSD = productCostUsd + freightOption.supplierShippingCostUSD;
        const maxCost = routing.maxCost == null || routing.maxCost === '' ? null : Number(routing.maxCost);
        if (maxCost !== null && (!Number.isFinite(maxCost) || maxCost < 0 || totalSupplierCostUSD > maxCost)) {
          reject('MAX_COST_EXCEEDED', { providerKey });
          continue;
        }

        const shippingAmountMajor = calculateShippingCharge(freightOption.supplierShippingCostUSD, currency, settings);
        if (shippingAmountMajor == null) {
          reject('FX_UNAVAILABLE', { providerKey });
          continue;
        }

        const productAmountMajor = currency === 'NGN'
          ? Math.ceil(selection.price * quantity)
          : Math.round(selection.price * quantity * 100) / 100;
        const totalAmountMajor = currency === 'NGN'
          ? Math.ceil(productAmountMajor + shippingAmountMajor)
          : Math.round((productAmountMajor + shippingAmountMajor) * 100) / 100;

        const revenueUSD = selection.basePrice * quantity + freightOption.supplierShippingCostUSD;
        const margin = revenueUSD > 0 ? (revenueUSD - totalSupplierCostUSD) / revenueUSD * 100 : -Infinity;
        const minMargin = routing.minMargin == null || routing.minMargin === '' ? null : Number(routing.minMargin);
        if (minMargin !== null && (!Number.isFinite(minMargin) || minMargin < 0 || margin < minMargin)) {
          reject('MARGIN_TOO_LOW', { providerKey });
          continue;
        }

        const candidate = {
          supplier,
          providerKey,
          mapping,
          externalVariantId,
          destination,
          quantity,
          currency,
          productAmountMajor,
          shippingAmountMajor,
          totalAmountMajor,
          productCostUSD: productCostUsd,
          totalSupplierCostUSD,
          grossMarginPct: margin,
          trackingCapable: registry.hasProviderCapability(providerKey, 'getTracking'),
          ...freightOption,
        };
        candidate.score = routeScore(candidate);
        candidates.push(candidate);
      }
    }));

    if (!candidates.length) {
      return {
        ok: false,
        code: 'NO_ELIGIBLE_SUPPLIER',
        error: "This item currently has no delivery option to your address that meets LEXDEN NOVA's delivery requirements.",
        rejectedRoutes,
      };
    }

    candidates.sort((a, b) =>
      a.score - b.score ||
      a.totalSupplierCostUSD - b.totalSupplierCostUSD ||
      a.totalMaxDeliveryDays - b.totalMaxDeliveryDays
    );

    const best = candidates[0];
    const ttlMs = Math.min(getCommercePricingPolicy(settings).shipping.quoteTtlMinutes, 30) * 60 * 1000;
    const rawNow = now();
    const createdAt = rawNow instanceof Date ? rawNow : new Date(rawNow);
    const expiresAt = new Date(createdAt.getTime() + ttlMs);
    const quoteId = createId();

    const doc = {
      quoteId,
      status: 'open',
      productId,
      variantId: selection.variantId,
      supplierId: String(best.supplier.id),
      providerKey: best.providerKey,
      externalProductId: best.mapping.externalProductId,
      externalVariantId: best.externalVariantId,
      quantity,
      destination,
      endCountryCode: destinationCode,
      startCountryCode: best.startCountryCode,
      sourceWarehouse: best.sourceWarehouse,
      quotePrecision: best.quotePrecision,
      shippingMethod: best.logisticName,
      logisticName: best.logisticName,
      supplierShippingCost: best.supplierShippingCost,
      supplierShippingCurrency: best.supplierShippingCurrency,
      supplierShippingCostUSD: best.supplierShippingCostUSD,
      currency,
      productAmountMajor: best.productAmountMajor,
      shippingAmountMajor: best.shippingAmountMajor,
      customerShippingAmountMajor: best.shippingAmountMajor,
      totalAmountMajor: best.totalAmountMajor,
      shippingAmountUSD: best.supplierShippingCostUSD,
      logisticAging: best.logisticAging,
      estimatedOrderToDoorMaxDays: best.totalMaxDeliveryDays,
      serviceLevel: 'verified',
      serviceLabel: 'NOVA Verified Delivery',
      deliveryEstimate: best.totalMaxDeliveryDays + ' days or less',
      requiresExplicitChoice: false,
      grossMarginPct: best.grossMarginPct,
      policyMaxDeliveryDays: policy.maxDeliveryDays,
      policyMaxShippingUSD: policy.maxShippingUSD,
      routeScore: best.score,
      providerRequestId: best.providerRequestId,
      cjVariantId: best.providerKey === 'cj' ? best.externalVariantId : null,
      createdAt,
      expiresAt,
    };

    await db.collection('shippingQuotes').doc(quoteId).create(doc);

    return {
      ok: true,
      productId,
      variantId: selection.variantId,
      quantity,
      currency,
      selectedRoute: { supplierId: doc.supplierId, providerKey: doc.providerKey },
      eligibleRoutes: candidates.map(candidate => ({
        supplierId: String(candidate.supplier.id),
        providerKey: candidate.providerKey,
        shippingUSD: candidate.supplierShippingCostUSD,
        totalMaxDeliveryDays: candidate.totalMaxDeliveryDays,
        totalSupplierCostUSD: candidate.totalSupplierCostUSD,
        score: candidate.score,
      })),
      rejectedRoutes,
      productAmountMajor: doc.productAmountMajor,
      quoteExpiresAt: expiresAt.toISOString(),
      options: [{
        quoteId,
        supplierId: doc.supplierId,
        providerKey: doc.providerKey,
        shippingMethod: doc.shippingMethod,
        logisticName: doc.logisticName,
        currency,
        productAmountMajor: doc.productAmountMajor,
        shippingAmountMajor: doc.shippingAmountMajor,
        totalAmountMajor: doc.totalAmountMajor,
        sourceWarehouse: doc.sourceWarehouse,
        startCountryCode: doc.startCountryCode,
        destinationCountryCode: destinationCode,
        deliveryEstimate: doc.deliveryEstimate,
        estimatedOrderToDoorMaxDays: doc.estimatedOrderToDoorMaxDays,
        serviceLevel: doc.serviceLevel,
        serviceLabel: doc.serviceLabel,
        requiresExplicitChoice: false,
        quotePrecision: doc.quotePrecision,
        quoteExpiresAt: expiresAt.toISOString(),
      }],
    };
  }

  return Object.freeze({ quote });
}

module.exports = {
  iso2,
  toUsd,
  routeIds,
  destinationAllowed,
  warehouseRows,
  supplierCost,
  deliverySettings,
  routeScore,
  createShippingQuoteService,
};
