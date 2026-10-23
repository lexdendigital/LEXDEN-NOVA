# LEXDEN NOVA — INTERNAL AI GOVERNANCE & HUMAN-OVERSIGHT POLICY

**Status:** Operational baseline

## 1. AI role

NOVA AI is an assistant operating inside defined permissions. It is not an unrestricted administrator.

## 2. Action classes

### Read-only

Search, summarize, classify, inspect permitted information.

### User-authorized reversible actions

Examples: create draft, organize data, generate a support response, prepare a listing change.

### User-authorized consequential actions

Examples: submit a product version, request a payout, alter a customer-facing policy or perform another action with material business impact.

### Restricted actions

Actions affecting high-risk compliance, irreversible deletion, sanctions/ban decisions, large financial movement or other critical controls should require explicit human authorization and, where appropriate, admin controls.

## 3. Authorization chain

AI action:

`Authentication → Tenant authorization → Policy check → Risk check → User confirmation → Action → Audit log`

## 4. Unapproved action

If AI acts without requested/approved authorization, stop the affected workflow where possible, preserve logs, notify NOVA support/security and investigate immediately.

## 5. Human oversight

Use human review for high-impact decisions, ambiguous fraud/abuse determinations, safety-critical product decisions and material account/payout restrictions.

## 6. Prompt/input handling

Do not unnecessarily expose KYC, secrets, payment credentials or unrelated private data to AI providers. Minimize retained prompts and tool outputs.

## 7. Vendor changes

Every external AI model/provider must be assessed against its current terms, data practices, security and regional availability before production use.
