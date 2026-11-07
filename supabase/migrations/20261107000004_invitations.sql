-- Invitations à rejoindre un espace (édition à plusieurs). Voir docs/COLLABORATION.md.
-- Le jeton n'est JAMAIS stocké : seulement son empreinte SHA-256. Il est montré une seule fois à l'invitant.
-- Aucune lecture ni écriture directe par les clients : tout passe par des fonctions qui vérifient les droits.

create table public.workspace_invitations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email        text not null check (email = lower(email) and char_length(email) between 3 and 320 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  role         public.workspace_role not null,
  token_hash   text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  created_by   uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  accepted_by  uuid references auth.users (id) on delete set null,
  revoked_at   timestamptz
);
create index workspace_invitations_ws on public.workspace_invitations (workspace_id);
alter table public.workspace_invitations enable row level security;
create policy workspace_invitations_select on public.workspace_invitations for select to authenticated
  using (private.has_role(workspace_id, 'admin'));
revoke all on public.workspace_invitations from anon, authenticated;
grant select on public.workspace_invitations to authenticated;

-- Crée une invitation. Retourne le jeton (une seule fois). Une invitation en attente pour la même adresse est remplacée.
create function public.create_invitation(p_workspace uuid, p_email text, p_role public.workspace_role, p_ttl_hours int default 168)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_id uuid; v_exp timestamptz;
begin
  if (select auth.uid()) is null or not private.has_role(p_workspace, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or char_length(v_email) > 320 then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  if (select count(*) from public.workspace_invitations
      where workspace_id = p_workspace and accepted_at is null and revoked_at is null and expires_at > now()) >= 50 then
    raise exception 'too_many_invitations' using errcode = '54000';
  end if;
  update public.workspace_invitations set revoked_at = now()
   where workspace_id = p_workspace and email = v_email and accepted_at is null and revoked_at is null;
  v_exp := now() + make_interval(hours => greatest(1, least(coalesce(p_ttl_hours, 168), 720)));
  insert into public.workspace_invitations (workspace_id, email, role, token_hash, created_by, expires_at)
  values (p_workspace, v_email, p_role, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), (select auth.uid()), v_exp)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_exp, 'email', v_email, 'role', p_role);
end $$;

-- Accepte une invitation. TOUTES les causes d'échec donnent la même erreur (pas d'oracle sur l'existence d'un jeton).
-- L'adresse du compte connecté (jeton signé par le serveur d'authentification) doit être celle de l'invitation.
create function public.accept_invitation(p_token text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  inv public.workspace_invitations; v_email text := lower(coalesce((select auth.jwt()) ->> 'email', '')); ws_name text;
begin
  if (select auth.uid()) is null or p_token is null or char_length(p_token) > 200 then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;
  select * into inv from public.workspace_invitations
   where token_hash = encode(sha256(convert_to(btrim(p_token), 'UTF8')), 'hex') for update;
  if not found or inv.accepted_at is not null or inv.revoked_at is not null or inv.expires_at <= now()
     or v_email = '' or inv.email <> v_email then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;
  insert into public.workspace_members (workspace_id, user_id, role)
  values (inv.workspace_id, (select auth.uid()), inv.role)
  on conflict (workspace_id, user_id) do update
    set role = case when private.role_rank(excluded.role) > private.role_rank(public.workspace_members.role)
                    then excluded.role else public.workspace_members.role end;
  update public.workspace_invitations set accepted_at = now(), accepted_by = (select auth.uid()) where id = inv.id;
  select name into ws_name from public.workspaces where id = inv.workspace_id;
  return jsonb_build_object('workspace_id', inv.workspace_id, 'name', ws_name,
    'role', (select role from public.workspace_members where workspace_id = inv.workspace_id and user_id = (select auth.uid())));
end $$;

create function public.revoke_invitation(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ws uuid;
begin
  select workspace_id into ws from public.workspace_invitations where id = p_id;
  if ws is null or (select auth.uid()) is null or not private.has_role(ws, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.workspace_invitations set revoked_at = now() where id = p_id and accepted_at is null and revoked_at is null;
end $$;

-- Membres d'un espace avec leur adresse (visible des seuls membres de cet espace).
create function public.list_members(p_workspace uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null or not private.has_role(p_workspace, 'viewer') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', m.user_id, 'role', m.role, 'display_name', coalesce(p.display_name, ''),
             'email', u.email, 'is_me', m.user_id = (select auth.uid())) order by m.created_at)
    from public.workspace_members m
    join auth.users u on u.id = m.user_id
    left join public.profiles p on p.id = m.user_id
    where m.workspace_id = p_workspace), '[]'::jsonb);
end $$;

revoke execute on function public.create_invitation(uuid, text, public.workspace_role, int), public.accept_invitation(text),
  public.revoke_invitation(uuid), public.list_members(uuid) from public, anon;
grant execute on function public.create_invitation(uuid, text, public.workspace_role, int), public.accept_invitation(text),
  public.revoke_invitation(uuid), public.list_members(uuid) to authenticated;
