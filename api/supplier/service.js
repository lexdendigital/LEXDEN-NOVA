// api/supplier/service.js
//
// LEXDEN NOVA CREATOR — Stage G: the orchestration layer. Connects a
// creator's CJ account, tests a listing's CJ mapping, checks supplier health
// and pauses listings whose supplier side has broken.
//
// Pure rules live in ./mapping.js; Firestore in ./store.js; CJ calls in
// ./cj-client.js. This file only sequences them. Every function takes `db`
// and an optional `deps` ({ fetchImpl, pace, now }) so the whole flow runs in
// tests against a fake CJ and an in-memory database.
const { FieldValue } = require('../creator/shared');
const { PRODUCT_STATES, assertProductTransition, assertProductNotBlocked, isVersionEditable } = require('../creator/product-state-machine');
const { verifyCredentials } = require('./cj-client');
const {
  FULFILLMENT_MODES, MAPPING_MAX_AGE_MS,
  validateMappingInput, summarizeStockRows, normalizeVariant, normalizeFreightOptions,
  evaluateMapping, deriveHealth, assertDropshipReady, coded,
  isTransientCode, isAuthCode, pruneAttempts, isConnectRateLimited,
} = require('./mapping');
const store = require('./store');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ------------------------------------------------------------------ connect
async function connectCj(db, { uid, creator, email, apiKey, autoPay = false, autoPayConsent = false }, deps = {}) {
  if (!creator || creator.status !== 'ACTIVE') {
    throw coded('CJ dropshipping is available once your creator account is fully active (not restricted).', 'CREATOR_NOT_ELIGIBLE', 403);
  }
  const errors = [];
  if (typeof email !== 'string' || !EMAIL_RE.test(email.trim()) || email.length > 200) errors.push({ field: 'email', message: 'Enter the email address of your CJ account.' });
  if (typeof apiKey !== 'string' || apiKey.trim().length < 8 || apiKey.length > 256) errors.push({ field: 'apiKey', message: 'Enter your CJ API key.' });
  if (autoPay && autoPayConsent !== true) errors.push({ field: 'autoPayConsent', message: 'Automatic payment from your CJ balance needs your explicit consent.' });
  if (errors.length) throw coded('Please check the connection details.', 'VALIDATION_FAILED', 422, errors);

  const nowMs = (deps.now || Date.now)();
  const existing = await store.getConnection(db, uid);
  if (isConnectRateLimited(existing && existing.failedConnectAttempts, nowMs)) {
    throw coded('Too many failed attempts. Wait a few minutes and try again.', 'TOO_MANY_ATTEMPTS', 429);
  }

  const result = await verifyCredentials({ email: email.trim(), apiKey: apiKey.trim() }, { fetchImpl: deps.fetchImpl || fetch, pace: deps.pace });
  if (!result.ok) {
    await store.writeSupplierLog(db, { creatorId: uid, event: 'connect', success: false, message: result.code });
    if (isTransientCode(result.code)) throw coded('CJ could not be reached right now. Try again shortly.', 'SUPPLIER_UNAVAILABLE', 502);
    await store.patchConnection(db, uid, {
      status: existing ? existing.status : 'DISCONNECTED',
      failedConnectAttempts: [...pruneAttempts(existing && existing.failedConnectAttempts, nowMs), nowMs],
    });
    throw coded('CJ rejected these credentials. Check the email and API key and try again.', 'SUPPLIER_AUTH_FAILED', 422);
  }

  await store.saveCredentials(db, uid, { email: email.trim(), apiKey: apiKey.trim(), tokens: result.tokens, autoPay: !!autoPay, nowMs });
  await store.writeSupplierLog(db, { creatorId: uid, event: 'connect', success: true, message: 'Connected' });
  await store.writeCreatorAudit(db, { actorUid: uid, actorRole: 'creator', action: 'supplier.connected', targetType: 'supplierConnection', targetId: store.connectionId(uid), metadata: { provider: 'CJ', autoPay: !!autoPay } });
  return store.publicConnectionView(await store.getConnection(db, uid));
}

async function setAutoPay(db, { uid, enabled, consent }, deps = {}) {
  const conn = await store.getConnection(db, uid);
  if (!conn || conn.status !== 'CONNECTED') throw coded('Connect your CJ account first.', 'SUPPLIER_NOT_CONNECTED', 409);
  if (enabled && consent !== true) throw coded('Automatic payment from your CJ balance needs your explicit consent.', 'AUTOPAY_CONSENT_REQUIRED', 422);
  const nowMs = (deps.now || Date.now)();
  await store.patchConnection(db, uid, { autoPay: { enabled: !!enabled, consentedAtMs: enabled ? nowMs : null } });
  await store.writeCreatorAudit(db, { actorUid: uid, actorRole: 'creator', action: enabled ? 'supplier.autopay_enabled' : 'supplier.autopay_disabled', targetType: 'supplierConnection', targetId: store.connectionId(uid) });
  return store.publicConnectionView(await store.getConnection(db, uid));
}

// -------------------------------------------------------------- pausing
// Auto-pause: PUBLISHED -> PAUSED, flagged as supplier-initiated so a human
// can tell it apart from a creator's own pause. Idempotent and never throws
// for "not published" — that just means there is nothing to pause.
async function pauseProductForSupplier(db, productId, reasons) {
  const product = await store.getProduct(db, productId);
  if (!product || product.status !== PRODUCT_STATES.PUBLISHED) return false;
  assertProductTransition(PRODUCT_STATES.PUBLISHED, PRODUCT_STATES.PAUSED);
  await db.collection('products').doc(productId).set({
    status: PRODUCT_STATES.PAUSED,
    pausedBySupplier: true,
    pauseReason: `Supplier: ${(reasons && reasons[0]) || 'a supplier check failed'}`.slice(0, 300),
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
  await store.writeProductAudit(db, { actorUid: null, actorRole: 'system', action: 'product.auto_paused_supplier', productId, reason: (reasons && reasons.join('; ')) || null });
  return true;
}

async function dropshipProductsOf(db, uid) {
  const snap = await db.collection('products').where('creatorId', '==', uid).get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((p) => p.status === PRODUCT_STATES.PUBLISHED && p.publishedSnapshot && p.publishedSnapshot.fulfillmentMode === FULFILLMENT_MODES.CJ_DROPSHIP);
}

async function disconnectCj(db, { uid, actorRole = 'creator', actorUid = null, reason = null }) {
  const conn = await store.getConnection(db, uid);
  if (!conn) throw coded('No CJ connection to remove.', 'SUPPLIER_NOT_CONNECTED', 409);
  await store.clearCredentials(db, uid, actorRole === 'admin' ? 'REVOKED' : 'DISCONNECTED', reason);
  // Listings that depend on that connection can no longer be fulfilled.
  const affected = await dropshipProductsOf(db, uid);
  const why = [actorRole === 'admin' ? 'The supplier connection was revoked.' : 'The supplier connection was removed.'];
  let paused = 0;
  for (const p of affected) if (await pauseProductForSupplier(db, p.id, why)) paused += 1;
  await store.writeSupplierLog(db, { creatorId: uid, event: 'disconnect', success: true, message: `${actorRole}; paused ${paused}` });
  await store.writeCreatorAudit(db, { actorUid: actorUid || uid, actorRole, action: actorRole === 'admin' ? 'supplier.revoked' : 'supplier.disconnected', targetType: 'supplierConnection', targetId: store.connectionId(uid), reason, metadata: { pausedProducts: paused } });
  return { status: actorRole === 'admin' ? 'REVOKED' : 'DISCONNECTED', pausedProducts: paused };
}

// ----------------------------------------------------------- mapping checks
// Asks CJ the three questions of blueprint §87 (variant valid? stock? shipping
// to every served destination?). Returns { evaluation } or { probeError } —
// infrastructure/auth failures are NOT turned into "invalid mapping", because
// "CJ is down" and "this variant does not exist" mean very different things.
async function runMappingChecks(client, m) {
  const infra = (r) => !r.ok && (isTransientCode(r.code) || isAuthCode(r.code));
  const countries = m.destinationCountries && m.destinationCountries.length ? m.destinationCountries : ['NG'];

  const variantR = await client.call('/product/variant/queryByVid', { query: { vid: m.cjVariantId } });
  if (infra(variantR)) return { probeError: variantR };
  const variant = variantR.ok ? normalizeVariant(variantR.data) : null;

  let stockTotal = 0;
  const freightByCountry = Object.fromEntries(countries.map((c) => [c, []]));
  if (variant) {
    const stockR = await client.call('/product/stock/queryByVid', { query: { vid: variant.vid } });
    if (infra(stockR)) return { probeError: stockR };
    if (stockR.ok) stockTotal = summarizeStockRows(stockR.data).total;

    for (const c of countries) {
      const fr = await client.call('/logistic/freightCalculate', {
        method: 'POST',
        body: { startCountryCode: 'CN', endCountryCode: c, products: [{ vid: variant.vid, quantity: 1 }] },
      });
      if (infra(fr)) return { probeError: fr };
      freightByCountry[c] = fr.ok ? normalizeFreightOptions(fr.data) : [];
    }
  }
  return {
    evaluation: evaluateMapping({
      variant, stockTotal, stockThreshold: m.stockThreshold, freightByCountry,
      declaredCostUsd: m.declaredCostUsd, preferredLogistic: m.logisticName,
    }),
  };
}

function mappingDocFromEvaluation({ productId, versionId, uid, input, evaluation, nowMs }) {
  return {
    productId, versionId, creatorId: uid, provider: 'CJ',
    cjVariantId: input.cjVariantId, cjProductId: input.cjProductId || null, sku: input.sku || null,
    declaredCostUsd: input.declaredCostUsd || null, actualCostUsd: evaluation.actualCostUsd,
    costDriftPct: evaluation.costDriftPct,
    preferredLogistic: input.logisticName || null,
    logisticName: evaluation.chosenLogistic, logisticByCountry: evaluation.logisticByCountry,
    destinationCountries: input.destinationCountries, stockThreshold: input.stockThreshold,
    lastStockTotal: evaluation.stockTotal,
    status: evaluation.status, checks: evaluation.checks, reasons: evaluation.reasons,
    testedAtMs: nowMs, lastCheckedAtMs: nowMs, consecutiveFailures: 0,
  };
}

async function failConnectionIfAuth(db, uid, probeError) {
  if (probeError && isAuthCode(probeError.code)) {
    await store.patchConnection(db, uid, { status: 'AUTH_FAILED', lastError: 'CJ rejected the stored credentials. Reconnect your CJ account.' });
  }
}

function infraError(probeError) {
  if (isAuthCode(probeError.code)) return coded('CJ rejected the stored credentials. Reconnect your CJ account.', 'SUPPLIER_AUTH_FAILED', 409);
  return coded('CJ could not be reached right now. Try again shortly.', 'SUPPLIER_UNAVAILABLE', 502);
}

// Creator-initiated: map the latest DRAFT version of a listing and test it.
async function testMapping(db, { uid, productId, input }, deps = {}) {
  const product = await store.getProduct(db, productId);
  if (!product || product.creatorId !== uid) throw coded('No product found.', 'NOT_FOUND', 404);
  assertProductNotBlocked(product.status);
  const version = await store.getVersion(db, product.latestVersionId);
  if (!version || !isVersionEditable(version.status)) {
    throw coded(`The supplier mapping belongs to a draft version — the latest version is ${version ? version.status : 'missing'}. Start a new version to change it.`, 'NOT_EDITABLE', 409);
  }
  const f = version.fields || {};
  if (f.offeringType !== 'PHYSICAL_PRODUCT' || f.fulfillmentMode !== FULFILLMENT_MODES.CJ_DROPSHIP) {
    throw coded('Set this listing to a physical product with fulfillmentMode CJ_DROPSHIP before mapping it.', 'NOT_A_DROPSHIP_LISTING', 422);
  }
  const parsed = validateMappingInput(input);
  if (!parsed.ok) throw coded('Please check the mapping details.', 'VALIDATION_FAILED', 422, parsed.errors);

  const nowMs = (deps.now || Date.now)();
  const prior = await store.getMapping(db, version.id);
  if (prior && prior.lastCheckedAtMs && nowMs - prior.lastCheckedAtMs < 10 * 1000) {
    throw coded('Wait a few seconds before testing again.', 'TOO_SOON', 429);
  }

  const { client } = await store.buildClientForCreator(db, uid, deps);
  const out = await runMappingChecks(client, parsed.value);
  if (out.probeError) {
    await failConnectionIfAuth(db, uid, out.probeError);
    throw infraError(out.probeError);
  }
  const doc = mappingDocFromEvaluation({ productId, versionId: version.id, uid, input: parsed.value, evaluation: out.evaluation, nowMs });
  await store.saveMapping(db, version.id, doc);
  await store.writeSupplierLog(db, { creatorId: uid, event: 'mapping.test', objectId: version.id, success: out.evaluation.status === 'VALID', message: out.evaluation.status });
  await store.writeProductAudit(db, { actorUid: uid, actorRole: 'creator', action: 'supplier.mapping_tested', productId, versionId: version.id, metadata: { status: out.evaluation.status } });
  return { ...doc, versionId: version.id };
}

// Re-runs the stored mapping. Used by approval (stale tests) and health.
async function retestStoredMapping(db, { uid, versionId }, deps = {}) {
  const mapping = await store.getMapping(db, versionId);
  if (!mapping) throw coded('Map this listing to a CJ variant and run the mapping test first.', 'MAPPING_MISSING', 409);
  const { client } = await store.buildClientForCreator(db, uid, deps);
  const out = await runMappingChecks(client, mapping);
  if (out.probeError) {
    await failConnectionIfAuth(db, uid, out.probeError);
    throw infraError(out.probeError);
  }
  const nowMs = (deps.now || Date.now)();
  const doc = mappingDocFromEvaluation({
    productId: mapping.productId, versionId, uid,
    input: { cjVariantId: mapping.cjVariantId, cjProductId: mapping.cjProductId, sku: mapping.sku, declaredCostUsd: mapping.declaredCostUsd, logisticName: mapping.preferredLogistic, destinationCountries: mapping.destinationCountries, stockThreshold: mapping.stockThreshold },
    evaluation: out.evaluation, nowMs,
  });
  await store.saveMapping(db, versionId, doc);
  return doc;
}

// ------------------------------------------------------------------ gates
// Submission gate: the draft's mapping must already be VALID.
async function assertReadyToSubmit(db, { uid, creator, versionId }, deps = {}) {
  const [connection, mapping] = await Promise.all([store.getConnection(db, uid), store.getMapping(db, versionId)]);
  assertDropshipReady({ creatorStatus: creator && creator.status, connection, mapping, nowMs: (deps.now || Date.now)(), maxAgeMs: null });
}

// Approval gate (blueprint §87): re-verify with CJ if the last test is older
// than 24h, so an admin never publishes against a stale answer.
async function assertReadyToApprove(db, { creatorId, versionId }, deps = {}) {
  const creatorSnap = await db.collection('creators').doc(creatorId).get();
  const creatorStatus = creatorSnap.exists ? creatorSnap.data().status : null;
  const nowMs = (deps.now || Date.now)();
  let mapping = await store.getMapping(db, versionId);
  let connection = await store.getConnection(db, creatorId);
  if (mapping && connection && connection.status === 'CONNECTED' && nowMs - (mapping.testedAtMs || 0) > MAPPING_MAX_AGE_MS) {
    await retestStoredMapping(db, { uid: creatorId, versionId }, deps);
    mapping = await store.getMapping(db, versionId);
    connection = await store.getConnection(db, creatorId);
  }
  assertDropshipReady({ creatorStatus, connection, mapping, nowMs: (deps.now || Date.now)(), maxAgeMs: MAPPING_MAX_AGE_MS });
  return mapping;
}

// ------------------------------------------------------------------ health
/**
 * Re-checks a PUBLISHED dropship listing's supplier side (blueprint §86) and
 * pauses it if a critical dependency broke. `minGapMs` keeps a creator from
 * hammering CJ; admins/schedulers pass 0.
 */
async function checkMappingHealth(db, { productId, minGapMs = 60 * 1000 }, deps = {}) {
  const product = await store.getProduct(db, productId);
  if (!product) throw coded('No product found.', 'NOT_FOUND', 404);
  const snap = product.publishedSnapshot || {};
  if (snap.fulfillmentMode !== FULFILLMENT_MODES.CJ_DROPSHIP) throw coded('This listing is not a CJ dropship listing.', 'NOT_A_DROPSHIP_LISTING', 409);
  const uid = product.creatorId;
  const versionId = product.currentVersionId;
  const nowMs = (deps.now || Date.now)();

  const mapping = await store.getMapping(db, versionId);
  if (mapping && mapping.healthCheckedAtMs && nowMs - mapping.healthCheckedAtMs < minGapMs) {
    return { cached: true, health: mapping.health, reasons: mapping.healthReasons || [], paused: false, productStatus: product.status };
  }
  const connection = await store.getConnection(db, uid);

  let verdict;
  let evaluation = null;
  if (!mapping) {
    verdict = { health: 'DEGRADED', pause: true, consecutiveFailures: 0, reasons: ['This published listing has no supplier mapping.'] };
  } else if (!connection || connection.status !== 'CONNECTED') {
    verdict = deriveHealth({ connectionStatus: connection ? connection.status : 'NOT_CONNECTED', consecutiveFailures: mapping.consecutiveFailures || 0 });
  } else {
    const { client } = await store.buildClientForCreator(db, uid, deps);
    const out = await runMappingChecks(client, mapping);
    if (out.probeError) await failConnectionIfAuth(db, uid, out.probeError);
    evaluation = out.evaluation || null;
    verdict = deriveHealth({
      connectionStatus: out.probeError && isAuthCode(out.probeError.code) ? 'AUTH_FAILED' : 'CONNECTED',
      probeError: out.probeError || null, evaluation, consecutiveFailures: mapping.consecutiveFailures || 0,
    });
  }

  if (mapping) {
    const patch = {
      health: verdict.health, healthReasons: verdict.reasons, healthCheckedAtMs: nowMs,
      lastCheckedAtMs: nowMs, consecutiveFailures: verdict.consecutiveFailures,
    };
    if (evaluation) Object.assign(patch, {
      status: evaluation.status, checks: evaluation.checks, reasons: evaluation.reasons,
      actualCostUsd: evaluation.actualCostUsd, costDriftPct: evaluation.costDriftPct, lastStockTotal: evaluation.stockTotal,
    });
    await store.saveMapping(db, versionId, patch);
  }
  if (connection && connection.status === 'CONNECTED') await store.patchConnection(db, uid, { lastSyncAtMs: nowMs });

  let paused = false;
  if (verdict.pause) paused = await pauseProductForSupplier(db, productId, verdict.reasons);
  await store.writeSupplierLog(db, { creatorId: uid, event: 'health.check', objectId: productId, success: verdict.health !== 'DEGRADED', message: `${verdict.health}${paused ? ' (paused)' : ''}` });
  return { cached: false, health: verdict.health, reasons: verdict.reasons, paused, productStatus: paused ? PRODUCT_STATES.PAUSED : product.status };
}

module.exports = {
  connectCj, setAutoPay, disconnectCj,
  pauseProductForSupplier, dropshipProductsOf,
  runMappingChecks, testMapping, retestStoredMapping,
  assertReadyToSubmit, assertReadyToApprove, checkMappingHealth,
};
