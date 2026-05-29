function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function formatUsPhone(value) {
  let digits = phoneDigits(value);
  if (digits.length === 11 && digits[0] === '1') digits = digits.slice(1);
  if (digits.length !== 10) return String(value || '').trim();
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function emptyToNullFormattedPhone(value) {
  const formatted = formatUsPhone(value);
  return formatted ? formatted : null;
}

module.exports = {
  formatUsPhone,
  emptyToNullFormattedPhone,
};
