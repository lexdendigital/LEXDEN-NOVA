# Changelog

## 2026-10-21 — Marketplace money, inventory and policy upgrade
### Added
- Integer-kobo fee engine; 10% creator commission with per-sale snapshot; 5% affiliate withdrawal fee with preview and snapshot.
- Delivery-gated earnings; 14-day dispute window after confirmed delivery; per-category policy snapshots.
- Refund lifecycle with provider confirmation; webhook refund events.
- Inventory Hub: atomic reservations, immutable movements, variants/locations, CSV import, channel mapping, reservation-expiry job. Endpoints `creator-inventory`, `creator-checkout`.
- Order exceptions (`creator-admin-exceptions`).
- CJ funding gate (`CJ_FUNDING_MODE`).
- Delivery proof code + rider task token (`delivery-proof`); pickup station rules.
- Documents & Policies Centre (`legal/`, `scripts/build-policies.js`, `policy-accept`, `policy-internal`).
- Creator Earnings view and endpoint (`creator-earnings`); creator nav Home·Products·Orders·Store·Earnings.
- Migration dry-run script; Firestore rules for new collections.
- Merged upstream 2026-10-19 structured product listing fields, SEO/FAQ metadata.
### Changed
- Creator checkout requires the exact amount; seller must be ACTIVE; stock is consumed once per order.
- Listings without a stock number are out of stock. Dispute window 72h → 14 days. "Escrow" wording removed. Legal links are first-party.
### Fixed (found by independent review)
- Refund webhook could complete the wrong refund; held orders could consume stock on retry; webhook ignored the buyer's reservation; exceptions could permanently strand earnings; rejected disputes could release held earnings; delivery codes could start the clock on cancelled orders; stub documents; unknown delivery confirmer defaulted to authoritative.
### Known limitations
See IMPLEMENTATION-REPORT.md.
