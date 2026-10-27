'use strict';

/* =========================================================
   LEXDEN NOVA — single-file app
   Sections: DATA -> STATE/STORAGE -> HELPERS -> ROUTER ->
   SHELL(header/nav) -> SCREENS -> ADMIN -> NOVA AI -> INIT
   ========================================================= */

/* ---------------- DEFAULT DATA (seed) ---------------- */
const DEFAULT_CATEGORIES = [
  {id:'all', name:'All'},
  {id:'courses', name:'Courses'},
  {id:'templates', name:'Templates'},
  {id:'software', name:'Software'},
  {id:'bundles', name:'Bundles'},
  {id:'ebooks', name:'eBooks'},
  {id:'computers', name:'Computers'},
  {id:'phones', name:'Phones'},
  {id:'accessories', name:'Accessories'},
];
// Categories whose products are physical hardware rather than digital
// downloads. Used to show hardware-relevant fields (condition, warranty,
// brand/model) on the admin product form instead of digital-only fields.
const HARDWARE_CATEGORY_IDS = ['computers','phones','accessories','gadgets'];

// NOTE: the rating/reviewCount values below are historical placeholders
// only — DB.products' getter (see STATE/STORAGE section) always overwrites
// them with the real, live-computed figures from actual submitted reviews
// before anything in the app reads them. Nothing displays these raw
// numbers directly anymore.
const DEFAULT_PRODUCTS = [
  {id:'p1', name:'Social Media Growth Mastery', category:'courses', price:19.99, salePrice:12.99, rating:4.8, reviewCount:212, itemCode:'LX-COU-101',
   image:'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=600&q=80',
   gallery:['https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=800&q=80','https://images.unsplash.com/photo-1432888622747-4eb9a8efeb07?w=800&q=80'],
   description:'A complete course teaching how to grow an audience on Instagram, TikTok and YouTube from zero, including content calendars, hook-writing and monetization strategy.',
   specs:{'Format':'Video course (6h)','Level':'Beginner–Intermediate','Access':'Lifetime','Certificate':'Yes'},
   affiliateLink:'#', tags:['social media','growth','marketing'], seller:'CreatorLab', featured:true, trending:true, status:'published'},
  {id:'p2', name:'Canva Pro Template Pack — 120 Designs', category:'templates', price:14.99, salePrice:8.49, rating:4.6, reviewCount:97, itemCode:'LX-TPL-204',
   image:'https://images.unsplash.com/photo-1626785774573-4b799315345d?w=600&q=80',
   gallery:['https://images.unsplash.com/photo-1626785774573-4b799315345d?w=800&q=80'],
   description:'120 fully editable Canva templates for Instagram posts, stories, and carousels. Drag, drop, and rebrand in minutes — no design skill needed.',
   specs:{'Format':'Canva link','Files':'120 templates','License':'Personal + commercial'},
   affiliateLink:'#', tags:['canva','design','social'], seller:'PixelForge', featured:true, trending:true, status:'published'},
  {id:'p3', name:'NovaCode — AI Code Assistant (1yr)', category:'software', price:59, salePrice:39, rating:4.7, reviewCount:154, itemCode:'LX-SFT-310',
   image:'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=600&q=80',
   gallery:['https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=800&q=80'],
   description:'A lightweight AI coding assistant plugin supporting JS, Python and React. Autocomplete, refactors, and inline explanations right in your editor.',
   specs:{'License':'1 year, 1 device','Platforms':'VS Code, JetBrains','Updates':'Included'},
   affiliateLink:'#', tags:['software','ai','coding'], seller:'DevTools Inc', featured:false, trending:true, status:'published'},
  {id:'p4', name:'Freelance Starter Bundle', category:'bundles', price:29, salePrice:17, rating:4.9, reviewCount:301, itemCode:'LX-BND-050',
   image:'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?w=600&q=80',
   gallery:['https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?w=800&q=80'],
   description:'Everything you need to start freelancing: contract templates, a pricing calculator, a pitch-deck template, and a 30-day client outreach plan.',
   specs:{'Includes':'5 resources','Format':'PDF + Docs','Access':'Lifetime'},
   affiliateLink:'#', tags:['freelance','business','templates'], seller:'Lexden Digital', featured:true, trending:false, status:'published'},
  {id:'p5', name:'Beat The Algorithm — TikTok eBook', category:'ebooks', price:9.99, salePrice:5.99, rating:4.4, reviewCount:88, itemCode:'LX-EBK-071',
   image:'https://images.unsplash.com/photo-1611262588024-d12430b98920?w=600&q=80',
   gallery:['https://images.unsplash.com/photo-1611262588024-d12430b98920?w=800&q=80'],
   description:'A concise, no-fluff eBook explaining exactly how the TikTok algorithm ranks content in 2026, with a 14-day posting plan.',
   specs:{'Pages':'64','Format':'PDF + EPUB'},
   affiliateLink:'#', tags:['tiktok','ebook','growth'], seller:'CreatorLab', featured:false, trending:true, status:'published'},
  {id:'p6', name:'Excel & Data Skills Bootcamp', category:'courses', price:24.99, salePrice:14.99, rating:4.7, reviewCount:176, itemCode:'LX-COU-142',
   image:'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=600&q=80',
   gallery:['https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=800&q=80'],
   description:'From basic formulas to pivot tables and dashboards — a practical Excel course built for job-seekers and small business owners.',
   specs:{'Format':'Video course (8h)','Level':'Beginner','Certificate':'Yes'},
   affiliateLink:'#', tags:['excel','office','skills'], seller:'SkillForge', featured:false, trending:false, status:'published'},
  {id:'p7', name:'Minimal Portfolio Website Template', category:'templates', price:12, salePrice:7, rating:4.5, reviewCount:63, itemCode:'LX-TPL-233',
   image:'https://images.unsplash.com/photo-1467232004584-a241de8bcf5d?w=600&q=80',
   gallery:['https://images.unsplash.com/photo-1467232004584-a241de8bcf5d?w=800&q=80'],
   description:'A clean, responsive HTML/CSS portfolio template — perfect for designers, developers, and freelancers who want to launch fast.',
   specs:{'Format':'HTML/CSS/JS','Responsive':'Yes','License':'Personal + commercial'},
   affiliateLink:'#', tags:['portfolio','website','template'], seller:'PixelForge', featured:false, trending:false, status:'published'},
  {id:'p8', name:'Budget Tracker Pro (Sheets)', category:'software', price:11, salePrice:6.5, rating:4.6, reviewCount:120, itemCode:'LX-SFT-088',
   image:'https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=600&q=80',
   gallery:['https://images.unsplash.com/photo-1554224155-6726b3ff858f?w=800&q=80'],
   description:'A Google Sheets budgeting system with automatic charts, savings goals, and monthly summaries. No installation needed.',
   specs:{'Format':'Google Sheets','Setup':'Copy & go'},
   affiliateLink:'#', tags:['budget','finance','sheets'], seller:'Lexden Digital', featured:false, trending:false, status:'published'},
];

const DEFAULT_TESTIMONIALS = [
  {id:'t1', productId:'p1', name:'Amara O.', rating:5, text:'Grew my page from 800 to 14k followers in two months using the hook formulas in this course. Worth way more than the price.', date:'2026-05-02'},
  {id:'t2', productId:'p1', name:'Kwame B.', rating:4, text:'Solid course, very practical. Wish it covered YouTube Shorts a bit more but still great value.', date:'2026-04-18'},
  {id:'t3', productId:'p2', name:'Fatima S.', rating:5, text:'These templates saved me hours every week. Rebranding takes minutes now.', date:'2026-03-30'},
  {id:'t4', productId:'p4', name:'Tunde A.', rating:5, text:'Landed my first 3 freelance clients using the pitch deck template. Incredible bundle.', date:'2026-06-01'},
];

const DEFAULT_FAQS = [
  {id:'f1', q:'How do I purchase a product?', a:'Tap any product to open its detail page, then tap the Buy Now button at the bottom. What happens next depends on the product: most pay in-app through Paystack (card, bank transfer or USSD, no new tab), free items just open a direct access link, and a smaller number send you to that seller\'s own external checkout page in a new tab instead.'},
  {id:'f2', q:'Are these products sold by LEXDEN NOVA?', a:'It depends on the item. Some products are from partner companies we review (we may earn a commission when you buy through our links, at no extra cost to you). Others are sold by independent creators through LEXDEN NOVA checkout; the seller is shown on the product page.'},
  {id:'f3', q:'Can I get a refund?', a:'For items you pay for through LEXDEN NOVA checkout you can open a dispute from your order, and a refund is shown as completed only after the payment provider confirms it. For partner items bought on another site, that partner\'s policy applies. See Documents & Policies → Refunds, Returns & Disputes (currently a draft pending review).'},
  {id:'f4', q:'Is my wishlist saved if I close the app?', a:'Yes — your wishlist is saved on this device automatically. You can also export it as a file from the Wishlist screen.'},
  {id:'f5', q:'How do I contact support?', a:'Use the WhatsApp or email links in the Menu screen, or ask NOVA AI right here in the chat.'},
];

const DEFAULT_LOGO_DATA_URI = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' x2='1' y1='0' y2='1'%3E%3Cstop offset='0' stop-color='%2300d9ff'/%3E%3Cstop offset='1' stop-color='%23ff006e'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='100' height='100' rx='24' fill='%230a0e27'/%3E%3Ctext x='50' y='66' font-size='54' font-family='Arial' font-weight='900' fill='url(%23g)' text-anchor='middle'%3EN%3C/text%3E%3C/svg%3E";

const DEFAULT_SERVICES = [
  {id:'sv1', ic:'code', title:'Custom Software Development', desc:'Bespoke web & desktop applications built around your business processes, from idea to deployment.'},
  {id:'sv2', ic:'mobile', title:'Mobile App Development', desc:'Native and cross-platform Android/iOS apps — from MVP to full-scale products.'},
  {id:'sv3', ic:'brain', title:'Enterprise AI Integration', desc:'We embed AI assistants, automation and data intelligence directly into your existing systems.'},
  {id:'sv4', ic:'shield', title:'Cybersecurity Infrastructure', desc:'Security audits, hardening and monitoring so your systems and customer data stay protected.'},
  {id:'sv5', ic:'globe', title:'Website Building', desc:'Fast, modern, mobile-first websites and storefronts — like this one — built for real businesses.'},
  {id:'sv6', ic:'graduation', title:'Tech Talent & Digital Literacy Training', desc:'LEXDEN ACADEMY programs that scale practical tech skills for individuals and teams.'},
];
function serviceIcon(ic){ return ICONS[ic] ? icon(ic) : escapeHtml(ic||''); }

const DEFAULT_FEED_POSTS = [
  {id:'fp1', title:'Creator testimonial: "This changed my workflow"', body:'One of our users walked us through how the Social Media Growth Mastery course completely changed how she plans content — from random posting to a proper weekly system. Watch the short clip below and see the before/after screenshots of her growth.',
   media:[{type:'image', url:'https://images.unsplash.com/photo-1611926653458-09294b3142bf?w=900&q=80'}], date:'2026-06-20', important:false},
  {id:'fp2', title:'Behind the scenes: how we test products', body:'Every product listed on LEXDEN NOVA is used hands-on by our team before it goes live — we check the actual course content, template quality, or software reliability, not just the sales page. Here is a quick look at our review process.',
   media:[{type:'image', url:'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=900&q=80'}], date:'2026-06-12', important:false},
  {id:'fp3', title:'New drop: Freelance Starter Bundle', body:'We just added the Freelance Starter Bundle to the catalog — contracts, a pricing calculator, a pitch-deck template and a 30-day outreach plan, all in one pack. Tap through to see the full gallery and details.',
   media:[{type:'image', url:'https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=900&q=80'}], productId:'p4', date:'2026-06-01', important:true},
];

const DEFAULT_MANAGEMENT = [
  {id:'m1', name:'Lexden Digital', role:'Founder & Team', bio:'The team behind LEXDEN DIGITAL and LEXDEN NOVA — edit this in Admin → App Content → About Us to add real names, roles and bios.'},
];

const DEFAULT_CONTENT = {
  logoUrl: DEFAULT_LOGO_DATA_URI,
  appName:'LEXDEN NOVA',
  // Product prices are stored in USD (the neutral base). displayCurrency is
  // what shoppers see by default; admin can change it and/or let users switch.
  displayCurrency:'NGN',
  // Units of each currency per 1 USD. Admin can edit these, or the app will
  // try to auto-refresh them from a free public rates API when online.
  // PHASE 3: added GBP, TZS, UGX, XAF, XOF, RWF, ZMW for browsing/price
  // display across West/East/Southern/Central African audiences. These are
  // seed values only — tryRefreshExchangeRates() overwrites them with live
  // rates for any code present here as soon as the app is online. NOT all
  // of these are currencies Paystack can actually charge in on this
  // account — see PAYSTACK_CHARGEABLE_CURRENCIES below, which is the one
  // that actually governs checkout.
  exchangeRates:{
    NGN:1550, USD:1, EUR:0.92, GHS:15.5, KES:129, ZAR:18.5, EGP:49,
    GBP:0.79, TZS:2600, UGX:3700, XAF:603, XOF:603, RWF:1300, ZMW:27,
  },
  currencySymbols:{
    NGN:'₦', USD:'$', EUR:'€', GHS:'GH₵', KES:'KSh', ZAR:'R', EGP:'E£',
    GBP:'£', TZS:'TSh', UGX:'USh', XAF:'FCFA', XOF:'CFA', RWF:'R₣', ZMW:'ZMW',
  },
  ratesUpdatedAt:'',
  heroTag:'Free tools, ideas & digital services',
  heroTitle:'One home for your digital needs.',
  heroSub:'Explore free resources alongside apps, courses, templates, eBooks, software, services and selected physical products.',
  heroCta:'Explore Lexden Nova',
  aboutText:'LEXDEN NOVA curates the best digital products on the internet so you don\'t have to dig through ads to find them. We test, rate, and showcase courses, templates, software and bundles from trusted partners.',
  missionText:'To make finding trustworthy digital products effortless — every course, template, tool and bundle on LEXDEN NOVA is reviewed hands-on before it goes live, so customers spend less time guessing and more time using what they bought.',
  visionText:'To become the most trusted digital products showcase for creators and small businesses across Africa and beyond — a place people return to before buying anything digital.',
  buyButtonText:'Get Now',
  contactEmail:'lexdendigital@gmail.com',
  whatsappNumber:'09129319257',
  whatsappDisplay:'+234 912 931 9257',
  whatsappUsername:'@lexdendigital01',
  youtube:'@lexdendigital',
  tiktok:'@lexden.digital',
  instagram:'@lexdendigital',
  facebook:'Lexden Digital',
  footerCopyright:'© 2026 LEXDEN NOVA. All rights reserved.',
  // NOVA AI backend mode — editable from Admin → NOVA AI Setup, no code
  // edits needed. 'local' = free rule-based engine. 'api' = calls your
  // own serverless proxy (see novaApiEndpoint), which forwards to Gemini.
  novaMode:'local',
  // FIX (mega-fix batch #2): pre-populated with the real, fixed backend
  // URL as the default (used to default to '' — an admin who flipped
  // novaMode to 'api' without ALSO separately pasting this in got a
  // request to nothing, which is exactly what "Gemini assistant not
  // working" turned out to be). Runtime code always builds this from the
  // API_BASE constant directly regardless of what's stored here — these
  // two literal defaults just need to match it once, at seed time.
  novaApiEndpoint:'https://lexden-nova.onrender.com/api/nova-ai',
  // Paystack — editable from Admin → Payments. Only the PUBLIC key ever
  // lives here/in the client. The secret key lives only in the
  // /api/verify-paystack serverless function's environment variables.
  paystackPublicKey:'',
  paymentVerifyEndpoint:'https://lexden-nova.onrender.com/api/verify-paystack',
  paymentGateway:'paystack', // extension point — see startCheckout()
  // Fallback profile images used when a shopper doesn't upload their own
  // avatar at sign-up. Chosen by the gender they pick on the Sign Up form
  // (see screenSignup / handleEmailSignup). Editable from Admin → Branding.
  defaultAvatarMale:'',
  defaultAvatarFemale:'',
  // ---- Nova Affiliate Program (mega-update) — editable from
  // Admin → Affiliate Program. These sync via this SAME catalog/settings
  // doc as everything else in DEFAULT_CONTENT — no separate Firestore
  // doc, no separate sync code. NOT to be confused with the per-product
  // "Affiliate / purchase link" field above (that's an outbound link to
  // a third party; this is NOVA's own affiliate program that pays
  // commission on sales made through NOVA's own checkout).
  affiliateCommissionDefaultPct: 10,
  affiliateWithdrawalFeePct: 2.5,
  affiliateMinWithdrawalNGN: 5000,
  affiliateWhatsappUrl: '',
  affiliateTelegramUrl: '',
  affiliateInviteBannerText: 'Join the private Affiliate community for tips, early product drops and payout announcements.',
};

/* PHASE 3: PAYSTACK CHARGEABLE CURRENCIES
   -----------------------------------------------------------------------
   This is the ONE list that governs which currencies a shopper can
   actually check out in — separate on purpose from exchangeRates/
   currencySymbols above, which just control what's shown for browsing.

   Per Paystack's own docs (paystack.com/docs/api → "Supported currency"),
   each currency's availability is tied to the country a Paystack BUSINESS
   is registered in, not a global toggle:
     NGN — Nigeria accounts only    USD — Kenya and Nigeria accounts
     GHS — Ghana accounts only      ZAR — South Africa accounts only
     KES — Kenya accounts only      XOF — Côte d'Ivoire accounts only
   LEXDEN NOVA's Paystack account is Nigeria-registered (see the NGN-based
   product pricing and admin setup throughout this app), so — unless
   Lexden has separately registered/enabled something else in the Paystack
   dashboard — NGN and USD are the only two currencies this specific
   account can actually charge in today. GHS/ZAR/KES are NOT safe to wire
   into checkout by default even though Paystack supports them in general,
   because that support is scoped to businesses registered in those
   countries. RWF, GBP, TZS, UGX, XAF, ZMW aren't in Paystack's supported-
   currency list at all as of this writing.

   >>> If Lexden confirms (via the Paystack dashboard, Settings →
   >>> Preferences → Currency, or by contacting Paystack support) that
   >>> additional currencies are enabled on the account, add them here —
   >>> and mirror the same array in /api/verify-paystack.js, since that
   >>> file re-derives the expected charge server-side and must agree with
   >>> this list or a legitimate payment could get rejected. */
const PAYSTACK_CHARGEABLE_CURRENCIES = ['NGN', 'USD'];
// Currency to fall back to when a shopper's selected display currency
// isn't in the list above — NGN because product prices are entered in
// Naira and it's the account's home currency.
const PAYSTACK_FALLBACK_CURRENCY = 'NGN';

/* ---------------- SIGN-UP: COUNTRIES / CURRENCY / OPTIONS ----------------
   Countries the sign-up flow accepts, mapped to the currency the shopper's
   browsing/display currency should default to when that country is picked.
   NOT the same list as PAYSTACK_CHARGEABLE_CURRENCIES above — this just
   controls what the shopper *sees* prices in; actual checkout still falls
   back to PAYSTACK_FALLBACK_CURRENCY for anything Paystack can't charge. */
const SIGNUP_COUNTRY_CURRENCY = {
  'Nigeria':'NGN',
  'United States':'USD','Ecuador':'USD','El Salvador':'USD','Panama':'USD','Timor-Leste':'USD','Marshall Islands':'USD','Micronesia':'USD','Palau':'USD','Zimbabwe':'USD',
  'United Kingdom':'GBP','Isle of Man':'GBP','Jersey':'GBP','Guernsey':'GBP','Gibraltar':'GBP','Falkland Islands':'GBP','Saint Helena':'GBP','Tristan da Cunha':'GBP',
  'Ghana':'GHS',
  'Kenya':'KES',
  'South Africa':'ZAR','Lesotho':'ZAR','Eswatini':'ZAR','Namibia':'ZAR',
  'Tanzania':'TZS',
  'Uganda':'UGX',
  'Cameroon':'XAF','Central African Republic':'XAF','Chad':'XAF','Republic of the Congo':'XAF','Equatorial Guinea':'XAF','Gabon':'XAF',
  'Benin':'XOF','Burkina Faso':'XOF',"Côte d'Ivoire":'XOF','Guinea-Bissau':'XOF','Mali':'XOF','Niger':'XOF','Senegal':'XOF','Togo':'XOF',
  'Rwanda':'RWF',
  'Zambia':'ZMW',
};
// Nigeria pinned first (it's the home market), everything else alphabetical.
const SIGNUP_COUNTRIES = Object.keys(SIGNUP_COUNTRY_CURRENCY).sort((a,b)=> a==='Nigeria'?-1 : b==='Nigeria'?1 : a.localeCompare(b));
const NIGERIA_STATES = ['Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno','Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','Gombe','Imo','Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara','Lagos','Nasarawa','Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers','Sokoto','Taraba','Yobe','Zamfara','Federal Capital Territory (Abuja)'];
/* State/Region lists for every country offered in SIGNUP_COUNTRIES above —
   so the picker always shows real states/provinces/regions to choose from
   instead of a free-text box, no matter which country a shopper picks.
   Small single-region territories just get their own name as the one
   option. If a country is ever added to SIGNUP_COUNTRY_CURRENCY without a
   matching entry here, signupStep3() falls back to a free-text field. */
const SIGNUP_REGIONS = {
  'Nigeria': NIGERIA_STATES,
  'United States': ['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming','District of Columbia'],
  'Ecuador': ['Azuay','Bolívar','Cañar','Carchi','Chimborazo','Cotopaxi','El Oro','Esmeraldas','Galápagos','Guayas','Imbabura','Loja','Los Ríos','Manabí','Morona-Santiago','Napo','Orellana','Pastaza','Pichincha','Santa Elena','Santo Domingo de los Tsáchilas','Sucumbíos','Tungurahua','Zamora-Chinchipe'],
  'El Salvador': ['Ahuachapán','Cabañas','Chalatenango','Cuscatlán','La Libertad','La Paz','La Unión','Morazán','San Miguel','San Salvador','San Vicente','Santa Ana','Sonsonate','Usulután'],
  'Panama': ['Bocas del Toro','Chiriquí','Coclé','Colón','Darién','Herrera','Los Santos','Panamá','Panamá Oeste','Veraguas','Emberá-Wounaan','Guna Yala','Ngäbe-Buglé'],
  'Timor-Leste': ['Aileu','Ainaro','Baucau','Bobonaro','Cova Lima','Dili','Ermera','Lautém','Liquiçá','Manatuto','Manufahi','Oecusse','Viqueque'],
  'Marshall Islands': ['Majuro','Kwajalein','Arno','Jaluit','Ailinglaplap','Wotje','Ebeye','Other atoll'],
  'Micronesia': ['Chuuk','Kosrae','Pohnpei','Yap'],
  'Palau': ['Aimeliik','Airai','Angaur','Hatohobei','Kayangel','Koror','Melekeok','Ngaraard','Ngarchelong','Ngardmau','Ngatpang','Ngchesar','Ngeremlengui','Ngiwal','Peleliu','Sonsorol'],
  'Zimbabwe': ['Bulawayo','Harare','Manicaland','Mashonaland Central','Mashonaland East','Mashonaland West','Masvingo','Matabeleland North','Matabeleland South','Midlands'],
  'United Kingdom': ['England','Scotland','Wales','Northern Ireland'],
  'Isle of Man': ['Isle of Man'],
  'Jersey': ['Jersey'],
  'Guernsey': ['Guernsey'],
  'Gibraltar': ['Gibraltar'],
  'Falkland Islands': ['Falkland Islands'],
  'Saint Helena': ['Saint Helena','Ascension Island'],
  'Tristan da Cunha': ['Tristan da Cunha'],
  'Ghana': ['Ahafo','Ashanti','Bono','Bono East','Central','Eastern','Greater Accra','North East','Northern','Oti','Savannah','Upper East','Upper West','Volta','Western','Western North'],
  'Kenya': ['Baringo','Bomet','Bungoma','Busia','Elgeyo-Marakwet','Embu','Garissa','Homa Bay','Isiolo','Kajiado','Kakamega','Kericho','Kiambu','Kilifi','Kirinyaga','Kisii','Kisumu','Kitui','Kwale','Laikipia','Lamu','Machakos','Makueni','Mandera','Marsabit','Meru','Migori','Mombasa',"Murang'a",'Nairobi','Nakuru','Nandi','Narok','Nyamira','Nyandarua','Nyeri','Samburu','Siaya','Taita-Taveta','Tana River','Tharaka-Nithi','Trans Nzoia','Turkana','Uasin Gishu','Vihiga','Wajir','West Pokot'],
  'South Africa': ['Eastern Cape','Free State','Gauteng','KwaZulu-Natal','Limpopo','Mpumalanga','Northern Cape','North West','Western Cape'],
  'Lesotho': ['Berea','Butha-Buthe','Leribe','Mafeteng','Maseru',"Mohale's Hoek",'Mokhotlong',"Qacha's Nek",'Quthing','Thaba-Tseka'],
  'Eswatini': ['Hhohho','Lubombo','Manzini','Shiselweni'],
  'Namibia': ['Erongo','Hardap','ǁKaras','Kavango East','Kavango West','Khomas','Kunene','Ohangwena','Omaheke','Omusati','Oshana','Oshikoto','Otjozondjupa','Zambezi'],
  'Tanzania': ['Arusha','Dar es Salaam','Dodoma','Geita','Iringa','Kagera','Katavi','Kigoma','Kilimanjaro','Lindi','Manyara','Mara','Mbeya','Morogoro','Mtwara','Mwanza','Njombe','Pemba North','Pemba South','Pwani','Rukwa','Ruvuma','Shinyanga','Simiyu','Singida','Songwe','Tabora','Tanga','Unguja North','Unguja South','Urban West (Zanzibar)'],
  'Uganda': ['Central','Eastern','Northern','Western'],
  'Cameroon': ['Adamaoua','Centre','Est','Extrême-Nord','Littoral','Nord','Nord-Ouest','Ouest','Sud','Sud-Ouest'],
  'Central African Republic': ['Bamingui-Bangoran','Bangui','Basse-Kotto','Haute-Kotto','Haut-Mbomou','Kémo','Lobaye','Mambéré-Kadéï','Mbomou','Nana-Grébizi','Nana-Mambéré',"Ombella-M'Poko",'Ouaka','Ouham','Ouham-Pendé','Sangha-Mbaéré','Vakaga'],
  'Chad': ['Batha','Chari-Baguirmi','Guéra','Hadjer-Lamis','Kanem','Lac','Logone Occidental','Logone Oriental','Mandoul','Mayo-Kebbi Est','Mayo-Kebbi Ouest','Moyen-Chari',"N'Djamena",'Ouaddaï','Salamat','Sila','Tandjilé','Tibesti','Wadi Fira','Barh El Gazel','Ennedi Est','Ennedi Ouest'],
  'Republic of the Congo': ['Bouenza','Brazzaville','Cuvette','Cuvette-Ouest','Kouilou','Lékoumou','Likouala','Niari','Plateaux','Pointe-Noire','Pool','Sangha'],
  'Equatorial Guinea': ['Annobón','Bioko Norte','Bioko Sur','Centro Sur','Kié-Ntem','Litoral','Wele-Nzas'],
  'Gabon': ['Estuaire','Haut-Ogooué','Moyen-Ogooué','Ngounié','Nyanga','Ogooué-Ivindo','Ogooué-Lolo','Ogooué-Maritime','Woleu-Ntem'],
  'Benin': ['Alibori','Atakora','Atlantique','Borgou','Collines','Donga','Kouffo','Littoral','Mono','Ouémé','Plateau','Zou'],
  'Burkina Faso': ['Balé','Bam','Banwa','Bazèga','Bougouriba','Boulgou','Boulkiemdé','Comoé','Ganzourgou','Gnagna','Gourma','Houet','Ioba','Kadiogo','Kénédougou','Komondjari','Kompienga','Kossi','Koulpélogo','Kouritenga','Kourwéogo','Léraba','Loroum','Mouhoun','Namentenga','Nahouri','Nayala','Noumbiel','Oubritenga','Oudalan','Passoré','Poni','Sanguié','Sanmatenga','Séno','Sissili','Soum','Sourou','Tapoa','Tuy','Yagha','Yatenga','Ziro','Zondoma','Zoundwéogo'],
  "Côte d'Ivoire": ['Abidjan','Yamoussoukro','Agnéby-Tiassa','Bafing','Bagoué','Bélier','Béré','Bounkani','Cavally','Folon','Gbêkê','Gbôklé','Gôh','Gontougo','Grands-Ponts','Guémon','Hambol','Haut-Sassandra','Iffou','Indénié-Djuablin','Kabadougou','San-Pédro','Lôh-Djiboua','Marahoué','Moronou','Nawa',"N'Zi",'Poro','Sud-Comoé','Tchologo','Tonkpi','Worodougou'],
  'Guinea-Bissau': ['Bafatá','Biombo','Bissau','Bolama','Cacheu','Gabú','Oio','Quinara','Tombali'],
  'Mali': ['Bamako','Gao','Kayes','Kidal','Koulikoro','Ménaka','Mopti','Ségou','Sikasso','Tombouctou','Taoudénit'],
  'Niger': ['Agadez','Diffa','Dosso','Maradi','Niamey','Tahoua','Tillabéri','Zinder'],
  'Senegal': ['Dakar','Diourbel','Fatick','Kaffrine','Kaolack','Kédougou','Kolda','Louga','Matam','Saint-Louis','Sédhiou','Tambacounda','Thiès','Ziguinchor'],
  'Togo': ['Centrale','Kara','Maritime','Plateaux','Savanes'],
  'Rwanda': ['Kigali','Eastern','Northern','Southern','Western'],
  'Zambia': ['Central','Copperbelt','Eastern','Luapula','Lusaka','Muchinga','Northern','North-Western','Southern','Western'],
};
const SIGNUP_GENDER_OPTIONS = [{value:'male',label:'Male'},{value:'female',label:'Female'}];
const SIGNUP_OCCUPATION_OPTIONS = ['Developer','Designer','Marketer','Student','Entrepreneur','Educator','Other'];
const SIGNUP_HOW_HEARD_OPTIONS = ['Social media','Friend or family','Google search','Advertisement','WhatsApp/Telegram group','Other'];
