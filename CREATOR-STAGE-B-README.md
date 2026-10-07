# LEXDEN NOVA CREATOR — Stage B delivery

The actual onboarding UI, wired to the Stage A backend. Nothing here
changes Stage A's API contracts — this is purely the frontend.

## What's live

**Shopper-facing** (`#creator` route in `index.html`, linked from Profile →
"Become a Creator"):
- Intro screen → Personal/Business chooser
- Application form, fields switch based on creator type (matches
  `api/creator/validation.js` exactly — nothing in the form asks for
  something the backend doesn't also require, and vice versa)
- Profile image → Cloudinary (via the app's existing `cloudinaryUploadFile`
  helper, same path every other image upload uses)
- Business document → `/api/creator-documents` (the **private** Storage
  path from Stage A, not Cloudinary — confidential documents stay off the
  public image pipeline)
- Save Draft / Submit, with field-level validation errors surfaced inline
- Status screens for SUBMITTED/IN_REVIEW, CHANGES_REQUESTED (shows the
  admin's reason, re-opens the form), REJECTED (shows reason, offer to
  re-apply), APPROVED

**Admin-facing** (new "Creator Applications" tab, same place as "Affiliate
Program"):
- Review queue split by status (Submitted → Start Review → In Review →
  Approve/Request Changes/Reject), each reason-requiring action prompts
  for the reason that gets emailed to the applicant
- Active Creators list with Restrict/Suspend/Revoke/Reactivate — reads
  `creators/{uid}` directly via client Firestore (that collection is
  openly readable per `firestore.rules`, same shortcut the rest of the
  admin portal already takes for public collections)

## What's still deliberately not here

Stage C onward (product creation, delivery, money, logistics, automation,
Creator AI). The APPROVED screen says as much to the creator directly
rather than implying a dashboard exists that doesn't yet.

## One real find before I built this

**The Paystack public/secret key mismatch described in the main chat
reply** — caught while building the live/test toggle, fixed by disabling
checkout rather than leaving a state where a real card could be charged
against a verification call that would always fail.
