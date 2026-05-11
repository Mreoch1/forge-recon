/**
 * server.js — Local development entry point.
 * Imports the Express app from app.js, starts listening.
 * For production (Vercel), app.js is exported directly.
 */
require('dotenv').config();
const app = require('./app');

const PORT = parseInt(process.env.PORT, 10) || 3001;

// Production safety checks
if (process.env.NODE_ENV === 'production') {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret === 'dev-secret-change-me') {
    console.error('FATAL: SESSION_SECRET must be set in production.');
    process.exit(1);
  }
}

app.listen(PORT, () => {
  console.log(`FORGE server listening on http://localhost:${PORT}`);
  console.log(`Node ${process.version}  pid ${process.pid}  env ${process.env.NODE_ENV || 'dev'}`);
});
