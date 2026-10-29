'use strict';

// LEXDEN NOVA — supplier-funding orchestration for legacy CJ orders.
//
// Supported, documented path:
//   1) create CJ order with payType=3 (create only)
//   2) read CJ wallet balance
//   3) if sufficient, pay with /shopping/pay/payBalanceV2
//   4) if insufficient, inspect Paystack's AVAILABLE balance and escalate
//
// IMPORTANT: Paystack does not expose a CJ-wallet top-up primitive, and CJ's
// documented wallet recharge methods are Payoneer/wire transfer rather than a
// real-time Paystack API bridge. This module therefore NEVER invents a money
// movement. It records the shortfall and Paystack balances so an admin can act.
// A future bridge must only be enabled when CJ provides a documented instant
// deposit mechanism that can be verified end-to-end.

const { keyForMode, resolvePaystackSecretKey } = require('./_paystackMode');

function positiveNumber(...values) {
  for (const v of values) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function cjOrderAmountUSD(cjResult) {
  if (!cjResult || typeof cjResult !== 'object') return null;
  const direct = positiveNumber(cjResult.orderAmount);
  if (direct != null) return direct;
  const parts = [
    Number(cjResult.productAmount) || 0,
    Number(cjResult.postageAmount) || 0,
    Number(cjResult.iossAmount) || 0,
    Number(cjResult.iossTaxHandlingFee) || 0,
  ];
  const sum = parts.reduce((a, b) => a + b, 0);
  return sum > 0 ? Number(sum.toFixed(2)) : null;
}

function cjBalanceUSD(data) {
  const n = Number(data && data.amount);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizePaystackBalances(data) {
  const rows = Array.isArray(data) ? data : [];
  return rows
    .map((row) => ({
      currency: String(row && row.currency || '').toUpperCase(),
      balanceMinor: Number(row && row.balance),
    }))
    .filter((row) => /^[A-Z]{3}$/.test(row.currency) && Number.isFinite(row.balanceMinor) && row.balanceMinor >= 0)
    .map((row) => ({ ...row, balanceMajor: row.balanceMinor / 100 }));
}

async function paystackBalanceSnapshot({ mode, secretKey, fetchImpl = fetch, timeoutMs = 6000 } = {}) {
  const key = secretKey || (mode === 'live' || mode === 'test' ? keyForMode(mode) : await resolvePaystackSecretKey());
  if (!key) return { ok: false, error: 'paystack_key_unavailable', balances: [] };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl('https://api.paystack.co/balance', {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: ctl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j || j.status !== true) {
      return { ok: false, error: (j && j.message) || `Paystack balance HTTP ${r.status}`, balances: [] };
    }
    return { ok: true, balances: normalizePaystackBalances(j.data) };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'paystack_balance_timeout' : e.message, balances: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function fundCjOrder({ cjFetch, cjOrderId, requiredUSD, paystackMode, paystackSecretKey, fetchImpl } = {}) {
  if (typeof cjFetch !== 'function') throw new Error('cjFetch is required');
  if (!cjOrderId) return { ok: false, state: 'invalid_cj_order', message: 'CJ order id is missing.' };

  const balR = await cjFetch('/shopping/pay/getBalance', { method: 'GET' });
  if (!balR.ok) {
    return {
      ok: false,
      state: 'cj_balance_unknown',
      message: balR.message || 'Could not read CJ wallet balance.',
      cjCode: balR.code || null,
      paystack: await paystackBalanceSnapshot({ mode: paystackMode, secretKey: paystackSecretKey, fetchImpl }),
    };
  }

  const balanceUSD = cjBalanceUSD(balR.data);
  const needUSD = positiveNumber(requiredUSD);
  if (balanceUSD == null || needUSD == null) {
    return {
      ok: false,
      state: 'funding_amount_unknown',
      message: 'CJ did not return a usable wallet balance or order amount.',
      cjBalanceUSD: balanceUSD,
      requiredUSD: needUSD,
      paystack: await paystackBalanceSnapshot({ mode: paystackMode, secretKey: paystackSecretKey, fetchImpl }),
    };
  }

  const shortfallUSD = Math.max(0, Number((needUSD - balanceUSD).toFixed(2)));
  if (shortfallUSD > 0) {
    return {
      ok: false,
      state: 'cj_balance_insufficient',
      message: 'CJ wallet balance is below the amount required for this order.',
      cjBalanceUSD: balanceUSD,
      requiredUSD: needUSD,
      shortfallUSD,
      paystack: await paystackBalanceSnapshot({ mode: paystackMode, secretKey: paystackSecretKey, fetchImpl }),
    };
  }

  const payR = await cjFetch('/shopping/pay/payBalanceV2', {
    method: 'POST',
    body: { shipmentOrderId: String(cjOrderId) },
  });
  if (!payR.ok) {
    return {
      ok: false,
      state: 'cj_payment_failed',
      message: payR.message || 'CJ balance payment failed.',
      cjCode: payR.code || null,
      cjBalanceUSD: balanceUSD,
      requiredUSD: needUSD,
      paystack: await paystackBalanceSnapshot({ mode: paystackMode, secretKey: paystackSecretKey, fetchImpl }),
    };
  }

  return {
    ok: true,
    state: 'paid',
    cjBalanceUSD: balanceUSD,
    requiredUSD: needUSD,
    paymentRequestId: payR.requestId || null,
  };
}

module.exports = {
  positiveNumber,
  cjOrderAmountUSD,
  cjBalanceUSD,
  normalizePaystackBalances,
  paystackBalanceSnapshot,
  fundCjOrder,
};
