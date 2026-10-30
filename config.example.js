// Lead CRM — Supabase configuration (example)
// 1. Copy this file to config.js (or edit config.js directly).
// 2. Create a free project at https://supabase.com/dashboard
// 3. In Supabase, open SQL Editor, paste schema.sql and run it.
// 4. In Supabase, go to Project Settings -> API, copy the Project URL
//    and the anon / public key, and paste them below.
// 5. Redeploy (or just reload, if you edited config.js on Vercel via a
//    new commit). Teammates opening the same Vercel URL will then share
//    the same database.
//
// SECURITY: Only the anon (public) key belongs here. It is safe to ship
// in a browser app, but it is NOT a secret password. Never put the
// Supabase service_role key in this file. Before putting real client
// data in, add Supabase Auth and/or Row Level Security rules so only
// your team can read/write. See README.md.
window.LEAD_CRM_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-KEY"
};
