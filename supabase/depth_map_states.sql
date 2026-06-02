create table if not exists public.depth_map_states (
  subject_key text primary key check (subject_key in ('math', 'korean')),
  rows jsonb not null default '[]'::jsonb,
  common_depths jsonb not null default '[]'::jsonb,
  positions jsonb not null default '{}'::jsonb,
  source text not null default 'shared',
  updated_at timestamptz not null default now()
);

alter table public.depth_map_states enable row level security;

drop policy if exists "depth_map_states_select" on public.depth_map_states;
create policy "depth_map_states_select"
  on public.depth_map_states
  for select
  using (true);

drop policy if exists "depth_map_states_insert" on public.depth_map_states;
create policy "depth_map_states_insert"
  on public.depth_map_states
  for insert
  with check (true);

drop policy if exists "depth_map_states_update" on public.depth_map_states;
create policy "depth_map_states_update"
  on public.depth_map_states
  for update
  using (true)
  with check (true);

grant select, insert, update on public.depth_map_states to anon, authenticated;
