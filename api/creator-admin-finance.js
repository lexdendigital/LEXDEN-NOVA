// /api/creator-admin-finance.js
//
// LEXDEN NOVA CREATOR — Stage F. Admin-only.
//
// GET  ?action=list-withdrawals[&status=pending]  -> withdrawal queue (default)
// GET  ?action=list-balances                      -> every creator's balance
// GET  ?export=sales|withdrawals[&from=&to=]       -> CSV finance export
// POST { action, ...payload }
//   approve-withdrawal          { withdrawalId }
//   mark-withdrawal-paid        { withdrawalId }          (manual payout)
//   reject-withdrawal           { withdrawalId, note? }   (refunds balance)
//   pay-withdrawal-via-paystack { withdrawalId }          (automated payout)
//
// Structural mirror of api/affiliate/admin.js, with two hardening changes
// the affiliate version lacks: mark-paid requires status 'approved' (so
// totalWithdrawn can't be double-counted), and Paystack payout first
// claims the withdrawal ('approved' -> 'processing') in a transaction, so
// a double-click or retry can never send the same money twice.
// Exports `actions` so the Creator MCP (Stage J) calls the same functions.
const { getDb, FieldValue, requireAdminAuth, setCors } = require('./creator/shared');
const { resolvePaystackSecretKey } = require('./_paystackMode');

const PAYSTACK_BASE = 'https://api.paystack.co';

async function paystackFetch(path, options) {
  const secret = await resolvePaystackSecretKey();
  if (!secret) throw Object.assign(new Error('PAYSTACK_SECRET_KEY not set on the server.'), { status: 500 });
  const r = await fetch(PAYSTACK_BASE + path, {
    ...options,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...(options && options.headers) },
  });
  const data = await r.json();
  if (!data.status) throw Object.assign(new Error(data.message || 'Paystack request failed.'), { status: 502 });
  return data;
}

const need = (v, name) => { if (!v) throw Object.assign(new Error(`Missing ${name}.`), { status: 400 }); };

async function approveWithdrawal({ withdrawalId }) {
  need(withdrawalId, 'withdrawalId');
  const db = getDb();
  const wdRef = db.collection('creatorWithdrawals').doc(withdrawalId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(wdRef);
    if (!snap.exists) throw Object.assign(new Error('Withdrawal not found.'), { status: 404 });
    if (snap.data().status !== 'pending') throw Object.assign(new Error('Only pending withdrawals can be approved.'), { status: 400 });
    tx.update(wdRef, { status: 'approved', decidedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
}

async function markWithdrawalPaid({ withdrawalId }) {
  need(withdrawalId, 'withdrawalId');
  const db = getDb();
  const wdRef = db.collection('creatorWithdrawals').doc(withdrawalId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(wdRef);
    if (!snap.exists) throw Object.assign(new Error('Withdrawal not found.'), { status: 404 });
    const wd = snap.data();
    if (wd.status !== 'approved') throw Object.assign(new Error('Only approved withdrawals can be marked paid.'), { status: 400 });
    tx.update(wdRef, { status: 'paid', paidAt: FieldValue.serverTimestamp(), decidedAt: FieldValue.serverTimestamp() });
    tx.set(db.collection('creatorPrivate').doc(wd.creatorId), { totalWithdrawn: FieldValue.increment(wd.amountRequested) }, { merge: true });
  });
  return { ok: true };
}

async function rejectWithdrawal({ withdrawalId, note }) {
  need(withdrawalId, 'withdrawalId');
  const db = getDb();
  const wdRef = db.collection('creatorWithdrawals').doc(withdrawalId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(wdRef);
    if (!snap.exists) throw Object.assign(new Error('Withdrawal not found.'), { status: 404 });
    const wd = snap.data();
    if (wd.status !== 'pending') throw Object.assign(new Error('Only pending withdrawals can be rejected.'), { status: 400 });
    tx.update(wdRef, { status: 'rejected', note: note || null, decidedAt: FieldValue.serverTimestamp() });
    tx.set(db.collection('creatorPrivate').doc(wd.creatorId), { balanceAvailable: FieldValue.increment(wd.amountRequested) }, { merge: true });
  });
  return { ok: true };
}

async function payWithdrawalViaPaystack({ withdrawalId }) {
  need(withdrawalId, 'withdrawalId');
  const db = getDb();
  const wdRef = db.collection('creatorWithdrawals').doc(withdrawalId);

  // Claim it first: only one caller can move approved -> processing.
  const wd = await db.runTransaction(async (tx) => {
    const snap = await tx.get(wdRef);
    if (!snap.exists) throw Object.assign(new Error('Withdrawal not found.'), { status: 404 });
    const data = snap.data();
    if (data.status !== 'approved') throw Object.assign(new Error('Approve the withdrawal first (or it is already being paid).'), { status: 400 });
    const a = data.payoutAccount;
    if (!a || !a.bankCode || !a.accountNumber || !a.accountName) {
      throw Object.assign(new Error('This creator has no bank account on file — use Mark Paid instead.'), { status: 400 });
    }
    tx.update(wdRef, { status: 'processing', processingStartedAt: FieldValue.serverTimestamp() });
    return data;
  });

  let recipientCode, transfer;
  try {
    const acct = wd.payoutAccount;
    const recipient = await paystackFetch('/transferrecipient', {
      method: 'POST',
      body: JSON.stringify({ type: 'nuban', currency: 'NGN', name: acct.accountName, account_number: acct.accountNumber, bank_code: acct.bankCode }),
    });
    recipientCode = recipient.data.recipient_code;
    transfer = await paystackFetch('/transfer', {
      method: 'POST',
      body: JSON.stringify({
        source: 'balance',
        amount: Math.round(wd.amountPayable * 100),
        recipient: recipientCode,
        reason: `LEXDEN NOVA CREATOR payout — withdrawal ${withdrawalId}`,
        reference: `creator-wd-${withdrawalId}`.toLowerCase(), // Paystack-side idempotency
      }),
    });
  } catch (e) {
    // Paystack rejected before moving money: release the claim.
    await wdRef.update({ status: 'approved', lastPayoutError: String(e.message || e).slice(0, 300) });
    throw e;
  }

  await db.runTransaction(async (tx) => {
    tx.update(wdRef, {
      status: 'paid', paidAt: FieldValue.serverTimestamp(), decidedAt: FieldValue.serverTimestamp(),
      paystackRecipientCode: recipientCode,
      paystackTransferCode: transfer.data.transfer_code || null,
      paystackTransferStatus: transfer.data.status || null,
    });
    tx.set(db.collection('creatorPrivate').doc(wd.creatorId), { totalWithdrawn: FieldValue.increment(wd.amountRequested) }, { merge: true });
  });
  return { ok: true, transferStatus: transfer.data.status };
}

async function listWithdrawals({ status } = {}) {
  let query = getDb().collection('creatorWithdrawals');
  if (status) query = query.where('status', '==', status);
  const snap = await query.orderBy('requestedAt', 'desc').limit(200).get();
  return { ok: true, withdrawals: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
}

// Reads creatorPrivate (never the public creators doc): balances are never public.
async function listBalances() {
  const snap = await getDb().collection('creatorPrivate').where('totalEarned', '>', 0).get();
  return { ok: true, balances: snap.docs.map(d => ({ creatorId: d.id, balanceAvailable: d.data().balanceAvailable || 0, totalEarned: d.data().totalEarned || 0, totalWithdrawn: d.data().totalWithdrawn || 0 })) };
}

function csvEscape(v) {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Neutralise spreadsheet formula injection (=, +, -, @ at start).
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function toCsv(rows, columns) {
  return columns.join(',') + '\n' + rows.map(r => columns.map(c => csvEscape(r[c])).join(',')).join('\n') + '\n';
}

const SALES_COLUMNS = ['id', 'creatorId', 'productId', 'productTitle', 'offeringType', 'orderId', 'saleAmount', 'currency', 'platformFeePct', 'platformFeeAmount', 'creatorEarning', 'status', 'createdAt'];
const WD_COLUMNS = ['id', 'creatorId', 'amountRequested', 'feeAmount', 'amountPayable', 'currency', 'status', 'requestedAt', 'decidedAt'];

async function exportCsv(type, { from, to } = {}) {
  const isWd = type === 'withdrawals';
  const dateField = isWd ? 'requestedAt' : 'createdAt';
  let query = getDb().collection(isWd ? 'creatorWithdrawals' : 'creatorSales');
  if (from) query = query.where(dateField, '>=', new Date(from + 'T00:00:00Z'));
  if (to) query = query.where(dateField, '<=', new Date(to + 'T23:59:59Z'));
  const snap = await query.orderBy(dateField, 'desc').limit(5000).get();
  const iso = (v) => (v && v.toDate ? v.toDate().toISOString() : (v || ''));
  const rows = snap.docs.map(d => {
    const v = d.data();
    return { id: d.id, ...v, createdAt: iso(v.createdAt), requestedAt: iso(v.requestedAt), decidedAt: iso(v.decidedAt) };
  });
  return toCsv(rows, isWd ? WD_COLUMNS : SALES_COLUMNS);
}

const ACTIONS = {
  'approve-withdrawal': approveWithdrawal,
  'mark-withdrawal-paid': markWithdrawalPaid,
  'reject-withdrawal': rejectWithdrawal,
  'pay-withdrawal-via-paystack': payWithdrawalViaPaystack,
};

function errBody(e, fallback) {
  return { ok: false, error: { code: e.code || 'INTERNAL', message: e.message || fallback } };
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    await requireAdminAuth(req);
  } catch (e) {
    return res.status(e.status || 401).json(errBody(e, 'Not authorized.'));
  }

  if (req.method === 'GET') {
    const q = req.query || {};
    try {
      if (q.export === 'sales' || q.export === 'withdrawals') {
        const csv = await exportCsv(q.export, { from: q.from, to: q.to });
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="lexden-nova-creator-${q.export}.csv"`);
        return res.status(200).send(csv);
      }
      if (q.action === 'list-balances') return res.status(200).json(await listBalances());
      return res.status(200).json(await listWithdrawals({ status: q.status }));
    } catch (e) {
      console.error('creator-admin-finance GET failed:', e.message);
      return res.status(e.status || 500).json(errBody(e, 'Request failed.'));
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const { action, ...payload } = req.body || {};
  const fn = Object.prototype.hasOwnProperty.call(ACTIONS, action) ? ACTIONS[action] : null;
  if (!fn) return res.status(400).json({ ok: false, error: { code: 'INVALID_ACTION', message: `Unknown action "${action}".` } });

  try {
    return res.status(200).json(await fn(payload));
  } catch (e) {
    console.error('creator-admin-finance action failed:', e.message);
    return res.status(e.status || 500).json(errBody(e, 'Action failed.'));
  }
};

module.exports.actions = {
  approveWithdrawal, markWithdrawalPaid, rejectWithdrawal, payWithdrawalViaPaystack,
  listWithdrawals, listBalances, exportCsv,
};
module.exports.csvEscape = csvEscape;
