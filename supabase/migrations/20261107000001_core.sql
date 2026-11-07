-- Slate Ω — schéma cloud, migration 1 : profils, espaces, membres, nœuds + RLS.
-- Principes : RLS activée partout, refus par défaut ; helpers SECURITY DEFINER dans un schéma NON exposé (`private`)
-- avec search_path vide ; aucun droit pour `anon` ; l'espace d'un nœud est immuable ; le dernier administrateur est protégé.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

create type public.workspace_role as enum ('viewer', 'editor', 'admin');
create type public.node_kind as enum ('folder', 'page', 'database');

-- ── Tables ──────────────────────────────────────────────────────────────────
create table public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  display_name text not null default '' check (char_length(display_name) <= 100),
  avatar_path  text check (avatar_path is null or char_length(avatar_path) <= 500),
  locale       text not null default 'fr' check (locale in ('fr', 'en')),
  timezone     text not null default 'UTC' check (char_length(timezone) between 1 and 64),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(name) between 1 and 200),
  kind       text not null default 'personal' check (kind in ('personal', 'shared')),
  owner_id   uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         public.workspace_role not null default 'viewer',
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user on public.workspace_members (user_id);

create table public.nodes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  parent_id    uuid references public.nodes (id) on delete restrict,
  kind         public.node_kind not null,
  title        text not null default '' check (char_length(title) <= 500),
  position     text not null check (char_length(position) between 1 and 255),
  created_by   uuid not null default auth.uid() references auth.users (id) on delete restrict,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  deleted_at   timestamptz,
  version      bigint not null default 1,
  check (parent_id is null or parent_id <> id)
);
create index nodes_tree on public.nodes (workspace_id, parent_id, position) where deleted_at is null;
create index nodes_parent on public.nodes (parent_id);

alter table public.profiles enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.nodes enable row level security;

-- ── Fonctions d'autorisation (source de vérité unique) ─────────────────────────
create function private.role_rank(r public.workspace_role) returns int
language sql immutable set search_path = '' as $$
  select case r when 'viewer' then 1 when 'editor' then 2 when 'admin' then 3 end
$$;

create function private.has_role(ws uuid, min_role public.workspace_role) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = ws
      and m.user_id = (select auth.uid())
      and private.role_rank(m.role) >= private.role_rank(min_role)
  )
$$;

create function private.shares_workspace(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_members a
    join public.workspace_members b on b.workspace_id = a.workspace_id
    where a.user_id = (select auth.uid()) and b.user_id = other
  )
$$;

revoke execute on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;

-- ── Déclencheurs ─────────────────────────────────────────────────────────────
create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end $$;
create trigger profiles_touch before update on public.profiles for each row execute function private.touch_updated_at();
create trigger workspaces_touch before update on public.workspaces for each row execute function private.touch_updated_at();
create trigger nodes_touch before update on public.nodes for each row execute function private.touch_updated_at();

create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(left(new.raw_user_meta_data ->> 'display_name', 100), ''));
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function private.handle_new_user();

-- Le créateur d'un espace en devient administrateur.
create function private.add_owner_as_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.workspace_members (workspace_id, user_id, role) values (new.id, new.owner_id, 'admin');
  return new;
end $$;
create trigger workspaces_owner_admin after insert on public.workspaces for each row execute function private.add_owner_as_admin();

-- Champs immuables.
create function private.workspace_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.owner_id <> old.owner_id then raise exception 'owner_id is immutable' using errcode = '42501'; end if;
  return new;
end $$;
create trigger workspaces_immutable before update on public.workspaces for each row execute function private.workspace_immutable();

create function private.node_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.workspace_id <> old.workspace_id then
    raise exception 'workspace_id is immutable' using errcode = '42501';
  end if;
  if new.parent_id is not null and not exists (
    select 1 from public.nodes p where p.id = new.parent_id and p.workspace_id = new.workspace_id
  ) then
    raise exception 'parent must belong to the same workspace' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger nodes_guard before insert or update on public.nodes for each row execute function private.node_guard();

-- Un espace garde toujours au moins un administrateur (sauf suppression de l'espace lui-même).
create function private.protect_last_admin() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.role = 'admin'
     and exists (select 1 from public.workspaces w where w.id = old.workspace_id)
     and (tg_op = 'DELETE' or new.role <> 'admin')
     and not exists (
       select 1 from public.workspace_members m
       where m.workspace_id = old.workspace_id and m.role = 'admin' and m.user_id <> old.user_id
     ) then
    raise exception 'a workspace must keep at least one admin' using errcode = '23514';
  end if;
  return coalesce(new, old);
end $$;
create trigger members_protect_last_admin before update or delete on public.workspace_members for each row execute function private.protect_last_admin();

-- ── Politiques RLS ───────────────────────────────────────────────────────────
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or private.shares_workspace(id));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy workspaces_select on public.workspaces for select to authenticated
  using (owner_id = (select auth.uid()) or private.has_role(id, 'viewer'));
create policy workspaces_insert on public.workspaces for insert to authenticated
  with check (owner_id = (select auth.uid()));
create policy workspaces_update on public.workspaces for update to authenticated
  using (private.has_role(id, 'admin')) with check (private.has_role(id, 'admin'));
create policy workspaces_delete on public.workspaces for delete to authenticated
  using (owner_id = (select auth.uid()));

create policy members_select on public.workspace_members for select to authenticated
  using (private.has_role(workspace_id, 'viewer'));
create policy members_insert on public.workspace_members for insert to authenticated
  with check (private.has_role(workspace_id, 'admin'));
create policy members_update on public.workspace_members for update to authenticated
  using (private.has_role(workspace_id, 'admin')) with check (private.has_role(workspace_id, 'admin'));
create policy members_delete on public.workspace_members for delete to authenticated
  using (private.has_role(workspace_id, 'admin') or user_id = (select auth.uid()));

create policy nodes_select on public.nodes for select to authenticated
  using (private.has_role(workspace_id, 'viewer'));
create policy nodes_insert on public.nodes for insert to authenticated
  with check (private.has_role(workspace_id, 'editor') and created_by = (select auth.uid()));
create policy nodes_update on public.nodes for update to authenticated
  using (private.has_role(workspace_id, 'editor')) with check (private.has_role(workspace_id, 'editor'));
create policy nodes_delete on public.nodes for delete to authenticated
  using (private.has_role(workspace_id, 'admin'));

-- `anon` n'a aucun droit sur ces tables.
revoke all on public.profiles, public.workspaces, public.workspace_members, public.nodes from anon;
