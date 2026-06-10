(function(){
  function formatPhone(value) {
    var digits = String(value || '').replace(/\D/g, '');
    if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
    digits = digits.slice(0, 10);
    if (digits.length > 6) return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
    if (digits.length > 3) return '(' + digits.slice(0, 3) + ') ' + digits.slice(3);
    if (digits.length) return '(' + digits;
    return '';
  }

  function isPhoneInput(el) {
    if (!el || !el.matches) return false;
    return el.matches('input[name="phone"], input[data-phone], input[data-phone-format]');
  }

  function applyFormat(el) {
    var next = formatPhone(el.value);
    if (next !== el.value) el.value = next;
  }

  document.addEventListener('input', function(e){
    if (!isPhoneInput(e.target)) return;
    applyFormat(e.target);
  });

  document.addEventListener('DOMContentLoaded', function(){
    document.querySelectorAll('input[name="phone"], input[data-phone], input[data-phone-format]').forEach(applyFormat);
  });
})();
