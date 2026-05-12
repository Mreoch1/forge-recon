const { getToken } = require('./m365-device-code-auth');
const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', '.m365-poll-state.json');

function readLastPoll() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return parsed.lastPoll || null;
  } catch (e) {
    return null;
  }
}

function graphDate(value) {
  return String(value || '').replace(/'/g, "''");
}

async function pollInbox() {
  const token = await getToken();
  
  // Track last poll time so we only report new emails
  const pollStartedAt = new Date().toISOString();
  const lastSeen = readLastPoll();
  const since = lastSeen || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const params = new URLSearchParams({
    '$filter': "receivedDateTime ge " + graphDate(since),
    '$orderby': 'receivedDateTime desc',
    '$top': '10',
    '$select': 'subject,from,receivedDateTime,bodyPreview,isRead',
  });
  const url = 'https://graph.microsoft.com/v1.0/me/messages?' + params.toString();

  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();
  if (!res.ok) {
    throw new Error('Graph inbox poll failed: ' + res.status + ' ' + JSON.stringify(data).slice(0, 300));
  }

  const results = [];
  for (const msg of (data.value || [])) {
    const from = msg.from?.emailAddress?.address || '?';
    const preview = (msg.bodyPreview || '').slice(0, 120).replace(/\n/g, ' ');
    results.push('FORGE_EMAIL | ' + msg.receivedDateTime.slice(0,19) + ' | from=' + from + ' | subject="' + msg.subject + '" | preview="' + preview + '"');
  }

  if (results.length > 0) {
    console.log(results.join('\n'));
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify({ lastPoll: pollStartedAt }, null, 2));
}

pollInbox().catch(err => {
  console.error('[m365] Poll failed:', err.message);
  process.exit(1);
});
