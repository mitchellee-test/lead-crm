# Lead CRM — public team version (GitHub + Vercel free tier)

A plain HTML / CSS / JS CRM with **no build step**. Teammates open the
same Vercel URL and edit the same shared database at the same time.

Pipeline: **New → Contacted → Replied → Requirement → Proposal →
Negotiation → Won / Lost**

Core rule, enforced in the app: **only leads that reach Replied (or
later, up to Negotiation) can be handed over to the backend team.**
New and Contacted leads show a visible 🔒 lock and their handoff
button is disabled, so emailing 100 prospects and getting 5 replies
means only those 5 ever reach the team queue — the other 95 stay with
you. Won / Lost leads are closed and are also locked out of handoff.

Features:
- Dashboard: total leads, replied rate, handed over, won, follow-ups
  due today and overdue, pipeline by stage
- Leads list view + kanban board view
- Search, and filters by stage, source channel, and assignee
- Add / edit leads, follow-up dates with due / overdue highlighting
- One-tap activity logging: Email, WhatsApp, Call, LinkedIn, Upwork,
  Marketplace (plus a free-text note)
- Handoff Queue: ready (Replied only), team queue (handed over),
  and locked-out (New / Contacted) sections
- Shared editing via Supabase (free tier), with realtime updates and
  a 5-second refresh fallback. Last write wins if two people edit the
  same lead at the exact same time.
- Local Demo mode if Supabase is not configured yet: data is stored
  in that browser's localStorage only, with a clear banner saying it
  is **NOT shared with teammates**.

## Step 1 — Create a free Supabase project

1. Go to https://supabase.com/dashboard and sign up / sign in.
2. Click **New project**, pick a name, a database password (save it
   somewhere safe), and the closest region. Click **Create new project**
   and wait for it to finish.
3. In the left menu, open **SQL Editor** → **New query**.
4. Open `schema.sql` from this folder, copy its whole contents, paste
   into the SQL Editor, and click **Run**. You should see success and
   two new tables: `leads` and `activities`.
5. In the left menu, open **Project Settings → API**. Copy:
   - **Project URL** (looks like `https://xyzcompany.supabase.co`)
   - **anon / public key** (a long key starting with `eyJ…`)

## Step 2 — Point the app at Supabase

1. Open `config.js` in this folder.
2. Replace the empty `SUPABASE_URL` and `SUPABASE_ANON_KEY` values
   with the URL and anon key from Step 1.
3. Save. That is the only change needed to switch from Local Demo
   mode to shared mode — no code change.

To check locally before deploying, just open `index.html` in a
browser (or serve the folder with any static server). The top banner
should now say **Live shared mode** instead of Local Demo mode.

## Step 3 — Push to GitHub

1. Create a new repository on GitHub (empty, no README needed — this
   folder already has one, or let GitHub create one and merge).
2. From a terminal inside this folder:
   ```bash
   git init
   git add .
   git commit -m "Lead CRM for team"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
   git push -u origin main
   ```
   Replace `YOUR-USERNAME` and `YOUR-REPO` with your own.
3. If `config.js` now contains your real anon key, that is the
   intended, public-safe key (see Security below). Never commit a
   `service_role` key.

## Step 4 — Deploy on Vercel (free tier)

1. Go to https://vercel.com, sign in (you can sign in with GitHub).
2. Click **Add New → Project**, then **Import** the GitHub repo you
   just pushed.
3. On the import settings screen:
   - **Framework Preset:** Other (or leave as detected — there is no
     framework here)
   - **Build Command:** leave empty / none
   - **Output Directory:** leave as the root (`.`) — do not set it
     to `dist` or anything else
   - **Install Command:** leave empty / none
   - **Root Directory:** the repo root (this folder, if the repo
     contains only this app)
4. Click **Deploy**. Vercel will give you a URL like
   `https://your-lead-crm.vercel.app`.
5. Open that URL, check the banner says **Live shared mode**, add a
   test lead, and ask a teammate to open the same URL — they should
   see the same lead within seconds. Delete the test lead afterwards.

`vercel.json` in this folder already declares a static deployment
with no build, so Vercel serves `index.html`, `app.js`, `styles.css`,
and `config.js` as-is.

## Step 5 — Share with teammates

Share the Vercel URL with your team. Everyone uses the same URL and
the same Supabase database, so edits appear for everyone. There is no
per-teammate install and no login in this first version (see Security).

Suggested team workflow:
- You (or whoever does outreach) add leads and move them to Contacted.
- When a prospect replies, move them to Replied.
- Open **Handoff Queue → Hand over to team**, pick an assignee, write
  the requirement, and confirm. The lead moves to Requirement and
  appears in the team queue.
- The backend team updates Requirement → Proposal → Negotiation →
  Won / Lost, and sets the next follow-up date.
- Check the dashboard daily for due-today and overdue follow-ups.

## Security — read before adding real client data

- The **anon key** in `config.js` is a public key by design: anyone
  who has your Vercel URL can read it from the page source. That is
  normal for Supabase browser apps, but it means **access control must
  come from Supabase, not from hiding the key**.
- **Do not commit or paste the `service_role` key anywhere in this
  app.** It bypasses all database rules.
- Before putting real client names, emails, or phone numbers in:
  1. Add **Supabase Auth** (email login for teammates) and/or
  2. Turn on **Row Level Security** in Supabase and add policies so
     only authenticated teammates can read/write `leads` and
     `activities`. See the note at the bottom of `schema.sql`.
  3. Until you do that, treat this as an internal tool shared only
     with people you trust, and do not post the Vercel URL publicly.
- Vercel's free tier and Supabase's free tier both have usage limits;
  for a small team tracking leads this is normally plenty, but check
  their dashboards if you grow a lot.

## Files in this folder

- `index.html` — complete UI (dashboard, list, board, handoff queue, modals)
- `app.js` — all logic: Supabase + Local Demo mode, filters, handoff lock
- `styles.css` — fresh, responsive styling (desktop and mobile)
- `config.js` — your Supabase URL + anon key (placeholder until you fill it)
- `config.example.js` — same file, with example placeholders and comments
- `schema.sql` — Supabase tables, indexes, realtime publication
- `vercel.json` — static deployment, no build
- `.gitignore` — keeps local-only files out of git

## Troubleshooting

- **Banner still says Local Demo:** `config.js` still has empty or
  placeholder values, or the browser cached the old file. Hard-refresh
  (Ctrl+Shift+R / Cmd+Shift+R) and re-check the values.
- **Supabase error on save:** check the URL / anon key, and that you
  ran `schema.sql` in the right project. Table names must be `leads`
  and `activities`.
- **Teammate does not see a new lead:** wait 5 seconds (the refresh
  fallback), then reload. Also check both of you opened the same
  Vercel URL, not a local `file://` copy.
- **Vercel shows a blank page:** make sure Output Directory is the
  repo root and Build Command is empty — this app needs no build.
