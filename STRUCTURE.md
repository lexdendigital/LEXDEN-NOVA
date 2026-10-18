# LEXDEN NOVA — how the website is organised

The website used to be one huge `index.html` (800 KB). It is now split into separate pages and files,
so each part loads only what it needs and can be changed without touching the others.

```
index.html            Storefront (what shoppers see). Small: it only loads the files below.
admin/                ADMIN PORTAL  → https://lexdendigital.github.io/LEXDEN-NOVA/admin/
   index.html           the page
   admin.js             all admin screens and actions
   main.js              starts the page
creator/              CREATOR STUDIO → https://lexdendigital.github.io/LEXDEN-NOVA/creator/
   index.html           the page
   creator.js           apply, profile, products, orders, money, AI helper
   main.js              starts the page
affiliate/            Affiliate program (was already separate)
css/app.css           All styling (shared by every page)
js/                   Code shared by the pages
   firebase.js          Firebase sign-in / database connection
   data.js              default texts and settings
   state.js             saved data, cloud sync, helpers for data
   core.js              screen helpers, router, header/navigation
   support.js           small shared tools (API address, uploads, counters, page switching)
   update.js            automatic update of the app (also for the installed PWA)
   shopper.js           storefront screens (home, products, feed, profile, checkout…)
   nova-ai.js           NOVA assistant chat
   boot.js              starts the storefront
sw.js                 Service worker: offline copy + always loads the newest files
sitemap.xml           Only the home page (the full sitemap is live on the server)
```

## Which page loads which files
| Page | Files |
|---|---|
| Storefront | data, state, core, support, shopper, nova-ai, update, boot |
| Admin | data, state, core, support, **admin/admin.js**, update, admin/main.js |
| Creator | data, state, core, support, **creator/creator.js**, update, creator/main.js |

Shoppers never download admin or creator code.

## Old links still work
`index.html#admin` and `index.html#creator` send you to the new pages automatically.
Links like `#home` or `#products` typed inside the admin or creator page send you back to the storefront.

## Adding a new feature
* Only shoppers see it → `js/shopper.js`
* Only admin sees it → `admin/admin.js`
* Only creators see it → `creator/creator.js`
* Needed by more than one page → `js/support.js` (or `js/state.js` for data)
Never put admin or creator code in `js/` — it would load for every shopper.
