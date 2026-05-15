/**
 * toast.js — D-086: lightweight toast notification system.
 *
 * Usage:
 *   toast.show('User created successfully', 'success');
 *   toast.show('Something went wrong', 'error');
 *   toast.show('Heads up!', 'info');
 *
 * Types: success (green), error (red), info (blue), warning (amber)
 * Auto-dismisses after 4 seconds. ARIA role="status" for screen readers.
 * Click to dismiss immediately.
 */
(function() {
  'use strict';

  if (window._toastInitialized) return;
  window._toastInitialized = true;

  var CONTAINER_ID = 'toast-container';
  var AUTO_DISMISS_MS = 4000;
  var STYLES = {
    success: { bg: '#16a34a', border: '#15803d' },
    error:   { bg: '#dc2626', border: '#b91c1c' },
    info:    { bg: '#2563eb', border: '#1d4ed8' },
    warning: { bg: '#d97706', border: '#b45309' },
  };

  // Create container if it doesn't exist
  var container = document.getElementById(CONTAINER_ID);
  if (!container) {
    container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.setAttribute('role', 'status');
    container.setAttribute('aria-live', 'polite');
    container.style.cssText = [
      'position: fixed',
      'bottom: 1.5rem',
      'right: 1.5rem',
      'z-index: 9999',
      'display: flex',
      'flex-direction: column-reverse',
      'gap: 0.5rem',
      'pointer-events: none',
    ].join(';');
    document.body.appendChild(container);
  }

  var toast = {
    show: function(message, type) {
      type = type || 'info';
      var colors = STYLES[type] || STYLES.info;

      var el = document.createElement('div');
      el.setAttribute('role', 'alert');
      el.style.cssText = [
        'pointer-events: auto',
        'padding: 0.75rem 1.25rem',
        'border-radius: 0.5rem',
        'color: #fff',
        'font-size: 0.875rem',
        'font-weight: 500',
        'line-height: 1.4',
        'background: ' + colors.bg,
        'border: 1px solid ' + colors.border,
        'box-shadow: 0 4px 12px rgba(0,0,0,0.15)',
        'max-width: 28rem',
        'cursor: pointer',
        'animation: toast-slide-in 0.25s ease-out',
        'transition: opacity 0.3s ease, transform 0.3s ease',
      ].join(';');
      el.textContent = message;

      // Click to dismiss
      el.addEventListener('click', function() {
        dismiss(el);
      });

      container.appendChild(el);

      // Auto-dismiss
      var timer = setTimeout(function() {
        dismiss(el);
      }, AUTO_DISMISS_MS);

      function dismiss(elem) {
        clearTimeout(timer);
        if (!elem.parentNode) return;
        elem.style.opacity = '0';
        elem.style.transform = 'translateX(100%)';
        setTimeout(function() {
          if (elem.parentNode) elem.parentNode.removeChild(elem);
        }, 300);
      }
    }
  };

  // Add slide-in keyframes once
  if (!document.getElementById('toast-keyframes')) {
    var style = document.createElement('style');
    style.id = 'toast-keyframes';
    style.textContent = [
      '@keyframes toast-slide-in {',
      '  from { opacity: 0; transform: translateX(100%); }',
      '  to   { opacity: 1; transform: translateX(0); }',
      '}',
    ].join('\n');
    document.head.appendChild(style);
  }

  // Expose globally
  window.toast = toast;

  // Auto-show server-side flash messages as toasts (if data-toast attributes are present)
  document.querySelectorAll('[data-toast]').forEach(function(flashEl) {
    toast.show(flashEl.textContent.trim(), flashEl.getAttribute('data-toast') || 'info');
    flashEl.remove();
  });
})();
