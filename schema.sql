-- Lead CRM — Supabase schema
-- Run this whole file once in Supabase: SQL Editor -> New query -> paste -> Run.
-- It is safe to run again: tables are created only if they do not exist.
-- Columns below match exactly the fields used by app.js.

create extension if not exists pgcrypto;

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  name text not null,
  company text default '',
  email text default '',
  phone text default '',
  source text not null default 'Email',
  stage text not null default 'New',
  assignee text default '',
  follow_up_date date,
  notes text default '',
  requirement text default '',
  handed_over boolean not null default false,
  handoff_note text default '',
  handoff_date timestamptz
);

create table if not exists public.activities (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  lead_id uuid not null references public.leads(id) on delete cascade,
  channel text not null default 'Email',
  note text default ''
);

-- Keep updated_at fresh on edits.
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists leads_set_updated_at on public.leads;
create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

-- Indexes for the filters used in the UI.
create index if not exists leads_stage_idx on public.leads(stage);
create index if not exists leads_source_idx on public.leads(source);
create index if not exists leads_assignee_idx on public.leads(assignee);
create index if not exists leads_follow_up_idx on public.leads(follow_up_date);
create index if not exists activities_lead_idx on public.activities(lead_id);

-- Realtime: publish both tables so teammates see each other's edits live.
-- (Supabase Dashboard -> Database -> Replication must also include these
-- tables; the SQL below covers the publication used by Supabase Realtime.)
alter publication supabase_realtime add table public.leads;
alter publication supabase_realtime add table public.activities;

-- NOTE ON ACCESS (read before adding real client data):
-- For a quick team demo, Supabase projects often start with Row Level
-- Security off. For real data, turn RLS ON and add policies, or add
-- Supabase Auth and restrict the app to signed-in teammates. Example:
--   alter table public.leads enable row level security;
--   alter table public.activities enable row level security;
-- Then create policies in Dashboard -> Authentication -> Policies that
-- allow only your team's authenticated users to select/insert/update/delete.
-- Do NOT put the service_role key in the browser code.
