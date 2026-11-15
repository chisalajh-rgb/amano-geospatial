-- Amano Georeferencer: activity history.
-- Run this once in your Supabase project: SQL Editor -> New query -> paste -> Run.
-- Each person can see, add, change and delete only their own rows.

create table if not exists public.map_history (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  file_name   text not null,
  title       text,
  status      text not null,            -- 'Georeferenced' or 'Digitized'
  crs         text,
  points      integer,
  rms_px      double precision,
  thumbnail   text,                     -- small preview image (data URL)
  details     jsonb                     -- summary of the fit, units and exports
);

create index if not exists map_history_user_time on public.map_history (user_id, created_at desc);

alter table public.map_history enable row level security;

drop policy if exists "own rows: read"   on public.map_history;
drop policy if exists "own rows: insert" on public.map_history;
drop policy if exists "own rows: update" on public.map_history;
drop policy if exists "own rows: delete" on public.map_history;

create policy "own rows: read"   on public.map_history for select using (auth.uid() = user_id);
create policy "own rows: insert" on public.map_history for insert with check (auth.uid() = user_id);
create policy "own rows: update" on public.map_history for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rows: delete" on public.map_history for delete using (auth.uid() = user_id);
