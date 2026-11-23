'use strict';
const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';   // the Docker image sets HOST=0.0.0.0 (only the proxy can reach it)

(async () => {
  // Database settings: DATABASE_URL, or the standard PGHOST / PGUSER / PGPASSWORD / PGDATABASE variables.
  const app = await createApp({
    connectionString: process.env.DATABASE_URL || undefined,
    secureCookie: process.env.COOKIE_SECURE === 'true',
    trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : false,
    sessionHours: Number(process.env.SESSION_HOURS || 8),
  });
  const server = app.listen(PORT, HOST, () => console.log(`Grade portal listening on http://${HOST}:${PORT}`));
  const stop = () => server.close(async () => { await app.locals.db.close(); process.exit(0); });
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
})().catch(err => { console.error('Failed to start:', err.message); process.exit(1); });
