-- Supabase Cloud schema for the controller inventory sync (Phase 2).
--
-- Mirrors the local SQLite schema in src-tauri/src/inventory_db.rs so the
-- push/pull sync engine (src-tauri/src/inventory_sync.rs) can reconcile rows by
-- (org_id, id) using last-write-wins on updated_at with tombstones.
--
-- Dev validation with a local-hosted Supabase (never a runtime dependency for
-- shipped users):
--   supabase init
--   supabase start            # boots Postgres + Auth + PostgREST in Docker
--   supabase db reset         # applies these migrations
-- Then point the desktop app's SupabaseTransport at the local API URL + anon key
-- to exercise RLS before switching to the hosted cloud project.

-- Organization membership: the join table RLS uses to scope every row to the
-- orgs a signed-in user belongs to. `user_id` is the Supabase auth user id.
create table if not exists public.org_members (
  org_id  text not null,
  user_id uuid not null default auth.uid(),
  role    text not null default 'member',
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);

create table if not exists public.inventory_entities (
  org_id       text not null,
  id           text not null,            -- e.g. "equip:<uuid>"
  type         text not null,
  name         text,
  data         jsonb not null,           -- full entity body (tags, sourceRefs, ...)
  content_hash text not null,
  created_at   timestamptz,
  updated_at   timestamptz not null default now(),
  deleted      boolean not null default false,
  rev          bigint not null default 1,
  primary key (org_id, id)
);
create index if not exists idx_inventory_entities_sync
  on public.inventory_entities (org_id, updated_at);

create table if not exists public.bacnet_discovery_cache (
  org_id       text not null,
  key          text not null,
  data         jsonb not null,
  content_hash text not null,
  seen_at      timestamptz,
  updated_at   timestamptz not null default now(),
  deleted      boolean not null default false,
  rev          bigint not null default 1,
  primary key (org_id, key)
);
create index if not exists idx_bacnet_cache_sync
  on public.bacnet_discovery_cache (org_id, updated_at);

-- ---- Row Level Security: a user only sees/writes rows for orgs they belong to ----

alter table public.org_members            enable row level security;
alter table public.inventory_entities     enable row level security;
alter table public.bacnet_discovery_cache enable row level security;

create policy org_members_self_read on public.org_members
  for select using (user_id = auth.uid());

create policy inventory_entities_member_rw on public.inventory_entities
  for all
  using (org_id in (select org_id from public.org_members where user_id = auth.uid()))
  with check (org_id in (select org_id from public.org_members where user_id = auth.uid()));

create policy bacnet_cache_member_rw on public.bacnet_discovery_cache
  for all
  using (org_id in (select org_id from public.org_members where user_id = auth.uid()))
  with check (org_id in (select org_id from public.org_members where user_id = auth.uid()));

-- Keep updated_at fresh on every write so the pull cursor (updated_at > since)
-- stays correct even if a client forgets to set it.
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_inventory_entities_touch
  before insert or update on public.inventory_entities
  for each row execute function public.touch_updated_at();

create trigger trg_bacnet_cache_touch
  before insert or update on public.bacnet_discovery_cache
  for each row execute function public.touch_updated_at();
