(function () {
  'use strict';

  const EYE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  const EYE_OFF_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m3 3 18 18"></path><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"></path><path d="M9.9 5.2A10.5 10.5 0 0 1 12 5c6.4 0 10 7 10 7a16 16 0 0 1-3 4.1"></path><path d="M6.6 6.6C3.8 8.3 2 12 2 12s3.6 7 10 7c.9 0 1.8-.1 2.6-.4"></path></svg>';

  function enhancePasswordInput(input) {
    if (!(input instanceof HTMLInputElement) || input.type !== 'password') return;
    if (input.dataset.passwordVisibilityReady === 'true' || !input.parentNode) return;

    input.dataset.passwordVisibilityReady = 'true';

    const wrap = document.createElement('span');
    wrap.className = 'password-visibility-wrap';
    if (input.closest('.admin-login')) wrap.classList.add('password-visibility-admin');

    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'password-visibility-toggle';
    toggle.setAttribute('aria-label', 'Show password');
    toggle.setAttribute('aria-pressed', 'false');
    toggle.setAttribute('title', 'Show password');
    if (input.id) toggle.setAttribute('aria-controls', input.id);
    toggle.innerHTML = EYE_ICON;

    toggle.addEventListener('click', function () {
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(reveal));
      toggle.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
      toggle.setAttribute('title', reveal ? 'Hide password' : 'Show password');
      toggle.innerHTML = reveal ? EYE_OFF_ICON : EYE_ICON;
    });

    wrap.appendChild(toggle);
  }

  function scan(root) {
    if (!root) return;
    if (root instanceof HTMLInputElement) {
      enhancePasswordInput(root);
      return;
    }
    if (root.matches && root.matches('input[type="password"]')) {
      enhancePasswordInput(root);
    }
    if (root.querySelectorAll) {
      root.querySelectorAll('input[type="password"]').forEach(enhancePasswordInput);
    }
  }

  function start() {
    scan(document);
    const observer = new MutationObserver(function (records) {
      records.forEach(function (record) {
        if (record.type === 'attributes') {
          enhancePasswordInput(record.target);
          return;
        }
        record.addedNodes.forEach(function (node) {
          if (node.nodeType === 1) scan(node);
        });
      });
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['type']
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();