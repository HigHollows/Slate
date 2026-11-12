-- Partage d'un DOSSIER ou d'une PAGE précis (au lieu de tout l'espace). Voir docs/COLLABORATION.md.
-- Un « invité » n'est pas membre de l'espace : il ne voit et ne modifie que les éléments partagés et leurs descendants.
-- Source de vérité unique : private.node_access(nœud, rôle minimum) = rôle de membre OU partage sur le nœud ou un ancêtre.

create table public.node_shares (
  node_id      uuid not null references public.nodes (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  role         public.workspace_role not null check (role in ('viewer', 'editor')),
  created_by   uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (node_id, user_id)
);
create index node_shares_user on public.node_shares (user_id, workspace_id);
alter table public.node_shares enable row level security;
-- Lecture : ses propres partages, ou tous ceux de l'espace pour un administrateur. Aucune écriture directe (fonctions seulement).
create policy node_shares_select on public.node_shares for select to authenticated
  using (user_id = (select auth.uid()) or private.has_role(workspace_id, 'admin'));
revoke all on public.node_shares from anon, authenticated;
grant select on public.node_shares to authenticated;

alter table public.workspace_invitations add column node_id uuid references public.nodes (id) on delete cascade;

create function private.has_share(ws uuid, min_role public.workspace_role) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.node_shares s
    where s.workspace_id = ws and s.user_id = (select auth.uid())
      and private.role_rank(s.role) >= private.role_rank(min_role))
$$;

-- Accès à un nœud : membre de son espace, ou partage sur ce nœud ou l'un de ses ancêtres (profondeur bornée).
create function private.node_access(p_node uuid, min_role public.workspace_role) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare ws uuid; me uuid := (select auth.uid());
begin
  if p_node is null or me is null then return false; end if;
  select workspace_id into ws from public.nodes where id = p_node;
  if ws is null then return false; end if;
  if private.has_role(ws, min_role) then return true; end if;
  if not exists (select 1 from public.node_shares s where s.workspace_id = ws and s.user_id = me) then return false; end if;
  return exists (
    with recursive up(id, parent_id, depth) as (
      select n.id, n.parent_id, 0 from public.nodes n where n.id = p_node
      union all
      select p.id, p.parent_id, up.depth + 1 from public.nodes p join up on p.id = up.parent_id where up.depth < 64
    )
    select 1 from up join public.node_shares s on s.node_id = up.id
    where s.user_id = me and private.role_rank(s.role) >= private.role_rank(min_role));
end $$;

create function private.thread_access(p_thread uuid, min_role public.workspace_role) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.node_access((select node_id from public.comment_threads where id = p_thread), min_role)
$$;
revoke execute on function private.has_share(uuid, public.workspace_role), private.node_access(uuid, public.workspace_role),
  private.thread_access(uuid, public.workspace_role) from public, anon;
grant execute on function private.has_share(uuid, public.workspace_role), private.node_access(uuid, public.workspace_role),
  private.thread_access(uuid, public.workspace_role) to authenticated;

-- ── Politiques : l'accès se décide désormais par nœud (un membre garde exactement les mêmes droits qu'avant) ──
drop policy nodes_select on public.nodes;
drop policy nodes_insert on public.nodes;
drop policy nodes_update on public.nodes;
create policy nodes_select on public.nodes for select to authenticated using (private.node_access(id, 'viewer'));
create policy nodes_insert on public.nodes for insert to authenticated
  with check (created_by = (select auth.uid())
    and (private.has_role(workspace_id, 'editor') or (parent_id is not null and private.node_access(parent_id, 'editor'))));
create policy nodes_update on public.nodes for update to authenticated
  using (private.node_access(id, 'editor')) with check (private.node_access(id, 'editor'));

drop policy doc_updates_select on public.doc_updates;
drop policy doc_updates_insert on public.doc_updates;
create policy doc_updates_select on public.doc_updates for select to authenticated using (private.node_access(node_id, 'viewer'));
create policy doc_updates_insert on public.doc_updates for insert to authenticated
  with check (author_id = (select auth.uid()) and private.node_access(node_id, 'editor')
    and exists (select 1 from public.nodes n where n.id = node_id and n.workspace_id = doc_updates.workspace_id and n.kind = 'page'));

drop policy applied_ops_select on public.applied_ops;
drop policy applied_ops_insert on public.applied_ops;
create policy applied_ops_select on public.applied_ops for select to authenticated
  using (private.has_role(workspace_id, 'viewer') or applied_by = (select auth.uid()));
create policy applied_ops_insert on public.applied_ops for insert to authenticated
  with check (applied_by = (select auth.uid())
    and (private.has_role(workspace_id, 'editor') or private.has_share(workspace_id, 'editor')));

drop policy db_properties_select on public.db_properties;
drop policy db_properties_insert on public.db_properties;
drop policy db_properties_update on public.db_properties;
create policy db_properties_select on public.db_properties for select to authenticated using (private.node_access(database_id, 'viewer'));
create policy db_properties_insert on public.db_properties for insert to authenticated with check (private.node_access(database_id, 'editor'));
create policy db_properties_update on public.db_properties for update to authenticated
  using (private.node_access(database_id, 'editor')) with check (private.node_access(database_id, 'editor'));
drop policy db_views_select on public.db_views;
drop policy db_views_insert on public.db_views;
drop policy db_views_update on public.db_views;
create policy db_views_select on public.db_views for select to authenticated using (private.node_access(database_id, 'viewer'));
create policy db_views_insert on public.db_views for insert to authenticated with check (private.node_access(database_id, 'editor'));
create policy db_views_update on public.db_views for update to authenticated
  using (private.node_access(database_id, 'editor')) with check (private.node_access(database_id, 'editor'));
drop policy db_rows_select on public.db_rows;
drop policy db_rows_insert on public.db_rows;
drop policy db_rows_update on public.db_rows;
create policy db_rows_select on public.db_rows for select to authenticated using (private.node_access(node_id, 'viewer'));
create policy db_rows_insert on public.db_rows for insert to authenticated with check (private.node_access(node_id, 'editor'));
create policy db_rows_update on public.db_rows for update to authenticated
  using (private.node_access(node_id, 'editor')) with check (private.node_access(node_id, 'editor'));

drop policy comment_threads_select on public.comment_threads;
drop policy comment_threads_insert on public.comment_threads;
drop policy comment_threads_update on public.comment_threads;
create policy comment_threads_select on public.comment_threads for select to authenticated using (private.node_access(node_id, 'viewer'));
create policy comment_threads_insert on public.comment_threads for insert to authenticated
  with check (created_by = (select auth.uid()) and private.node_access(node_id, 'editor'));
create policy comment_threads_update on public.comment_threads for update to authenticated
  using (private.node_access(node_id, 'editor')) with check (private.node_access(node_id, 'editor'));
drop policy comments_select on public.comments;
drop policy comments_insert on public.comments;
drop policy comments_update on public.comments;
create policy comments_select on public.comments for select to authenticated using (private.thread_access(thread_id, 'viewer'));
create policy comments_insert on public.comments for insert to authenticated
  with check (author_id = (select auth.uid()) and private.thread_access(thread_id, 'editor'));
create policy comments_update on public.comments for update to authenticated
  using (private.thread_access(thread_id, 'editor') and (author_id = (select auth.uid()) or private.has_role(workspace_id, 'admin')))
  with check (private.thread_access(thread_id, 'editor') and (author_id = (select auth.uid()) or private.has_role(workspace_id, 'admin')));

-- Présence en direct : même règle par nœud.
create or replace function private.realtime_doc_allowed(p_topic text, p_min public.workspace_role) returns boolean
language plpgsql stable set search_path = '' as $$
declare ws uuid; pg uuid;
begin
  if p_topic is null or p_topic !~ '^doc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  ws := split_part(p_topic, ':', 2)::uuid;
  pg := split_part(p_topic, ':', 3)::uuid;
  return private.node_access(pg, p_min)
     and exists (select 1 from public.nodes n where n.id = pg and n.workspace_id = ws and n.kind = 'page' and n.purged_at is null);
end $$;

-- ── Invitations ciblées ─────────────────────────────────────────────────────────────────────────────────────
-- Invite une adresse sur UN dossier ou UNE page (lecteur ou éditeur ; jamais administrateur). Administrateurs de l'espace seulement.
create function public.create_node_invitation(p_node uuid, p_email text, p_role public.workspace_role, p_ttl_hours int default 168)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_id uuid; v_exp timestamptz; n public.nodes;
begin
  select * into n from public.nodes where id = p_node and purged_at is null and deleted_at is null;
  if (select auth.uid()) is null or not found or not private.has_role(n.workspace_id, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_role not in ('viewer', 'editor') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or char_length(v_email) > 320 then
    raise exception 'invalid_email' using errcode = '22023';
  end if;
  if (select count(*) from public.workspace_invitations
      where workspace_id = n.workspace_id and accepted_at is null and revoked_at is null and expires_at > now()) >= 50 then
    raise exception 'too_many_invitations' using errcode = '54000';
  end if;
  update public.workspace_invitations set revoked_at = now()
   where node_id = p_node and email = v_email and accepted_at is null and revoked_at is null;
  v_exp := now() + make_interval(hours => greatest(1, least(coalesce(p_ttl_hours, 168), 720)));
  insert into public.workspace_invitations (workspace_id, node_id, email, role, token_hash, created_by, expires_at)
  values (n.workspace_id, p_node, v_email, p_role, encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), (select auth.uid()), v_exp)
  returning id into v_id;
  return jsonb_build_object('id', v_id, 'token', v_token, 'expires_at', v_exp, 'email', v_email, 'role', p_role, 'node_id', p_node);
end $$;

-- Accepte une invitation (espace entier OU élément précis). Mêmes garanties qu'avant : une seule erreur pour tous les échecs,
-- adresse du jeton de session = adresse invitée, jamais de rétrogradation.
create or replace function public.accept_invitation(p_token text)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  inv public.workspace_invitations; v_email text := lower(coalesce((select auth.jwt()) ->> 'email', '')); ws_name text;
  me uuid := (select auth.uid()); v_role public.workspace_role;
begin
  if me is null or p_token is null or char_length(p_token) > 200 then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;
  select * into inv from public.workspace_invitations
   where token_hash = encode(sha256(convert_to(btrim(p_token), 'UTF8')), 'hex') for update;
  if not found or inv.accepted_at is not null or inv.revoked_at is not null or inv.expires_at <= now()
     or v_email = '' or inv.email <> v_email then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;
  select name into ws_name from public.workspaces where id = inv.workspace_id;
  if inv.node_id is not null then
    if not exists (select 1 from public.nodes where id = inv.node_id and purged_at is null) then
      raise exception 'invitation_invalid' using errcode = 'P0001';
    end if;
    insert into public.node_shares (node_id, user_id, workspace_id, role, created_by)
    values (inv.node_id, me, inv.workspace_id, inv.role, inv.created_by)
    on conflict (node_id, user_id) do update
      set role = case when private.role_rank(excluded.role) > private.role_rank(public.node_shares.role)
                      then excluded.role else public.node_shares.role end;
    update public.workspace_invitations set accepted_at = now(), accepted_by = me where id = inv.id;
    -- Rôle local = le plus élevé de ses accès dans cet espace (membre ou partages).
    select case max(r) when 3 then 'admin' when 2 then 'editor' else 'viewer' end::public.workspace_role into v_role from (
      select private.role_rank(role) r from public.node_shares where user_id = me and workspace_id = inv.workspace_id
      union all select private.role_rank(role) from public.workspace_members where user_id = me and workspace_id = inv.workspace_id) x;
    return jsonb_build_object('workspace_id', inv.workspace_id, 'name', ws_name, 'role', v_role, 'node_id', inv.node_id,
      'scope', case when private.has_role(inv.workspace_id, 'viewer') then 'member' else 'shared' end);
  end if;
  insert into public.workspace_members (workspace_id, user_id, role)
  values (inv.workspace_id, me, inv.role)
  on conflict (workspace_id, user_id) do update
    set role = case when private.role_rank(excluded.role) > private.role_rank(public.workspace_members.role)
                    then excluded.role else public.workspace_members.role end;
  update public.workspace_invitations set accepted_at = now(), accepted_by = me where id = inv.id;
  return jsonb_build_object('workspace_id', inv.workspace_id, 'name', ws_name, 'scope', 'member',
    'role', (select role from public.workspace_members where workspace_id = inv.workspace_id and user_id = me));
end $$;

-- Tous mes accès : espaces dont je suis membre, et espaces où l'on m'a seulement partagé des éléments (rôle = le plus élevé).
create function public.my_access() returns jsonb
language sql stable security definer set search_path = '' as $$
  with me as (select (select auth.uid()) id),
  m as (select wm.workspace_id, private.role_rank(wm.role) r, 'member' scope from public.workspace_members wm, me where wm.user_id = me.id),
  s as (select ns.workspace_id, max(private.role_rank(ns.role)) r, 'shared' scope from public.node_shares ns, me
        where ns.user_id = me.id and ns.workspace_id not in (select workspace_id from m) group by ns.workspace_id),
  u as (select * from m union all select * from s)
  select coalesce(jsonb_agg(jsonb_build_object('workspace_id', u.workspace_id, 'name', w.name, 'scope', u.scope,
           'role', case u.r when 3 then 'admin' when 2 then 'editor' else 'viewer' end)), '[]'::jsonb)
  from u join public.workspaces w on w.id = u.workspace_id
$$;

-- Qui a accès à cet élément précisément (hors membres de l'espace), et les invitations en attente. Administrateurs seulement.
create function public.list_node_shares(p_node uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare ws uuid;
begin
  select workspace_id into ws from public.nodes where id = p_node;
  if (select auth.uid()) is null or ws is null or not private.has_role(ws, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'shares', coalesce((select jsonb_agg(jsonb_build_object('user_id', s.user_id, 'role', s.role, 'email', u.email,
                 'display_name', coalesce(p.display_name, '')) order by s.created_at)
               from public.node_shares s join auth.users u on u.id = s.user_id left join public.profiles p on p.id = s.user_id
               where s.node_id = p_node), '[]'::jsonb),
    'invitations', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'email', i.email, 'role', i.role, 'expires_at', i.expires_at) order by i.created_at desc)
               from public.workspace_invitations i
               where i.node_id = p_node and i.accepted_at is null and i.revoked_at is null and i.expires_at > now()), '[]'::jsonb));
end $$;

-- Retire un partage : un administrateur de l'espace, ou l'invité lui-même (quitter).
create function public.remove_node_share(p_node uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ws uuid;
begin
  select workspace_id into ws from public.nodes where id = p_node;
  if (select auth.uid()) is null or ws is null
     or not (private.has_role(ws, 'admin') or p_user = (select auth.uid())) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  delete from public.node_shares where node_id = p_node and user_id = p_user;
end $$;

revoke execute on function public.create_node_invitation(uuid, text, public.workspace_role, int), public.my_access(),
  public.list_node_shares(uuid), public.remove_node_share(uuid, uuid) from public, anon;
grant execute on function public.create_node_invitation(uuid, text, public.workspace_role, int), public.my_access(),
  public.list_node_shares(uuid), public.remove_node_share(uuid, uuid) to authenticated;

-- ── Synchronisation : mêmes fonctions, ouvertes aux invités (chaque accès reste décidé par nœud) ──────────────────
create or replace function public.sync_push(p_workspace uuid, p_ops jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  op jsonb; results jsonb := '[]'::jsonb;
  v_op uuid; v_entity text; v_id uuid; v_fields jsonb; v_ms bigint; v_dev text;
  n public.nodes; f text; any_applied boolean; status text; reason text;
  new_clocks jsonb; cyc boolean; v_guest boolean; v_parent uuid;
begin
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' or jsonb_array_length(p_ops) > 200 then
    raise exception 'invalid batch' using errcode = '22023';
  end if;
  -- Membre éditeur de l'espace, ou « invité » : quelqu'un à qui seuls certains dossiers ou pages ont été partagés.
  -- Pour un invité, chaque opération est vérifiée nœud par nœud (RLS + contrôles ci-dessous) ; un refus ne bloque que l'opération.
  v_guest := not private.has_role(p_workspace, 'editor');
  if v_guest and not private.has_share(p_workspace, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  for op in select value from jsonb_array_elements(p_ops) loop
    status := 'applied'; reason := null;
    begin
      v_op := (op ->> 'op_id')::uuid;
      v_entity := op ->> 'entity';
      v_id := (op ->> 'entity_id')::uuid;
      v_ms := (op #>> '{clock,ms}')::bigint;
      v_dev := op #>> '{clock,device}';
      if v_dev is null or length(v_dev) > 64 or v_ms is null then raise exception 'bad_clock'; end if;
      if exists (select 1 from public.applied_ops where op_id = v_op) then
        status := 'duplicate';
      elsif v_entity = 'node' and (op -> 'fields') ? 'purged_at' then
        -- Suppression définitive : seulement depuis la corbeille ; le contenu est effacé, une pierre tombale reste
        -- pour que les autres appareils suppriment aussi leur copie.
        select * into n from public.nodes where id = v_id and workspace_id = p_workspace for update;
        if v_guest then raise exception 'guest_forbidden'; end if; -- la suppression définitive reste aux membres de l'espace
        if not found or n.purged_at is not null then
          status := 'merged';
        elsif n.deleted_at is null then
          raise exception 'not_in_trash';
        else
          perform private.purge_node(p_workspace, v_id);
        end if;
      elsif v_entity = 'node' then
        v_fields := coalesce(op -> 'fields', '{}'::jsonb);
        select * into n from public.nodes where id = v_id and workspace_id = p_workspace for update;
        if found and n.purged_at is not null then raise exception 'purged'; end if;
        if v_guest then
          -- Un invité ne sort jamais de ce qui lui est partagé : le parent visé doit lui être accessible en écriture,
          -- et il ne peut ni déplacer ni mettre à la corbeille l'élément qui lui a été partagé lui-même.
          if v_fields ? 'parent_id' then
            v_parent := (v_fields ->> 'parent_id')::uuid;
            if v_parent is null or not private.node_access(v_parent, 'editor') then raise exception 'guest_forbidden'; end if;
          end if;
          if not found then
            if not (v_fields ? 'parent_id') then raise exception 'guest_forbidden'; end if;
          else
            if not private.node_access(v_id, 'editor') then raise exception 'guest_forbidden'; end if;
            if (v_fields ? 'parent_id' or v_fields ? 'deleted_at')
               and exists (select 1 from public.node_shares s where s.node_id = v_id and s.user_id = (select auth.uid())) then
              raise exception 'guest_forbidden';
            end if;
          end if;
        end if;
        if not found then
          if exists (select 1 from public.nodes where id = v_id) then raise exception 'foreign_node'; end if;
          if not (v_fields ? 'kind' and v_fields ? 'position') then raise exception 'incomplete_create'; end if;
          if (v_fields ->> 'parent_id') is not null
             and not exists (select 1 from public.nodes p where p.id = (v_fields ->> 'parent_id')::uuid and p.workspace_id = p_workspace) then
            raise exception 'parent_missing';
          end if;
          insert into public.nodes (id, workspace_id, parent_id, kind, title, position, deleted_at, clocks)
          values (v_id, p_workspace, (v_fields ->> 'parent_id')::uuid, (v_fields ->> 'kind')::public.node_kind,
                  coalesce(v_fields ->> 'title', ''), v_fields ->> 'position', (v_fields ->> 'deleted_at')::timestamptz,
                  (select coalesce(jsonb_object_agg(k, jsonb_build_array(v_ms, v_dev)), '{}'::jsonb)
                   from jsonb_object_keys(v_fields) k where k in ('title', 'parent_id', 'position', 'deleted_at')));
        else
          new_clocks := n.clocks; any_applied := false;
          for f in select * from jsonb_object_keys(v_fields) loop
            continue when f not in ('title', 'parent_id', 'position', 'deleted_at');
            continue when not private.clock_newer(n.clocks -> f, v_ms, v_dev);
            if f = 'parent_id' and (v_fields ->> f) is not null then
              if not exists (select 1 from public.nodes p where p.id = (v_fields ->> f)::uuid and p.workspace_id = p_workspace) then
                raise exception 'parent_missing';
              end if;
              with recursive up(id) as (
                select (v_fields ->> f)::uuid
                union all select p.parent_id from public.nodes p join up on p.id = up.id where p.parent_id is not null
              ) select exists (select 1 from up where id = v_id) into cyc;
              if cyc then raise exception 'cycle'; end if;
            end if;
            if f = 'title' then n.title := coalesce(v_fields ->> f, '');
            elsif f = 'parent_id' then n.parent_id := (v_fields ->> f)::uuid;
            elsif f = 'position' then n.position := v_fields ->> f;
            elsif f = 'deleted_at' then n.deleted_at := (v_fields ->> f)::timestamptz;
            end if;
            new_clocks := jsonb_set(new_clocks, array[f], jsonb_build_array(v_ms, v_dev));
            any_applied := true;
          end loop;
          if any_applied then
            update public.nodes set title = n.title, parent_id = n.parent_id, position = n.position,
              deleted_at = n.deleted_at, clocks = new_clocks, version = version + 1 where id = v_id;
          else status := 'merged'; end if;
        end if;
      elsif v_entity = 'doc' then
        if not exists (select 1 from public.nodes where id = v_id and workspace_id = p_workspace and kind = 'page' and purged_at is null) then
          raise exception 'node_missing';
        end if;
        insert into public.doc_updates (workspace_id, node_id, op_id, device_id, update)
        values (p_workspace, v_id, v_op, v_dev::uuid, decode(op ->> 'update', 'base64'));
      elsif v_entity in ('prop', 'view', 'row') then
        status := private.apply_struct_op(p_workspace, v_entity, v_id, coalesce(op -> 'fields', '{}'::jsonb), v_ms, v_dev);
      elsif v_entity in ('thread', 'comment') then
        status := private.apply_comment_op(p_workspace, v_entity, v_id, coalesce(op -> 'fields', '{}'::jsonb), v_ms, v_dev);
      else
        raise exception 'unknown_entity';
      end if;
      if status <> 'duplicate' then
        insert into public.applied_ops (op_id, workspace_id, result) values (v_op, p_workspace, status);
      end if;
    exception
      when insufficient_privilege then
        if v_guest then status := 'rejected'; reason := 'guest_forbidden'; else raise; end if;
      when others then
        status := 'rejected'; reason := left(sqlerrm, 80);
    end;
    results := results || jsonb_build_object('op_id', op ->> 'op_id', 'status', status, 'reason', reason);
  end loop;
  return results;
end $$;


create or replace function public.sync_pull(p_workspace uuid, p_node_since bigint, p_doc_since bigint, p_limit int default 200)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  lim int := greatest(1, least(coalesce(p_limit, 200), 500));
  dlim int := greatest(1, least(coalesce(p_limit, 200), 25));
  nodes_out jsonb; docs_out jsonb; node_max bigint; doc_max bigint; more_n boolean; more_d boolean;
begin
  -- Membre, ou invité (partage d'un dossier ou d'une page) : la RLS ne laisse alors voir que ce qui est partagé.
  if not private.has_role(p_workspace, 'viewer') and not private.has_share(p_workspace, 'viewer') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  with page as (
    select * from public.nodes where workspace_id = p_workspace and server_seq > coalesce(p_node_since, 0)
    order by server_seq limit lim + 1
  ), cut as (select * from page order by server_seq limit lim)
  select coalesce(jsonb_agg(jsonb_build_object('id', id,
           -- le parent d'un élément partagé n'est pas visible de l'invité : l'élément apparaît à la racine chez lui
           'parent_id', case when parent_id is null or private.node_access(parent_id, 'viewer') then parent_id end, 'kind', kind, 'title', title,
           'position', position, 'deleted_at', deleted_at, 'purged_at', purged_at, 'created_at', created_at, 'server_seq', server_seq) order by server_seq), '[]'::jsonb),
         max(server_seq), (select count(*) from page) > lim
    into nodes_out, node_max, more_n from cut;
  with page as (
    select * from public.doc_updates where workspace_id = p_workspace and id > coalesce(p_doc_since, 0)
    order by id limit dlim + 1
  ), cut as (select * from page order by id limit dlim)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'node_id', node_id, 'device_id', device_id,
           'update', encode(update, 'base64'), 'created_at', created_at) order by id), '[]'::jsonb),
         max(id), (select count(*) from page) > dlim
    into docs_out, doc_max, more_d from cut;
  return jsonb_build_object('nodes', nodes_out, 'node_cursor', node_max, 'more_nodes', more_n,
                            'docs', docs_out, 'doc_cursor', doc_max, 'more_docs', more_d);
end $$;



create or replace function public.sync_pull_struct(p_workspace uuid, p_since bigint, p_limit int default 200) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  lim int := greatest(1, least(coalesce(p_limit, 200), 500));
  items jsonb; cursor_max bigint; more boolean;
begin
  if not private.has_role(p_workspace, 'viewer') and not private.has_share(p_workspace, 'viewer') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  with u as (
    select 'prop' as kind, server_seq, jsonb_build_object('kind', 'prop', 'id', id, 'database_id', database_id, 'name', name,
             'type', type, 'config', config, 'position', position, 'deleted_at', deleted_at, 'server_seq', server_seq) as j
      from public.db_properties where workspace_id = p_workspace and server_seq > coalesce(p_since, 0)
    union all
    select 'view', server_seq, jsonb_build_object('kind', 'view', 'id', id, 'database_id', database_id, 'name', name,
             'layout', layout, 'config', config, 'position', position, 'deleted_at', deleted_at, 'server_seq', server_seq)
      from public.db_views where workspace_id = p_workspace and server_seq > coalesce(p_since, 0)
    union all
    select 'row', server_seq, jsonb_build_object('kind', 'row', 'id', node_id, 'database_id', database_id, 'props', props,
             'server_seq', server_seq)
      from public.db_rows where workspace_id = p_workspace and server_seq > coalesce(p_since, 0)
    union all
    select 'thread', server_seq, jsonb_build_object('kind', 'thread', 'id', id, 'node_id', node_id, 'quote', quote,
             'author_label', author_label, 'created_at', created_at, 'resolved_at', resolved_at, 'resolved_label', resolved_label,
             'deleted_at', deleted_at, 'server_seq', server_seq)
      from public.comment_threads where workspace_id = p_workspace and server_seq > coalesce(p_since, 0)
    union all
    select 'comment', server_seq, jsonb_build_object('kind', 'comment', 'id', id, 'thread_id', thread_id, 'body', body,
             'author_label', author_label, 'created_at', created_at, 'edited_at', edited_at, 'deleted_at', deleted_at,
             'server_seq', server_seq)
      from public.comments where workspace_id = p_workspace and server_seq > coalesce(p_since, 0)
  ), page as (select * from u order by server_seq limit lim + 1), cut as (select * from page order by server_seq limit lim)
  select coalesce(jsonb_agg(j order by server_seq), '[]'::jsonb), max(server_seq), (select count(*) from page) > lim
    into items, cursor_max, more from cut;
  return jsonb_build_object('items', items, 'cursor', cursor_max, 'more', more);
end $$;

