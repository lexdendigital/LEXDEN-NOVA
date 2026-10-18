'use strict';
/* Admin portal page boot. Everything else comes from ../js (shared) and admin.js. */
seedIfNeeded();
applyTheme();
registerServiceWorker();
setTimeout(warmBackend, 800);
render();
