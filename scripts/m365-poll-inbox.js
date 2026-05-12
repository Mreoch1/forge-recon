const { getToken } = require('./m365-device-code-auth');

async function pollInbox() {
  const token = await getToken();
  
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const url = 'https://graph.microsoft.com/v1.0/me/messages'
    + '?$filter=receivedDateTime ge ' + since
    + '&$orderby=receivedDateTime desc'
    + '&$top=10'
    + '&$select=subject,from,receivedDateTime,bodyPreview,isRead';

  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const data = await res.json();

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
