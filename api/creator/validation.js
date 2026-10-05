// api/creator/validation.js
//
// Server-side validation for creator application payloads. Pure functions
// (input object in, {ok, errors} or throw out) — no Firestore, no req/res —
// so they're unit-testable the same way state-machine.js is.
//
// Blueprint §4 "Eligibility and age safeguards": the system must not
// encourage a false DOB to unlock creator functionality. This module
// enforces a minimum age for the PERSONAL route and points anyone under it
// at the Business route instead (a parent/guardian-operated or registered
// entity), rather than silently accepting an implausible DOB.
const MIN_PERSONAL_CREATOR_AGE = 18;

const CATEGORIES = Object.freeze([
  'apps', 'courses', 'templates', 'ebooks', 'software', 'services', 'physical', 'mixed',
]);

function isNonEmptyString(v, max) {
  return typeof v === 'string' && v.trim().length > 0 && (!max || v.trim().length <= max);
}

function isValidEmail(v) {
  return isNonEmptyString(v, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

// E.164-ish: + and 7-15 digits. Deliberately loose — real carrier
// validation isn't this module's job.
function isValidPhone(v) {
  return isNonEmptyString(v, 20) && /^\+?[0-9]{7,15}$/.test(v.trim());
}

function isValidUrl(v) {
  if (!isNonEmptyString(v, 2048)) return false;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function ageFromDob(dobIso) {
  const dob = new Date(dobIso);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/** Validates the DRAFT payload (fields a creator can save before
 * submitting — lenient, partial saves are fine). Returns {ok, errors}. */
function validateDraft(body) {
  const errors = [];
  const creatorType = body && body.creatorType;
  if (creatorType !== 'personal' && creatorType !== 'business') {
    errors.push({ field: 'creatorType', message: 'creatorType must be "personal" or "business".' });
  }
  if (body && body.category != null && !CATEGORIES.includes(body.category)) {
    errors.push({ field: 'category', message: `category must be one of: ${CATEGORIES.join(', ')}.` });
  }
  return { ok: errors.length === 0, errors };
}

/** Validates that an application is COMPLETE enough to submit
 * (APPLICATION_DRAFT -> SUBMITTED). Strict — every field the blueprint's
 * §5 lists as required for the chosen creator type must be present and
 * well-formed. `privateFields` and `publicFields` mirror the Firestore
 * split in creatorPrivate/{uid} vs creatorApplications/{uid}. */
function validateForSubmit({ creatorType, publicFields, privateFields, willSellPhysical }) {
  const errors = [];
  const pub = publicFields || {};
  const priv = privateFields || {};

  if (creatorType !== 'personal' && creatorType !== 'business') {
    errors.push({ field: 'creatorType', message: 'creatorType must be "personal" or "business".' });
    return { ok: false, errors }; // nothing else can be validated meaningfully without this
  }

  if (!isNonEmptyString(pub.category) || !CATEGORIES.includes(pub.category)) {
    errors.push({ field: 'category', message: `category is required and must be one of: ${CATEGORIES.join(', ')}.` });
  }
  // Public-facing name — NEVER the legal name/legal business name. This is
  // the field creators/{uid} (the public doc) is built from on approval;
  // see blueprint §3 "Important identity rule".
  const publicNameField = creatorType === 'business' ? 'businessDisplayName' : 'displayName';
  if (!isNonEmptyString(pub[publicNameField], 80)) {
    errors.push({ field: publicNameField, message: `A public ${creatorType === 'business' ? 'business display name' : 'display name'} is required (shown to buyers — your legal name never is).` });
  }
  if (!isValidUrl(pub.profileImageUrl)) {
    errors.push({ field: 'profileImageUrl', message: 'A profile image is required.' });
  }
  if (!priv.acceptedTermsAt) {
    errors.push({ field: 'acceptedTermsAt', message: 'You must accept the Creator Terms and Marketplace Rules.' });
  }
  if (willSellPhysical && !pub.deliveryOperatingArea) {
    errors.push({ field: 'deliveryOperatingArea', message: 'A delivery operating area is required when selling physical products.' });
  }

  if (creatorType === 'personal') {
    if (!isNonEmptyString(priv.legalName, 200)) {
      errors.push({ field: 'legalName', message: 'Legal/original name is required.' });
    }
    if (!priv.dob) {
      errors.push({ field: 'dob', message: 'Date of birth is required.' });
    } else {
      const age = ageFromDob(priv.dob);
      if (age == null) {
        errors.push({ field: 'dob', message: 'Date of birth is not a valid date.' });
      } else if (age < MIN_PERSONAL_CREATOR_AGE) {
        errors.push({
          field: 'dob',
          message: `Personal Creator accounts require applicants to be at least ${MIN_PERSONAL_CREATOR_AGE}. If you're younger than this, a parent/guardian-operated or registered Business Creator account is the eligible route instead.`,
          code: 'BELOW_MIN_AGE',
        });
      }
    }
    if (!isValidEmail(priv.email)) errors.push({ field: 'email', message: 'A valid email is required.' });
    if (!isValidPhone(priv.phone)) errors.push({ field: 'phone', message: 'A valid phone number is required.' });
  }

  if (creatorType === 'business') {
    if (!isNonEmptyString(priv.legalBusinessName, 200)) {
      errors.push({ field: 'legalBusinessName', message: 'Legal business name is required.' });
    }
    if (!isNonEmptyString(priv.contactName, 200)) {
      errors.push({ field: 'contactName', message: 'A creator/admin contact name is required.' });
    }
    if (!isValidEmail(priv.email)) errors.push({ field: 'email', message: 'A valid email is required.' });
    if (!isValidPhone(priv.whatsapp)) errors.push({ field: 'whatsapp', message: 'A valid WhatsApp/customer-care number is required.' });
    const socials = Array.isArray(pub.socialHandles) ? pub.socialHandles.filter(isValidUrl) : [];
    if (socials.length < 1) {
      errors.push({ field: 'socialHandles', message: 'At least one social-media handle is required.' });
    }
    if (!Array.isArray(priv.documentIds) || priv.documentIds.length < 1) {
      errors.push({ field: 'documentIds', message: 'At least one business/identity document must be uploaded (see /api/creator-documents).' });
    }
  }

  return { ok: errors.length === 0, errors };
}

module.exports = { CATEGORIES, MIN_PERSONAL_CREATOR_AGE, ageFromDob, isValidEmail, isValidPhone, isValidUrl, validateDraft, validateForSubmit };
