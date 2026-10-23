# LEXDEN NOVA — RESEARCH & SOURCE REGISTER

**Research checked:** 6 October 2026  
**Purpose:** Legal/policy drafting basis and uncertainty log. This is not a legal opinion.

## A. Nigeria data protection

### Nigeria Data Protection Act 2023 — primary law

Official NDPC copy:  
https://ndpc.gov.ng/download/nigeria-data-protection-act-2023

Relevant themes used in this package include lawful/fair/transparent processing, data-subject rights, direct-marketing objections, safeguards around certain automated decisions and the broader duties of controllers/processors.

### NDPC GAID 2025

Official NDPC publication:  
https://ndpc.gov.ng/wp-content/uploads/2025/03/NDP-ACT-GAID-2025-MARCH-20TH.pdf

The GAID was issued in 2025 and has an effective date of 19 September 2025 according to the NDPC journal. It provides operational guidance around compliance, registration, DPOs, transfers and other matters.

### NDPC resources / privacy guidance

https://ndpc.gov.ng/resources/  
https://ndpc.gov.ng/our-data-privacy-policy/

**Evidence category:** current official regulator material.

## B. Nigeria consumer protection

### Federal Competition and Consumer Protection Act 2018

FCCPC official resource:  
https://fccpc.gov.ng/resources-library/fccpa/

Consumer-rights page:  
https://fccpc.gov.ng/consumers/consumer-rights-responsibilities/rights-responsibilities/

Themes used: plain and understandable information, full price disclosure, qualifying cancellation/return rights, factually accurate marketing and complaint/redress.

### FCCPC 2026 Exposure Drafts

https://fccpc.gov.ng/resources-library/regulations/

The FCCPC's current materials identify the 2026 Consumer Protection Regulations and related Guidance/Explanatory materials as **Exposure Drafts**. They were therefore not treated in this package as settled binding law.

**Evidence category:** primary regulator material; exposure drafts separately labelled and not treated as final.

## C. Payments / marketplace settlement

### Paystack transaction splits

https://paystack.com/docs/api/split/  
https://paystack.com/docs/payments/split-payments/

Current Paystack documentation states that transaction splits can split settlement across a primary account and one or more subaccounts. Paystack support documentation updated 15 September 2026 explicitly describes transaction splits as useful for marketplace platforms that sell goods on behalf of vendors.

**Implication:** NOVA does not need to hand buyers to each seller's separate bank/payment page for an ordinary NOVA marketplace checkout merely to allow seller settlement. The precise structure still depends on NOVA's Paystack contract, business account status and implementation.

### Paystack ineligible businesses

https://support.paystack.com/en/articles/2127042

Current page edited 15 September 2026. It lists categories Paystack will not serve or may restrict, including illegal goods/services, counterfeit, certain weapons, gambling, unlicensed financial services, escrow services and other high-risk categories. Nigeria-specific restrictions include cryptocurrency trading, IMTO and forex/currency exchange, as well as Nigerian Customs prohibition/restriction issues.

**Implementation implication:** a broad "sell everything lawful" marketplace still needs a provider-compatibility gate and cannot promise that every legally permissible category is payable through Paystack.

### Paystack international payments

https://support.paystack.com/en/articles/2127682

Current page edited 16 September 2026. Paystack states that businesses can accept international customers, but certain categories are ineligible and some categories receive additional scrutiny. E-books and other digital products may require additional documentation.

**Implication:** international buyers are viable as a product goal, but not every seller/category/payment flow will qualify automatically.

### CBN payment-system reference

https://www.cbn.gov.ng/PaymentsSystem/PSPs.html

The CBN lists Paystack Payment Limited among switching/processing licensees in its published Payment Service Providers list and describes payment-system oversight.

**Evidence category:** current regulator/provider documentation.

## D. Copyright / online content

### Copyright Act 2022

Nigerian Copyright Act source copy:  
https://www.copyright.gov.ng/CopyrightAct/CopyrightAct2023FinalPublication1.pdf

Part VII includes online-content provisions on copyright-holder notice requesting takedown/disablement of infringing content or links, with required notice information.

**Evidence category:** primary legislation.

## E. Business registration

### Corporate Affairs Commission

Official portal:  
https://icrp.cac.gov.ng/

The portal references CAMA 2020 and provides company/business registration services.

**Implication:** NOVA should not invent a registered company identity. Before final public contracting language is used, LEXDEN should select and document the actual operator/legal structure.

## F. International-user uncertainty

NOVA intends to serve international buyers, but "international" is not one law. Applicability depends on the buyer's location, seller location, transaction type, product/service, data processing context and the nature of NOVA's activity.

Therefore this package uses:

> "subject to applicable law" and "where legally required"

rather than falsely claiming universal global compliance.

Country-specific expansion should add jurisdiction modules instead of rewriting the Nigerian core terms every time.

## G. Important drafting decisions caused by current research

### 1. Seller-direct payments

**Decision:** not the default for ordinary NOVA marketplace transactions. Use controlled NOVA checkout where possible; external seller checkout is a separate clearly labelled transaction class.

**Why:** better payment verification, auditability, refund handling, fraud controls and consistent buyer disclosures. Paystack currently documents split-payment functionality compatible with marketplace settlement.

### 2. Under-18 users

**Decision:** permit appropriate free/public access while age-gating Creator selling, payout and other high-risk features by default.

**Why:** a free resource is not automatically outside privacy/child-safety requirements. A blanket site-wide 18+ rule would also unnecessarily block the educational/resource mission.

### 3. Fees

**Decision:** do not hard-code legal text to a permanent 5%/2.5% promise. The configured rate can change; the applicable rate must be shown before commitment and historical transactions need snapshots.

### 4. AI responsibility

**Decision:** honor the user's requested model that AI actions are user-requested/user-approved, but do not use an absolute "LEXDEN is never responsible" clause. A lawful limitation must preserve non-waivable liability and NOVA's own duties concerning unauthorized execution/security failures.

## H. Claims deliberately NOT made

This package does not claim:

- that NOVA is already legally registered;
- that NOVA is automatically a licensed payment institution;
- that Paystack approves every marketplace category;
- that a verification badge guarantees seller honesty;
- that all international buyers receive identical statutory rights;
- that a 24-hour Creator approval time is an absolute guarantee;
- that every automated decision is legally conclusive;
- that a particular tax/VAT treatment is universally correct;
- that a seller's external checkout is protected by NOVA.
