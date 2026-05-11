# Round 22 — Postgres + Vercel Deploy

Authored: 2026-05-10 (Claude session, head-start while Hermes builds Round 19)
Status: **Spec.** Will become a directive after Rounds 19-21 land.

---

## Goal

Cut FORGE from local sql.js + file-store sessions to:
- **Supabase Postgres** (managed Postgres + storage + auth-ready)
- **Vercel** (serverless Node deployment)
- **Real URL** Michael can hit from his phone in the field

Two phases. **22a** is the schema + driver swap (still local, pointing at Supabase). **22b** is the Vercel deploy + production cutover.

---

## What's already prepared (this session)

- `src/db/schema-postgres.sql` — full Postgres-flavored schema. Matches the current SQLite schema feature-for-feature plus upgrades: `NUMERIC(14,2)` for money (exact precision), `TIMESTAMPTZ` for timestamps, `BOOLEAN` for flags, `JSONB` for audit/metadata fields, auto-update trigger for `updated_at` columns. **Hermes can run this against Supabase as-is for 22a.**
- This scope doc.

Everything else is build work.

---

## Phase 22a — Postgres schema + driver swap (local first)

### 1. Create Supabase project
- Manual step Michael does: log into Supabase, create a new project named `forge`. Region: us-east (closest to Vercel default us-east-1).
- Copy the connection string and the `anon` + `service_role` keys.
- Add to `.env`:
  ```
  DATABASE_URL=postgres://postgres.<ref>:<password>@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true
  DATABASE_URL_DIRECT=postgres://postgres.<ref>:<password>@aws-0-us-east-1.pooler.supabase.com:5432/postgres
  SUPABASE_URL=https://<ref>.supabase.co
  SUPABASE_ANON_KEY=...
  SUPABASE_SERVICE_ROLE_KEY=...
  ```
- The pooler URL (port 6543) is what app code uses (PgBouncer transaction mode, Vercel-friendly). The direct URL (5432) is for migrations and admin work that needs session-level features.

### 2. Run schema migration
```
psql "$DATABASE_URL_DIRECT" -f src/db/schema-postgres.sql
```
Or via Supabase SQL editor in browser.

### 3. Adapt `src/db/db.js`
Drop sql.js, use `pg`:

```js
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  ssl: { rejectUnauthorized: false }, // Supabase requires SSL
});

module.exports = {
  init: async () => {/* no-op for pg */},
  // Keep the same API surface as the sql.js version:
  get: async (sql, params=[]) => {
    const { rows } = await pool.query(rewriteSql(sql), params);
    return rows[0] || null;
  },
  all: async (sql, params=[]) => {
    const { rows } = await pool.query(rewriteSql(sql), params);
    return rows;
  },
  run: async (sql, params=[]) => {
    const { rowCount, rows } = await pool.query(rewriteSql(sql) + (sql.toLowerCase().startsWith('insert') ? ' RETURNING id' : ''), params);
    return { changes: rowCount, lastInsertRowid: rows[0]?.id };
  },
  exec: async (sql) => pool.query(sql),
  transaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        get: async (s, p=[]) => { const r = await client.query(rewriteSql(s), p); return r.rows[0] || null; },
        all: async (s, p=[]) => { const r = await client.query(rewriteSql(s), p); return r.rows; },
        run: async (s, p=[]) => { const r = await client.query(rewriteSql(s) + (s.toLowerCase().startsWith('insert') ? ' RETURNING id' : ''), p); return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id }; },
      });
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  },
  persist: async () => {/* no-op for pg */},
};

// Rewrite sql.js-style ? placeholders to pg $1, $2, ...
function rewriteSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
```

This keeps every existing route's `db.get/all/run` calls working — only the bottom layer changes.

### 4. SQL function translation

Across all routes/services, find-and-replace:

| SQLite | Postgres |
|---|---|
| `datetime('now')` | `now()` |
| `date('now')` | `current_date` |
| `date('now', '+30 days')` | `current_date + interval '30 days'` |
| `julianday('now') - julianday(x)` | `extract(day from now() - x)` |
| `strftime('%Y-%m', x)` | `to_char(x, 'YYYY-MM')` |
| `strftime('%Y', x)` | `to_char(x, 'YYYY')` |
| `LIKE '%foo%'` | `ILIKE '%foo%'` (Postgres case-insensitive) |
| `COALESCE(...)` | same |

Best approach: grep `datetime\(`, `julianday`, `strftime`, `date\(.*'+` across `src/`, fix each call site. Most are in `routes/dashboard.js`, `routes/accounting.js`, `services/timeline.js`.

### 5. Session store
Drop `session-file-store`, switch to `connect-pg-simple`:

```bash
npm install connect-pg-simple
```

```js
const pgSession = require('connect-pg-simple')(session);
app.use(session({
  store: new pgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production', httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600 * 1000 },
}));
```

### 6. Money precision
Postgres NUMERIC returns string by default in node-pg. Configure:
```js
const types = require('pg').types;
types.setTypeParser(1700, val => parseFloat(val)); // OID 1700 = NUMERIC
```

Or wrap every monetary read with `Number(row.total)` — already done in most views. Setting the type parser globally is cleaner.

### 7. Smoke (still local, pointing at Supabase)
- `npm run init` → creates schema (no-op if already created)
- `npm run seed:mock -- --reset` → seeds 2x mock data into Supabase
- Server starts, all pages render, trial balance balanced
- Login works (sessions in Postgres now)
- Estimate send writes to mail-outbox (still local)
- AI chat works
- Photo uploads still go to local `public/uploads/` for now — Phase 22b moves to Supabase Storage

---

## Phase 22b — Vercel deploy

### 1. Vercel project setup
- Connect the GitHub repo (or push as a new repo if not on GitHub yet)
- Project name: `forge`
- Framework preset: Other / Express
- Build command: `npm install` (no build step — runtime EJS render)
- Output directory: leave blank (server-rendered)
- Install command: `npm install`

### 2. `vercel.json`
```json
{
  "version": 2,
  "builds": [
    { "src": "src/server.js", "use": "@vercel/node" }
  ],
  "routes": [
    { "src": "/uploads/(.*)", "status": 404 },  // photos served via Supabase Storage URL, not local
    { "src": "/(.*)", "dest": "src/server.js" }
  ],
  "env": {
    "NODE_ENV": "production"
  }
}
```

### 3. Env vars in Vercel dashboard
Set in Project Settings → Environment Variables:
- `SESSION_SECRET` (generate fresh random 64-char string)
- `DATABASE_URL` (Supabase pooler URL)
- `DATABASE_URL_DIRECT` (Supabase direct URL — for migrations only)
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`
- `AI_PROVIDER`, `AI_API_KEY` (rotated DeepSeek key)
- `AI_CHAT_ENABLED=1`
- `EMAIL_MODE=file` (until Resend wired)
- `NODE_ENV=production` (also in vercel.json)

### 4. Photo storage migration
Local filesystem won't survive serverless — every cold start is a fresh container.

Plan:
- New service `src/services/storage.js` — wrapper that knows whether to write local or Supabase Storage based on `STORAGE_MODE` env (`local` | `supabase`).
- Local mode: writes to `public/uploads/wo/<wo_id>/` (current behavior, dev convenience).
- Supabase mode: uploads to a `wo-photos` bucket via supabase-js client. Returns the public URL.
- Photo upload route uses the wrapper.
- View renders the URL directly (works for both modes).

For mail-outbox, keep file-mode disabled in production (`EMAIL_MODE=smtp` once Resend is wired) — no local file writes.

For sessions, already moved to Postgres in 22a — no filesystem dependency.

### 5. Build session table
The `connect-pg-simple` middleware creates the `session` table on first run with `createTableIfMissing: true`. No manual migration needed.

### 6. Deploy preview branch first
- Push to a branch named `deploy-preview`
- Vercel auto-creates a preview URL like `forge-deploy-preview-<hash>.vercel.app`
- Smoke test against the preview URL
- If clean → merge to main, Vercel promotes to production at `forge.vercel.app` (or custom domain)

### 7. Custom domain (optional)
If Michael wants `forge.reconenterprises.com`:
- Add domain in Vercel project settings
- Add CNAME in Recon Enterprises DNS pointing to `cname.vercel-dns.com`
- Vercel auto-provisions HTTPS via Let's Encrypt

---

## Smoke tests (post-deploy)

1. `https://forge.vercel.app/` redirects to `/login`
2. Login with seeded admin → dashboard renders with seeded WOs
3. Create a customer through chat ("add a customer …") → confirmation card → confirm → customer in Supabase
4. View AI usage page → shows tokens / cost / users
5. Trial balance balanced
6. Upload a photo on a WO → file lands in Supabase Storage `wo-photos` bucket → renders in gallery
7. Sessions persist across requests (Cookie + Postgres)
8. Cold start: hit a page after 5min idle → response within 2s (Vercel cold start)
9. Mobile viewport on Michael's phone → dashboard responsive, schedule readable
10. Trial balance still balanced after a real flow (create estimate, send, mark paid)

---

## Rollback plan

If anything goes catastrophically wrong post-deploy:
- Vercel: instant rollback to previous deployment via dashboard
- Supabase data: hourly automated backups for 7 days; can PITR-restore
- Local dev keeps a `USE_SQLITE=1` flag override for the entire transition period — set it in `.env`, server falls back to sql.js + file sessions, full original-behavior for emergency offline work

---

## Estimated effort

- Phase 22a (schema migration + driver swap + SQL function translation): **~5 hours**
- Phase 22b (Vercel config + photo storage + smoke): **~3 hours**
- Custom domain setup: 30 min if DNS access ready

**Total: ~8 hours of Hermes work, batched into 2 directives.**

---
— Claude
