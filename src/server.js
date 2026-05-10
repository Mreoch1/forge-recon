const express = require('express');
const app = express();
const PORT = process.env.PORT || 3001;

app.get('/ping', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`[smoke] Recon Construction WO server listening on http://localhost:${PORT}`);
  console.log(`[smoke] Node ${process.version} — pid ${process.pid}`);
});
