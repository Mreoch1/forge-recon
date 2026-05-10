# Morning handoff — start here

Hey Michael. While you slept, Claude (planner) and Hermes (executor) built the full v0 of the construction work order system. Here's what to do first.

## 1. Run the app

Open a terminal:

```
cd C:\Users\Mreoc\hermes-claude-link\construction-app
npm install        # already done if Hermes finished phase 0, harmless to re-run
npm run init-db    # already done, harmless if DB exists
npm run seed       # already done, idempotent
npm start
```

Browser: **http://localhost:3001**

Login:
- email: `admin@recon.local`
- password: `changeme123`

## 2. First three minutes (mandatory)

In this order:

1. **Rotate the admin password.** Admin > Users > Edit your row > "Change password" section. Anything you'll remember; keep it strong.
2. **Fill in company settings.** Admin > Settings. Put in your real address, phone, EIN, default tax rate. These flow through to every PDF.
3. **Eyeball a sample PDF.** From any estimate, WO, or invoice click "View PDF" to confirm the logo and company info look right. If not, drop a better logo at `public/logos/recon.png` (any PNG) — no restart needed for new PDFs.

## 3. Drive a real workflow

Easiest test of the whole thing:

1. Customers > + New customer (use a real name; give yourself an email so the .eml drop works).
2. From the customer page, + New job.
3. From the job page, + New estimate. Add 2–3 line items. Save.
4. Click Send → status `sent`. Click Mark accepted → status `accepted`.
5. Click Convert to Work Order. Edit the WO to set a scheduled date and assignee. Mark a couple lines done.
6. Start work, then Mark complete.
7. Click Generate invoice. Click Send. Look in `mail-outbox/` — there's a `.eml` you can open in any mail client; the PDF is attached.
8. Click Mark paid. Try a partial payment first ($500 or whatever), then complete the rest.

If all that works front-to-back, the bones are solid.

## 4. Read these in order if you want context

- `TODO_FOR_MICHAEL.md` — checklist of everything waiting on you. Do this one for sure.
- `CHANGELOG.md` — what got built when, who did what (Claude vs Hermes).
- `DECISIONS.md` — every default we picked without you. Reverse anything you don't like.
- `PROJECT_PLAN.md` — architecture, data model, phase plan.
- `README.md` — running, configuration, layout, tech stack.

## 5. If something's broken

Check `data/app.db` exists, sessions/ exists, mail-outbox/ exists (created on demand). If the server won't boot:

```
node src/server.js
```

Read the stack trace. The most common surprise is port 3001 being taken — set `PORT=3002 npm start`.

If the database is in a bad state, nuking it is safe (no real data yet):

```
rm data/app.db
npm run init-db && npm run seed
npm start
```

## 6. What happened overnight (one-paragraph summary)

The architecture is Node + Express + sql.js + EJS + Tailwind via CDN, all local-only. We replaced `better-sqlite3` with `sql.js` because your VS Build Tools setup couldn't compile native modules; this means the DB is held in process memory and persisted to disk after writes (debounced 50ms) — fine for one server, and it's a bullet point if you ever scale to multi-process. No real keys, no real APIs, no real money was sent. Everything an LLM-managed sub-task could do without your judgment is done; everything that needed your judgment is in `TODO_FOR_MICHAEL.md`. The auth, CRUD, status flows, line item math, three PDF generators, email-to-file with PDF attachments, dashboard KPIs, admin user management with self-protection, and company settings all work and were Hermes-tested with 100+ assertions across 7 phases. There's a unit test suite for the math primitives; integration tests against the HTTP stack are listed for follow-up.

You're set. Coffee, then drive a real estimate-to-paid loop and tell me what feels off in the morning chat.

— Claude (and Hermes)
