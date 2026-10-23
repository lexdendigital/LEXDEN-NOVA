# Deployment checklist

## New environment variables (all optional; defaults are the safe choice)
| Variable | Default | Meaning |
|---|---|---|
| `CJ_FUNDING_MODE` | `DISABLED` | `CREATOR_ACCOUNT` = creator pays in their own CJ account (explicit opt-in). `NOVA_FUNDED` is not implemented and fails safe. |
| `PAYSTACK_REFUNDS_ENABLED` | off | Send refunds through the Paystack API. Test in sandbox first. |
| `POLICY_PUBLICATION_APPROVED` | off | Removes the DRAFT banner at policy build time. The build refuses while placeholders remain. |
| `INVENTORY_CHANNEL_SYNC_ENABLED` | off | Has no effect until a real channel adapter exists. |
| `PICKUP_STATIONS_ENABLED` | off | Pickup stations (no UI yet). |
| `RIDER_VAULT_ENABLED` | off | Rider code entry. |
| `DELIVERY_CODE_SECRET` | — | **Required** (24+ chars, random) before delivery codes can be issued. Missing = codes disabled (fails closed). |
| `MCP_HIGH_RISK_TOOLS` | blocked | Existing switch; leave blocked. |

## Steps
- [ ] Backup Firestore. [ ] Run migration dry run. [ ] Set `DELIVERY_CODE_SECRET`.
- [ ] Deploy backend; check `/api/creator-profile` shows 10%.
- [ ] `node scripts/migrate-upgrade.js --apply`.
- [ ] `npm run build:policies`; publish site including `legal/`.
- [ ] Publish `firestore.rules`.
- [ ] Run STAGING-SMOKE-TEST-CHECKLIST.md on staging first.
- [ ] Cron: the `reservations` job runs with the existing automation scheduler (`creator-cron`).

## Do NOT go live publicly until
Legal entity details, effective dates, privacy/cookie inventory, ADR route, tax position and a Nigerian legal review are done (`policies/src/implementation/28_PUBLICATION_BLOCKERS.md`), the staging checklist passes, and you have decided the creator withdrawal fee.
