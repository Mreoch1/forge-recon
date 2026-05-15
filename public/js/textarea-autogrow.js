/**
 * textarea-autogrow.js — D-067b: auto-expanding textareas.
 *
 * Uses CSS field-sizing: content where supported, with a JS fallback
 * for browsers that don't support it yet (Firefox, older Safari).
 *
 * Applied to all textarea.input elements on the page.
 */
(function() {
  'use strict';

  // Check if field-sizing is supported
  var supportsFieldSizing = CSS.supports('field-sizing', 'content');

  if (!supportsFieldSizing) {
    // JS fallback: resize on input
    document.addEventListener('input', function(e) {
      var ta = e.target;
      if (ta.tagName !== 'TEXTAREA' || !ta.classList.contains('input')) return;
      ta.style.height = 'auto';
      ta.style.height = Math.max(ta.scrollHeight, 128) + 'px';
    });

    // Also run on page load for pre-filled textareas
    document.addEventListener('DOMContentLoaded', function() {
      document.querySelectorAll('textarea.input').forEach(function(ta) {
        ta.style.height = 'auto';
        ta.style.height = Math.max(ta.scrollHeight, 128) + 'px';
      });
    });
  }
})();
