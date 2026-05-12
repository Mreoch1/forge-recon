const { getToken } = require('./m365-device-code-auth');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', '.m365-poll-state.json');

async function pollInbox() {
  const token = await getToken();
  
  // Track last poll time so we only report new emails
  let lastSeen = null;
  if (fs.existsSync(STATE_FILE)) {
    try { lastSeen = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).lastPoll; } catch(e) {}
  }
  const since = lastSeen || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const url = 'https://graph.microsoft.com/v1.0/me/messages'
    + '?$filter=receivedDateTime ge ' + since
    + '&$orderby=receivedDateTime desc'
    + '&$top=10'
    + '&$select=subject,from,receivedDateTime,bodyPreview,isRead';

  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();

  // Save current time for next poll
  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastPoll: new Date().toISOString() }));

  const results = [];
  for (const msg of (data.value || [])) {
    const from = msg.from?.emailAddress?.address || '?';
    const preview = (msg.bodyPreview || '').slice(0, 120).replace(/\n/g, ' ');
    results.push('FORGE_EMAIL | ' + msg.receivedDateTime.slice(0,19) + ' | from=' + from + ' | subject="' + msg.subject + '" | preview="' + preview + '"');
  }

  if (results.length > 0) {
    console.log(results.join('\n'));
  }
}

pollInbox().catch(err => {
  console.error('[m365] Poll failed:', err.message);
  process.exit(1);
});
