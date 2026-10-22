// mcp/lib/risk.js
//
// A model typing `confirm: true` is NOT a human decision. For actions that move money, decide a refund
// or dispute, approve/reject an application or listing, or change the live code, the AI connection can
// PREPARE (list, explain, draft) but cannot EXECUTE: a person does it in the admin/creator portal.
// An owner can knowingly re-enable these for the admin connector with MCP_HIGH_RISK_TOOLS=ENABLED;
// the default is blocked, and every blocked attempt is audit-logged (blocked: true).
const ALWAYS_HUMAN = Object.freeze([
  'nova_pay_withdrawal_via_paystack', 'nova_mark_withdrawal_paid',
  'nova_approve_withdrawal', 'nova_reject_withdrawal',
  'nova_approve_creator_withdrawal', 'nova_reject_creator_withdrawal',
  'nova_resolve_creator_dispute',
  'nova_write_source_file', 'nova_replace_in_source_file',
  'creator_request_withdrawal',
]);
const BY_ACTION = Object.freeze({
  nova_review_creator_application: ['approve', 'reject'],
  nova_review_creator_listing: ['approve', 'reject'],
  nova_set_creator_status: ['revoke', 'suspend'],
});
// Creators' own AI can never be unlocked by the owner switch: it acts for the creator, not the owner.
const NEVER_UNLOCK = Object.freeze(['creator_request_withdrawal']);

function blockedReason(tool, args = {}, env = process.env) {
  const enabled = String(env.MCP_HIGH_RISK_TOOLS || '').toUpperCase() === 'ENABLED';
  const risky = ALWAYS_HUMAN.includes(tool) || (BY_ACTION[tool] && BY_ACTION[tool].includes(args && args.action));
  if (!risky) return null;
  if (enabled && !NEVER_UNLOCK.includes(tool)) return null;
  return `"${tool}" can only be done by a person in the portal (it moves money, decides a case, or changes live code). The AI connection can prepare and explain it, not execute it.`;
}

module.exports = { blockedReason, ALWAYS_HUMAN, BY_ACTION };
