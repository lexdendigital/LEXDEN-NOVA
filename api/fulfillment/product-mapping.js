'use strict';

const PROVIDER_KEY = /^[a-z][a-z0-9_-]{1,63}$/;
const MAPPING_STATES = new Set(['MAPPED', 'NEEDS_REVIEW', 'DISABLED', 'LEGACY_COMPATIBILITY']);

function clean(value, max = 180) {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
}

function validPositiveNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeSupplierVariantMapping(input) {
  const source = input && typeof input === 'object' ? input : {};
  const novaVariantId = clean(source.novaVariantId, 180);
  const externalVariantId = clean(source.externalVariantId, 180);
  const cost = validPositiveNumber(source.supplierCost);
  const currency = clean(source.supplierCurrency, 3).toUpperCase();
  const origin = clean(source.sourceCountryCode, 2).toUpperCase();

  if (!novaVariantId || !externalVariantId) {
    throw Object.assign(new Error('Each supplier variant mapping requires NOVA and external variant IDs.'), { code: 'INVALID_VARIANT_MAPPING' });
  }
  if (currency && !/^[A-Z]{3}$/.test(currency)) {
    throw Object.assign(new Error('Supplier variant currency must be a three-letter ISO currency code.'), { code: 'INVALID_SUPPLIER_CURRENCY' });
  }
  if (origin && !/^[A-Z]{2}$/.test(origin)) {
    throw Object.assign(new Error('Supplier source country must be an ISO-2 country code.'), { code: 'INVALID_SOURCE_COUNTRY' });
  }

  return {
    novaVariantId,
    externalVariantId,
    supplierSku: clean(source.supplierSku, 120) || null,
    supplierCost: cost,
    supplierCurrency: currency || null,
    sourceWarehouse: clean(source.sourceWarehouse, 120) || null,
    sourceCountryCode: origin || null,
    lastStockVerifiedAt: clean(source.lastStockVerifiedAt, 80) || null,
    lastPriceVerifiedAt: clean(source.lastPriceVerifiedAt, 80) || null,
    status: MAPPING_STATES.has(source.status) ? source.status : 'NEEDS_REVIEW',
    approvedForFulfillment: source.approvedForFulfillment === true,
  };
}

function buildSupplierMapping(input = {}) {
  const supplierId = clean(input.supplierId, 180);
  const providerKey = clean(input.providerKey, 64);
  const externalProductId = clean(input.externalProductId, 180);
  if (!supplierId) throw Object.assign(new Error('NOVA supplier registry ID is required.'), { code: 'SUPPLIER_ID_REQUIRED' });
  if (!PROVIDER_KEY.test(providerKey)) throw Object.assign(new Error('Stable provider key is invalid.'), { code: 'INVALID_PROVIDER_KEY' });
  if (!externalProductId) throw Object.assign(new Error('External supplier product ID is required.'), { code: 'EXTERNAL_PRODUCT_ID_REQUIRED' });

  const cost = validPositiveNumber(input.supplierCost);
  const currency = clean(input.supplierCurrency, 3).toUpperCase();
  const origin = clean(input.sourceCountryCode, 2).toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw Object.assign(new Error('Supplier currency must be a three-letter ISO currency code.'), { code: 'INVALID_SUPPLIER_CURRENCY' });
  if (origin && !/^[A-Z]{2}$/.test(origin)) throw Object.assign(new Error('Supplier source country must be an ISO-2 country code.'), { code: 'INVALID_SOURCE_COUNTRY' });

  const variants = (Array.isArray(input.variantMappings) ? input.variantMappings : []).map(normalizeSupplierVariantMapping);
  const novaIds = variants.map(v => v.novaVariantId);
  const externalIds = variants.map(v => v.externalVariantId);
  if (new Set(novaIds).size !== novaIds.length || new Set(externalIds).size !== externalIds.length) {
    throw Object.assign(new Error('Supplier variant mappings must not contain duplicate NOVA or external variant IDs.'), { code: 'DUPLICATE_VARIANT_MAPPING' });
  }

  const state = MAPPING_STATES.has(input.status) ? input.status : (variants.length ? 'MAPPED' : 'NEEDS_REVIEW');
  const approved = input.approvedForFulfillment === true;
  if (approved && state !== 'MAPPED') {
    throw Object.assign(new Error('Only a complete MAPPED supplier mapping can be approved for fulfillment.'), { code: 'MAPPING_NOT_APPROVABLE' });
  }

  return {
    supplierId,
    providerKey,
    externalProductId,
    externalVariantId: clean(input.externalVariantId, 180) || null,
    supplierSku: clean(input.supplierSku, 120) || null,
    supplierCost: cost,
    supplierCurrency: currency || null,
    sourceWarehouse: clean(input.sourceWarehouse, 120) || null,
    sourceCountryCode: origin || null,
    lastStockVerifiedAt: clean(input.lastStockVerifiedAt, 80) || null,
    lastPriceVerifiedAt: clean(input.lastPriceVerifiedAt, 80) || null,
    status: state,
    approvedForFulfillment: approved,
    variantMappings: variants,
  };
}

function resolveRegisteredSupplier(suppliers, providerKey) {
  const key = clean(providerKey, 64);
  if (!PROVIDER_KEY.test(key)) return { ok: false, code: 'INVALID_PROVIDER_KEY', supplier: null };
  const matches = (Array.isArray(suppliers) ? suppliers : []).filter(s =>
    s && s.active !== false && clean(s.providerKey, 64) === key && clean(s.id, 180)
  );
  if (!matches.length) return { ok: false, code: 'PROVIDER_SUPPLIER_NOT_REGISTERED', supplier: null };
  if (matches.length > 1) return { ok: false, code: 'PROVIDER_SUPPLIER_AMBIGUOUS', supplier: null };
  return { ok: true, code: null, supplier: matches[0] };
}

function resolveSupplierMapping(product, supplierId, providerKey, novaVariantId, options = {}) {
  const physical = product && product.physical || {};
  const mappings = Array.isArray(physical.supplierMappings) ? physical.supplierMappings : [];
  const matches = mappings.filter(m =>
    m && String(m.supplierId || '') === String(supplierId || '')
    && String(m.providerKey || '') === String(providerKey || '')
  );
  if (matches.length > 1) return { ok: false, code: 'AMBIGUOUS_SUPPLIER_MAPPING' };
  if (!matches.length) {
    if (options.allowLegacyCj === true && providerKey === 'cj' && physical.cj && physical.cj.productId
      && String(physical.supplierId || '') === String(supplierId || '')) {
      const legacyVariant = (Array.isArray(product.variants) ? product.variants : [])
        .find(v => String(v && v.id || '') === String(novaVariantId || ''));
      const externalVariantId = legacyVariant && legacyVariant.cjVariantId
        ? legacyVariant.cjVariantId
        : physical.cj.variantId;
      if (!externalVariantId) return { ok: false, code: 'VARIANT_MAPPING_MISSING' };
      return {
        ok: true,
        legacy: true,
        mapping: {
          supplierId, providerKey: 'cj', externalProductId: String(physical.cj.productId),
          externalVariantId: String(externalVariantId), supplierSku: (legacyVariant && legacyVariant.sku) || physical.cj.sku || null,
          supplierCost: physical.supplierCost ?? null, supplierCurrency: physical.supplierCurrency || null,
          status: 'LEGACY_COMPATIBILITY', approvedForFulfillment: true,
        },
        variantMapping: legacyVariant ? { novaVariantId: String(legacyVariant.id), externalVariantId: String(externalVariantId) } : null,
      };
    }
    return { ok: false, code: 'SUPPLIER_MAPPING_MISSING' };
  }

  const mapping = matches[0];
  if (mapping.status !== 'MAPPED') return { ok: false, code: 'SUPPLIER_MAPPING_NOT_READY' };
  if (mapping.approvedForFulfillment !== true) return { ok: false, code: 'SUPPLIER_MAPPING_NOT_APPROVED' };
  let variantMapping = null;
  if (novaVariantId) {
    variantMapping = (Array.isArray(mapping.variantMappings) ? mapping.variantMappings : [])
      .find(v => String(v && v.novaVariantId || '') === String(novaVariantId));
    if (!variantMapping) return { ok: false, code: 'VARIANT_MAPPING_MISSING' };
  } else if (Array.isArray(mapping.variantMappings) && mapping.variantMappings.length === 1) {
    variantMapping = mapping.variantMappings[0];
  } else if (Array.isArray(mapping.variantMappings) && mapping.variantMappings.length > 1) {
    return { ok: false, code: 'VARIANT_SELECTION_REQUIRED' };
  }

  return { ok: true, legacy: false, mapping, variantMapping };
}

function buildLegacyCjMappingPreview(product, supplier) {
  const physical = product && product.physical || {};
  const cj = physical.cj || {};
  if (!cj.productId) return { ok: false, code: 'CJ_MAPPING_MISSING' };
  if (!supplier || !supplier.id || supplier.providerKey !== 'cj') return { ok: false, code: 'CJ_SUPPLIER_NOT_RESOLVED' };

  const variants = (Array.isArray(product.variants) ? product.variants : [])
    .filter(v => v && v.id && v.cjVariantId)
    .map(v => ({
      novaVariantId: String(v.id),
      externalVariantId: String(v.cjVariantId),
      supplierSku: v.sku || null,
      supplierCost: validPositiveNumber(v.supplierCost ?? physical.supplierCost),
      supplierCurrency: clean(v.supplierCurrency || physical.supplierCurrency, 3).toUpperCase() || null,
      sourceWarehouse: clean(cj.sourceCountry || physical.sourceCountry, 120) || null,
      sourceCountryCode: /^[A-Za-z]{2}$/.test(String(cj.sourceCountry || physical.sourceCountry || '')) ? String(cj.sourceCountry || physical.sourceCountry).toUpperCase() : null,
      lastStockVerifiedAt: cj.lastSyncedAt || null,
      lastPriceVerifiedAt: null,
      status: 'NEEDS_REVIEW',
      approvedForFulfillment: false,
    }));

  const existingSupplierId = clean(physical.supplierId, 180);
  if (existingSupplierId && existingSupplierId !== String(supplier.id)) {
    return { ok: false, code: 'CONFLICTING_SUPPLIER_ID', proposedSupplierId: supplier.id };
  }

  return {
    ok: true,
    supplierId: String(supplier.id),
    mapping: buildSupplierMapping({
      supplierId: supplier.id,
      providerKey: 'cj',
      externalProductId: cj.productId,
      externalVariantId: cj.variantId || null,
      supplierSku: physical.supplierSku || cj.sku || null,
      supplierCost: physical.supplierCost,
      supplierCurrency: physical.supplierCurrency,
      sourceWarehouse: cj.sourceCountry || physical.sourceCountry || null,
      sourceCountryCode: /^[A-Za-z]{2}$/.test(String(cj.sourceCountry || physical.sourceCountry || '')) ? String(cj.sourceCountry || physical.sourceCountry).toUpperCase() : null,
      lastStockVerifiedAt: cj.lastSyncedAt || null,
      lastPriceVerifiedAt: null,
      status: variants.length ? 'NEEDS_REVIEW' : 'NEEDS_REVIEW',
      approvedForFulfillment: false,
      variantMappings: variants,
    }),
  };
}

function previewSupplierMappingMigration(products, suppliers) {
  const counts = {
    physicalProducts: 0,
    alreadyMapped: 0,
    safeLegacyCjCandidates: 0,
    ambiguousCjSupplier: 0,
    unresolvedCjSupplier: 0,
    conflictingSupplierIds: 0,
    noSupplierMapping: 0,
  };
  const cjSupplierResult = resolveRegisteredSupplier(suppliers, 'cj');
  const proposals = [];

  for (const product of Array.isArray(products) ? products : []) {
    if (!product || String(product.productType || '').toUpperCase() !== 'PHYSICAL') continue;
    counts.physicalProducts += 1;
    const mappings = product.physical && Array.isArray(product.physical.supplierMappings)
      ? product.physical.supplierMappings : [];
    if (mappings.length) {
      counts.alreadyMapped += 1;
      continue;
    }
    const physical = product.physical || {};
    if (!physical.cj || !physical.cj.productId) {
      counts.noSupplierMapping += 1;
      proposals.push({ productId: product.id || null, status: 'NO_SUPPLIER_MAPPING' });
      continue;
    }
    if (!cjSupplierResult.ok) {
      if (cjSupplierResult.code === 'PROVIDER_SUPPLIER_AMBIGUOUS') counts.ambiguousCjSupplier += 1;
      else counts.unresolvedCjSupplier += 1;
      proposals.push({ productId: product.id || null, status: cjSupplierResult.code });
      continue;
    }
    const proposed = buildLegacyCjMappingPreview(product, cjSupplierResult.supplier);
    if (!proposed.ok) {
      if (proposed.code === 'CONFLICTING_SUPPLIER_ID') counts.conflictingSupplierIds += 1;
      else counts.unresolvedCjSupplier += 1;
      proposals.push({ productId: product.id || null, status: proposed.code });
      continue;
    }
    counts.safeLegacyCjCandidates += 1;
    proposals.push({
      productId: product.id || null,
      status: 'SAFE_LEGACY_CJ_CANDIDATE_REQUIRES_REVIEW',
      supplierId: proposed.supplierId,
      mapping: proposed.mapping,
    });
  }

  return {
    dryRun: true,
    writesPerformed: 0,
    counts,
    proposals,
  };
}

module.exports = {
  PROVIDER_KEY,
  MAPPING_STATES,
  buildSupplierMapping,
  resolveRegisteredSupplier,
  resolveSupplierMapping,
  buildLegacyCjMappingPreview,
  previewSupplierMappingMigration,
};
