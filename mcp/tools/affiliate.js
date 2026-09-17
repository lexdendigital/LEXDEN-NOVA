// mcp/tools/affiliate.js
//
// Every write here calls straight into api/affiliate/admin.js's exported
// `actions` — the SAME functions the admin portal's fetch() calls hit.
// This file only adds the read/list side (which the HTTP API never
// needed, since the portal reads those collections directly with the
// client SDK) and wires each write behind confirm:true since they either
// change an affiliate's active/suspended status or move money.

const { z } = require('zod');
const { getDb } = require('../../api/affiliate/shared');
const { actions } = require('../../api/affiliate/admin');

async function listCollection(db, name, limit) {
  const snap = await db.collection(name).limit(limit).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function register(server) {
  server.registerTool('nova_list_affiliates', {
    title: 'List affiliates',
    description: 'Lists everyone in the affiliate program (`affiliates` collection) — status (pending/active/suspended), balances, WhatsApp/payout details submitted at onboarding.',
    inputSchema: { status: z.enum(['pending', 'active', 'suspended']).optional(), limit: z.number().int().min(1).max(500).default(100) },
  }, async ({ status, limit }) => {
    let list = await listCollection(getDb(), 'affiliates', 500);
    if (status) list = list.filter((a) => a.status === status);
    return { content: [{ type: 'text', text: JSON.stringify(list.slice(0, limit), null, 2) }] };
  });

  server.registerTool('nova_approve_affiliate', {
    title: 'Approve affiliate',
    description: 'Activates a pending affiliate application (status -> active). Requires confirm: true.',
    inputSchema: { affiliateId: z.string(), confirm: z.literal(true) },
  }, async ({ affiliateId }) => {
    const result = await actions.approveAffiliate({ affiliateId });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('nova_suspend_affiliate', {
    title: 'Suspend affiliate',
    description: 'Suspends an affiliate (status -> suspended), blocking further commission/withdrawal activity. Requires confirm: true.',
    inputSchema: { affiliateId: z.string(), confirm: z.literal(true) },
  }, async ({ affiliateId }) => {
    const result = await actions.suspendAffiliate({ affiliateId });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('nova_list_withdrawals', {
    title: 'List affiliate withdrawal requests',
    description: 'Lists withdrawal requests (`affiliateWithdrawals` collection) — status, amount, and the payout bank details on file.',
    inputSchema: { status: z.enum(['pending', 'approved', 'rejected', 'paid']).optional(), limit: z.number().int().min(1).max(500).default(100) },
  }, async ({ status, limit }) => {
    let list = await listCollection(getDb(), 'affiliateWithdrawals', 500);
    if (status) list = list.filter((w) => w.status === status);
    return { content: [{ type: 'text', text: JSON.stringify(list.slice(0, limit), null, 2) }] };
  });

  server.registerTool('nova_approve_withdrawal', {
    title: 'Approve withdrawal',
    description: 'Marks a pending withdrawal request approved — doesn\'t move money by itself; follow with nova_pay_withdrawal_via_paystack or pay manually and call nova_mark_withdrawal_paid. Requires confirm: true.',
    inputSchema: { withdrawalId: z.string(), confirm: z.literal(true) },
  }, async ({ withdrawalId }) => {
    const result = await actions.approveWithdrawal({ withdrawalId });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('nova_reject_withdrawal', {
    title: 'Reject withdrawal',
    description: 'Rejects a pending withdrawal and automatically refunds the reserved amount back to the affiliate\'s available balance. Requires confirm: true.',
    inputSchema: { withdrawalId: z.string(), note: z.string().optional(), confirm: z.literal(true) },
  }, async ({ withdrawalId, note }) => {
    const result = await actions.rejectWithdrawal({ withdrawalId, note });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('nova_mark_withdrawal_paid', {
    title: 'Mark withdrawal paid (manual)',
    description: 'Marks a withdrawal as paid after you\'ve sent the money yourself outside Paystack (e.g. direct bank transfer). This moves real money bookkeeping — it does NOT send any money itself, it only records that you already did. Requires confirm: true.',
    inputSchema: { withdrawalId: z.string(), confirm: z.literal(true) },
  }, async ({ withdrawalId }) => {
    const result = await actions.markWithdrawalPaid({ withdrawalId });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });

  server.registerTool('nova_pay_withdrawal_via_paystack', {
    title: 'Pay withdrawal via Paystack Transfers',
    description: 'Actually moves money: creates a Paystack transfer recipient and sends the payout automatically. Only works once Paystack Transfers is enabled on your business account and the withdrawal is already approved. This is real, irreversible money movement — requires confirm: true and should only be called after you\'ve reviewed the withdrawal with nova_list_withdrawals.',
    inputSchema: { withdrawalId: z.string(), confirm: z.literal(true) },
  }, async ({ withdrawalId }) => {
    const result = await actions.payWithdrawalViaPaystack({ withdrawalId });
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  });
}

module.exports = { register };
