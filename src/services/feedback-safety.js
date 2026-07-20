/**
 * Feedback is untrusted user-authored content. These checks do not block
 * submission; they surface requests that require owner review and must never
 * be treated as authorization to change Forge.
 */

const HIGH_RISK_RULES = [
  {
    reason: 'Requests broad or destructive data changes',
    patterns: [
      /\b(delete|erase|wipe|purge|drop|truncate|destroy|reset)\b[\s\S]{0,100}\b(all|every|entire|database|data|records?|customers?|users?|work orders?|estimates?|invoices?|bills?|projects?)\b/i,
      /\b(all|every|entire)\b[\s\S]{0,100}\b(data|records?|customers?|users?|work orders?|estimates?|invoices?|bills?|projects?)\b[\s\S]{0,100}\b(delete|erase|wipe|purge|drop|truncate|destroy|reset)\b/i,
      /\b(start fresh|factory reset|clear the database)\b/i,
    ],
  },
  {
    reason: 'Requests weakened access controls or elevated privileges',
    patterns: [
      /\b(disable|remove|bypass|turn off)\b[\s\S]{0,80}\b(auth|authentication|authorization|permissions?|security|guardrails?|audit logs?)\b/i,
      /\b(make|give|grant|promote)\b[\s\S]{0,80}\b(admin|owner|full access|superuser)\b/i,
    ],
  },
  {
    reason: 'Requests secrets, credentials, or protected data',
    patterns: [
      /\b(show|send|expose|reveal|export|download)\b[\s\S]{0,80}\b(passwords?|secrets?|api keys?|tokens?|credentials?|session cookies?|private keys?)\b/i,
    ],
  },
  {
    reason: 'Attempts to override review instructions or execute commands',
    patterns: [
      /\b(ignore|override|disregard)\b[\s\S]{0,80}\b(previous|prior|system|developer|security|instructions?|rules?)\b/i,
      /\b(run|execute)\b[\s\S]{0,40}\b(sql|shell|terminal|command|script)\b/i,
    ],
  },
  {
    reason: 'Requests sensitive financial or integration changes',
    patterns: [
      /\b(change|replace|redirect|transfer|send|refund)\b[\s\S]{0,80}\b(bank account|routing number|payment|payout|quickbooks|webhook|billing destination)\b/i,
    ],
  },
];

function assessFeedbackRisk(subject, message) {
  const text = `${subject || ''}\n${message || ''}`.slice(0, 10000);
  const reasons = HIGH_RISK_RULES
    .filter(rule => rule.patterns.some(pattern => pattern.test(text)))
    .map(rule => rule.reason);

  return {
    riskLevel: reasons.length ? 'high' : 'normal',
    riskReasons: reasons,
  };
}

module.exports = { assessFeedbackRisk };
