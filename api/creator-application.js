// /api/creator-application.js
//
// LEXDEN NOVA CREATOR — Stage A.
//
// GET  /api/creator-application   -> the signed-in user's own application +
//                                     creator status (NOT_APPLIED if neither
//                                     document exists yet)
// POST /api/creator-application   -> { action: 'save_draft' | 'submit', ...fields }
//
// Split of fields, matching blueprint §34 (Privacy/KYC architecture):
//   creatorApplications/{uid}.publicFields  — category, displayName,
//     businessDisplayName, profileImageUrl, socialHandles,
//     deliveryOperatingArea, willSellPhysical
//   creatorPrivate/{uid}                     — legalName, dob, email, phone,
//     legalBusinessName, contactName, whatsapp, documentIds,
//     acceptedTermsAt
// Only an owner or the admin can ever read either (firestore.rules); only
// this file (running under the Admin SDK) ever writes them — the client
// has zero direct Firestore write path to either collection.
const { getDb, FieldValue, requireAuth, getApplicationDoc, writeCreatorAuditLog, ok, fail, setCors } = require('./creator/shared');
const { APPLICATION_STATES, assertApplicationTransition, assertNoDuplicateApplication } = require('./creator/state-machine');
const { validateDraft, validateForSubmit } = require('./creator/validation');

// Fields a creator is allowed to set themselves. Anything else in the
// request body is silently dropped — this is what makes "do not trust
// these frontend fields" (Implementation README §55) structurally true
// for this endpoint rather than a convention someone has to remember.
const PUBLIC_FIELD_KEYS = ['category', 'displayName', 'businessDisplayName', 'profileImageUrl', 'socialHandles', 'deliveryOperatingArea', 'willSellPhysical'];
const PRIVATE_FIELD_KEYS = ['legalName', 'dob', 'email', 'phone', 'legalBusinessName', 'contactName', 'whatsapp', 'documentIds'];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

module.exports = async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();

  let decoded;
  try {
    decoded = await requireAuth(req);
  } catch (e) {
    return fail(res, e);
  }
  const uid = decoded.uid;

  if (req.method === 'GET') {
    try {
      const appDoc = await getApplicationDoc(uid);
      if (!appDoc) return ok(res, { status: 'NOT_APPLIED' });
      // Owner reading their own application — safe to include their own
      // private fields back to them (it's their data); never includes
      // another applicant's.
      const privSnap = await getDb().collection('creatorPrivate').doc(uid).get();
      return ok(res, {
        status: appDoc.status,
        creatorType: appDoc.creatorType || null,
        publicFields: appDoc.publicFields || {},
        privateFields: privSnap.exists ? privSnap.data() : {},
        rejectionReason: appDoc.rejectionReason || null,
        changeRequestReason: appDoc.changeRequestReason || null,
        submittedAt: appDoc.submittedAt || null,
      });
    } catch (e) {
      return fail(res, e);
    }
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET or POST.' } });
  }

  const body = req.body || {};
  const action = body.action;
  if (action !== 'save_draft' && action !== 'submit') {
    return fail(res, { status: 400, code: 'INVALID_ACTION', message: 'action must be "save_draft" or "submit".' });
  }

  try {
    const existing = await getApplicationDoc(uid);
    const currentStatus = existing ? existing.status : null;

    if (action === 'save_draft') {
      // Creating the FIRST draft: must not already have a non-terminal
      // (or APPROVED) application — the duplicate-application guard.
      if (!existing) {
        assertNoDuplicateApplication(null);
        assertApplicationTransition(null, APPLICATION_STATES.APPLICATION_DRAFT);
      } else if (currentStatus !== APPLICATION_STATES.APPLICATION_DRAFT && currentStatus !== APPLICATION_STATES.CHANGES_REQUESTED) {
        // Editing is only allowed pre-submission or while the admin has
        // explicitly asked for changes — not while SUBMITTED/IN_REVIEW
        // (would let an applicant silently alter what's being reviewed)
        // nor after a terminal decision.
        return fail(res, { status: 409, code: 'NOT_EDITABLE', message: `Cannot edit an application while it is ${currentStatus}.` });
      }

      const { ok: valid, errors } = validateDraft(body);
      if (!valid) return fail(res, { status: 422, code: 'VALIDATION_FAILED', message: 'Some fields are invalid.', errors });

      const publicPatch = pick(body, PUBLIC_FIELD_KEYS);
      const privatePatch = pick(body, PRIVATE_FIELD_KEYS);
      if (body.acceptTerms === true) privatePatch.acceptedTermsAt = FieldValue.serverTimestamp();

      const batch = getDb().batch();
      const appRef = getDb().collection('creatorApplications').doc(uid);
      batch.set(appRef, {
        creatorType: body.creatorType || (existing && existing.creatorType) || null,
        status: existing ? currentStatus : APPLICATION_STATES.APPLICATION_DRAFT,
        publicFields: { ...(existing && existing.publicFields), ...publicPatch },
        updatedAt: FieldValue.serverTimestamp(),
        ...(existing ? {} : { createdAt: FieldValue.serverTimestamp() }),
      }, { merge: true });
      const privRef = getDb().collection('creatorPrivate').doc(uid);
      batch.set(privRef, { ...privatePatch, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await batch.commit();

      await writeCreatorAuditLog({ actorUid: uid, actorRole: 'creator', action: existing ? 'application.draft_updated' : 'application.draft_started', targetType: 'application', targetId: uid });
      return ok(res, { status: existing ? currentStatus : APPLICATION_STATES.APPLICATION_DRAFT });
    }

    // action === 'submit'
    if (!existing) {
      return fail(res, { status: 409, code: 'NO_DRAFT', message: 'Save a draft before submitting.' });
    }
    assertApplicationTransition(currentStatus, APPLICATION_STATES.SUBMITTED);

    const privSnap = await getDb().collection('creatorPrivate').doc(uid).get();
    const privateFields = privSnap.exists ? privSnap.data() : {};
    const { ok: valid, errors } = validateForSubmit({
      creatorType: existing.creatorType,
      publicFields: existing.publicFields || {},
      privateFields,
      willSellPhysical: !!(existing.publicFields && existing.publicFields.willSellPhysical),
    });
    if (!valid) return fail(res, { status: 422, code: 'VALIDATION_FAILED', message: 'Your application is missing required information.', errors });

    await getDb().collection('creatorApplications').doc(uid).set({
      status: APPLICATION_STATES.SUBMITTED,
      submittedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      rejectionReason: null,
      changeRequestReason: null,
    }, { merge: true });

    await writeCreatorAuditLog({ actorUid: uid, actorRole: 'creator', action: 'application.submitted', targetType: 'application', targetId: uid });
    return ok(res, { status: APPLICATION_STATES.SUBMITTED });
  } catch (e) {
    return fail(res, e);
  }
};
