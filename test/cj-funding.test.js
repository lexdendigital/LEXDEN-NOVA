'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  cjOrderAmountUSD,
  cjBalanceUSD,
  normalizePaystackBalances,
  fundCjOrder,
} = require('../api/cj-funding');

test('extracts CJ order amount from orderAmount first', () => {
  assert.equal(cjOrderAmountUSD({ orderAmount: '12.34', productAmount: 5, postageAmount: 3 }), 12.34);
});

test('falls back to CJ cost components when orderAmount is absent', () => {
  assert.equal(cjOrderAmountUSD({ productAmount: 5, postageAmount: 3.2, iossAmount: 1 }), 9.2);
});

test('normalizes CJ and Paystack balances without guessing currencies', () => {
  assert.equal(cjBalanceUSD({ amount: '20.50' }), 20.5);
  assert.deepEqual(normalizePaystackBalances([
    { currency: 'NGN', balance: 123450 },
    { currency: 'USD', balance: 500 },
  ]), [
    { currency: 'NGN', balanceMinor: 123450, balanceMajor: 1234.5 },
    { currency: 'USD', balanceMinor: 500, balanceMajor: 5 },
  ]);
});

test('pays CJ with balance only when the wallet covers the order', async () => {
  const calls = [];
  const cjFetch = async (path, opts) => {
    calls.push({ path, opts });
    if (path.endsWith('/getBalance')) return { ok: true, data: { amount: 30 } };
    if (path.endsWith('/payBalanceV2')) return { ok: true, requestId: 'req-1', data: null };
    throw new Error('unexpected CJ call');
  };
  const out = await fundCjOrder({ cjFetch, cjOrderId: 'CJ-1', requiredUSD: 12.5 });
  assert.equal(out.ok, true);
  assert.equal(out.state, 'paid');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].opts.body, { shipmentOrderId: 'CJ-1' });
});

test('insufficient CJ balance does not attempt payment and inspects Paystack available balance', async () => {
  const calls = [];
  const cjFetch = async (path) => {
    calls.push(path);
    return { ok: true, data: { amount: 4 } };
  };
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ status: true, data: [{ currency: 'NGN', balance: 250000 }] }),
  });
  const out = await fundCjOrder({ cjFetch, cjOrderId: 'CJ-2', requiredUSD: 10, paystackSecretKey: 'sk_test_example', fetchImpl });
  assert.equal(out.ok, false);
  assert.equal(out.state, 'cj_balance_insufficient');
  assert.equal(out.shortfallUSD, 6);
  assert.equal(calls.length, 1);
  assert.deepEqual(out.paystack.balances[0], { currency: 'NGN', balanceMinor: 250000, balanceMajor: 2500 });
});
