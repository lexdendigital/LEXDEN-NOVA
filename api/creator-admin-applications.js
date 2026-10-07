// /api/creator-admin-applications.js
//
// LEXDEN NOVA CREATOR — Stage A. Admin-only (requireAdminAuth — same
// hardcoded admin-email check already used throughout the affiliate
// program, see api/affiliate/shared.js).
//
// GET  /api/creator-admin-applications?status=SUBMITTED
//      -> review queue, with each applicant's private fields attached
//         (the admin reviewing an application legitimately needs to see
//         legal name/DOB/documents — this is the one place in the whole
//         system that's true for).
//
// POST /api/creator-admin-applications
//      Application-stage decisions:
//        { uid, action: 'start_review' | 'request_changes' | 'reject' | 'approve', reason? }
//      Seller-stage decisions (once APPROVED/ACTIVE):
//        { uid, action: 'suspend' | 'restrict' | 'reactivate' | 'revoke', reason? }
const {
  getDb, FieldValue, requireAdminAuth, getCreatorDoc, getApplicationDoc,
  writeCreatorAuditLog, ok, fail, setCors,
} = require('./creator/shared');
const {
  APPLICATION_STATES, SELLER_STATES,
  assertApplicationTransition, assertSellerTransition,
} = require('./creator/state-machine');
const { queueEmailBackground } = require('./email-shared');

// Both notification templates need the applicant/creator's email, which
// only ever lives in creatorPrivate/{uid} — never on the public creators
// doc. Best-effort: a lookup failure here must never block the actual
// admin decision from going through.
async function notifyApplicant(uid, templateKey, params) {
  try {
    const privSnap = await getDb().collection('creatorPrivate').doc(uid).get();
    const email = privSnap.exists && privSnap.data().email;
    if (email) queueEmailBackground({ templateKey, to: { email }, params });
  } catch (e) {
    console.error('creator notification email lookup failed:', e);
  }
}

const APPLICATION_ACTIONS = {
  start_review: { from: [APPLICATION_STATES.SUBMITTED], to: APPLICATION_STATES.IN_REVIEW, reasonRequired: false },
  request_changes: { from: [APPLICATION_STATES.IN_REVIEW], to: APPLICATION_STATES.CHANGES_REQUESTED, reasonRequired: true },
  reject: { from: [APPLICATION_STATES.IN_REVIEW], to: APPLICATION_STATES.REJECTED, reasonRequired: true },
  approve: { from: [APPLICATION_STATES.IN_REVIEW], to: APPLICATION_STATES.APPROVED, reasonRequired: false },
};
const SELLER_ACTIONS = {
  suspend: { to: SELLER_STATES.SUSPENDED, reasonRequired: true, atField: 'suspendedAt', reasonField: 'suspendReason' },
  restrict: { to: SELLER_STATES.RESTRICTED, reasonRequired: true, atField: 'restrictedAt', reasonField: 'restrictReason' },
  reactivate: { to: SELLER_STATES.ACTIVE, reasonRequired: false, atField: 'reactivatedAt', reasonField: null },
  revoke: { to: SELLER_STATES.REVOKED, reasonRequired: true, atField: 'revokedAt', reasonField: 'revokeReason' },
};

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let admin;
  try {
    admin = await requireAdminAuth(req);
  } catch (e) {
    return fail(res, e);
  }

  if (req.method === 'GET') {
    try {
      const status = req.query && req.query.status;
      let query = getDb().collection('creatorApplications');
      if (status) query = query.where('status', '==', status);
      const snap = await query.orderBy('updatedAt', 'desc').limit(100).get();

      const items = await Promise.all(snap.docs.map(async d => {
        const v = d.data();
        const privSnap = await getDb().collection('creatorPrivate').doc(d.id).get();
        const docsSnap = await getDb().collection('creatorDocuments').where('creatorId', '==', d.id).get();
        return {
          uid: d.id,
          status: v.status,
          creatorType: v.creatorType,
          publicFields: v.publicFields || {},
          privateFields: privSnap.exists ? privSnap.data() : {},
          documents: docsSnap.docs.map(dd => ({ id: dd.id, docType: dd.data().docType, reviewStatus: dd.data().reviewStatus })),
          submittedAt: v.submittedAt || null,
          updatedAt: v.updatedAt || null,
        };
      }));
      return ok(res, { applications: items });
    } catch (e) {
      // Firestore needs a composite index for (status ==, orderBy updatedAt)
      // on first use — the error it throws already contains a direct
      // console link to create it, so it's surfaced as-is rather than
      // masked.
      return fail(res, e);
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const { uid, action, reason } = req.body || {};
  if (typeof uid !== 'string' || !uid) {
    return fail(res, { status: 422, code: 'MISSING_UID', message: 'uid is required.' });
  }

  try {
    if (Object.prototype.hasOwnProperty.call(APPLICATION_ACTIONS, action)) {
      const spec = APPLICATION_ACTIONS[action];
      if (spec.reasonRequired && (typeof reason !== 'string' || !reason.trim())) {
        return fail(res, { status: 422, code: 'REASON_REQUIRED', message: `A reason is required for "${action}".` });
      }
      const appDoc = await getApplicationDoc(uid);
      if (!appDoc) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No application found for this uid.' });
      assertApplicationTransition(appDoc.status, spec.to);

      const patch = { status: spec.to, updatedAt: FieldValue.serverTimestamp(), reviewedBy: admin.uid };
      if (action === 'request_changes') patch.changeRequestReason = reason.trim();
      if (action === 'reject') patch.rejectionReason = reason.trim();
      if (action === 'start_review') patch.reviewStartedAt = FieldValue.serverTimestamp();
      if (action === 'approve') patch.approvedAt = FieldValue.serverTimestamp();

      const batch = getDb().batch();
      batch.set(getDb().collection('creatorApplications').doc(uid), patch, { merge: true });

      if (action === 'approve') {
        const pub = appDoc.publicFields || {};
        const displayName = appDoc.creatorType === 'business' ? pub.businessDisplayName : pub.displayName;
        batch.set(getDb().collection('creators').doc(uid), {
          creatorType: appDoc.creatorType,
          displayName: displayName || null,
          profileImageUrl: pub.profileImageUrl || null,
          category: pub.category || null,
          publicLinks: Array.isArray(pub.socialHandles) ? pub.socialHandles : [],
          // Badge means identity/business-document verification only —
          // see blueprint §6. Business applications require at least one
          // reviewed document to reach APPROVED in the first place
          // (validateForSubmit), so this is an honest signal, not a
          // rubber stamp.
          verifiedBusiness: appDoc.creatorType === 'business',
          status: SELLER_STATES.ACTIVE,
          approvedAt: FieldValue.serverTimestamp(),
          createdAt: FieldValue.serverTimestamp(),
        }, { merge: true });
      }
      await batch.commit();

      await writeCreatorAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: `application.${action}`, targetType: 'application', targetId: uid, reason: reason || null });
      // start_review is an internal queue-management step, not something
      // the applicant needs an email about — only the other three are
      // actual outcomes for them.
      if (action !== 'start_review') {
        notifyApplicant(uid, 'creator_application_update', {
          status: spec.to,
          creator_type: appDoc.creatorType,
          reason: reason || null,
          display_name: action === 'approve' ? ((appDoc.publicFields || {}).displayName || (appDoc.publicFields || {}).businessDisplayName) : null,
        });
      }
      return ok(res, { status: spec.to });
    }

    if (Object.prototype.hasOwnProperty.call(SELLER_ACTIONS, action)) {
      const spec = SELLER_ACTIONS[action];
      if (spec.reasonRequired && (typeof reason !== 'string' || !reason.trim())) {
        return fail(res, { status: 422, code: 'REASON_REQUIRED', message: `A reason is required for "${action}".` });
      }
      const creator = await getCreatorDoc(uid);
      if (!creator) return fail(res, { status: 404, code: 'NOT_FOUND', message: 'No creator found for this uid.' });
      assertSellerTransition(creator.status, spec.to);

      const patch = { status: spec.to, updatedAt: FieldValue.serverTimestamp(), [spec.atField]: FieldValue.serverTimestamp() };
      if (spec.reasonField) patch[spec.reasonField] = reason ? reason.trim() : null;
      await getDb().collection('creators').doc(uid).set(patch, { merge: true });

      await writeCreatorAuditLog({ actorUid: admin.uid, actorRole: 'admin', action: `creator.${action}`, targetType: 'creator', targetId: uid, reason: reason || null });
      notifyApplicant(uid, 'creator_account_status', { status: spec.to, reason: reason || null });
      return ok(res, { status: spec.to });
    }

    return fail(res, { status: 400, code: 'INVALID_ACTION', message: `Unknown action "${action}".` });
  } catch (e) {
    return fail(res, e);
  }
};
