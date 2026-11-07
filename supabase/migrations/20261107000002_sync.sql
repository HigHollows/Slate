-- Synchronisation, première tranche : arborescence (fusion par champ) + contenu des pages (mises à jour Yjs ajoutées).
-- Voir docs/SYNC.md. Toutes les fonctions publiques sont SECURITY INVOKER : la RLS s'applique à chaque lecture/écriture.

create sequence public.sync_seq;
grant usage on sequence public.sync_seq to authenticated;

alter table public.nodes
  add column server_seq bigint not null default nextval('public.sync_seq'),
  add column clocks jsonb not null default '{}'::jsonb;
create index nodes_sync on public.nodes (workspace_id, server_seq);

create function private.bump_node_seq() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.server_seq := nextval('public.sync_seq');
  return new;
end $$;
create trigger nodes_bump_seq before insert or update on public.nodes for each row execute function private.bump_node_seq();

-- Opérations déjà appliquées (idempotence).
create table public.applied_ops (
  op_id        uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  applied_by   uuid not null default auth.uid() references auth.users (id) on delete cascade,
  applied_at   timestamptz not null default now(),
  result       text not null check (result in ('applied', 'merged', 'rejected'))
);
create index applied_ops_ws on public.applied_ops (workspace_id);
alter table public.applied_ops enable row level security;
create policy applied_ops_select on public.applied_ops for select to authenticated
  using (private.has_role(workspace_id, 'viewer'));
create policy applied_ops_insert on public.applied_ops for insert to authenticated
  with check (private.has_role(workspace_id, 'editor') and applied_by = (select auth.uid()));

-- Contenu des pages : journal ajouté seulement (aucune mise à jour ni suppression par les clients).
create table public.doc_updates (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  node_id      uuid not null references public.nodes (id) on delete cascade,
  op_id        uuid not null unique,
  author_id    uuid not null default auth.uid() references auth.users (id) on delete restrict,
  device_id    uuid not null,
  update       bytea not null check (octet_length(update) between 1 and 33554432),
  created_at   timestamptz not null default now()
);
create index doc_updates_ws on public.doc_updates (workspace_id, id);
create index doc_updates_node on public.doc_updates (node_id);
alter table public.doc_updates enable row level security;
create policy doc_updates_select on public.doc_updates for select to authenticated
  using (private.has_role(workspace_id, 'viewer'));
create policy doc_updates_insert on public.doc_updates for insert to authenticated
  with check (
    private.has_role(workspace_id, 'editor')
    and author_id = (select auth.uid())
    and exists (select 1 from public.nodes n where n.id = node_id and n.workspace_id = doc_updates.workspace_id and n.kind = 'page')
  );
revoke all on public.applied_ops, public.doc_updates from anon;

-- Vrai si l'horloge (ms, appareil) est strictement plus récente que celle déjà stockée pour ce champ.
create function private.clock_newer(stored jsonb, ms bigint, device text) returns boolean
language sql immutable set search_path = '' as $$
  select stored is null
      or ms > (stored ->> 0)::bigint
      or (ms = (stored ->> 0)::bigint and device > coalesce(stored ->> 1, ''))
$$;

-- Applique un lot d'opérations. Retourne, pour chaque opération : {op_id, status: applied|merged|duplicate|rejected, reason}.
create function public.sync_push(p_workspace uuid, p_ops jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  op jsonb; results jsonb := '[]'::jsonb;
  v_op uuid; v_entity text; v_id uuid; v_fields jsonb; v_ms bigint; v_dev text;
  n public.nodes; f text; changed boolean; any_applied boolean; status text; reason text;
  new_clocks jsonb; cyc boolean;
begin
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' or jsonb_array_length(p_ops) > 200 then
    raise exception 'invalid batch' using errcode = '22023';
  end if;
  if not private.has_role(p_workspace, 'editor') then
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
      elsif v_entity = 'node' then
        v_fields := coalesce(op -> 'fields', '{}'::jsonb);
        select * into n from public.nodes where id = v_id and workspace_id = p_workspace for update;
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
        if not exists (select 1 from public.nodes where id = v_id and workspace_id = p_workspace and kind = 'page') then
          raise exception 'node_missing';
        end if;
        insert into public.doc_updates (workspace_id, node_id, op_id, device_id, update)
        values (p_workspace, v_id, v_op, v_dev::uuid, decode(op ->> 'update', 'base64'));
      else
        raise exception 'unknown_entity';
      end if;
      if status <> 'duplicate' then
        insert into public.applied_ops (op_id, workspace_id, result) values (v_op, p_workspace, status);
      end if;
    exception
      when insufficient_privilege then raise;
      when others then
        status := 'rejected'; reason := left(sqlerrm, 80);
    end;
    results := results || jsonb_build_object('op_id', op ->> 'op_id', 'status', status, 'reason', reason);
  end loop;
  return results;
end $$;

-- Tout ce qui a changé depuis les curseurs (avec les recouvrements gérés par le client). Pagination par limite.
create function public.sync_pull(p_workspace uuid, p_node_since bigint, p_doc_since bigint, p_limit int default 200)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  lim int := greatest(1, least(coalesce(p_limit, 200), 500));
  dlim int := greatest(1, least(coalesce(p_limit, 200), 25));
  nodes_out jsonb; docs_out jsonb; node_max bigint; doc_max bigint; more_n boolean; more_d boolean;
begin
  if not private.has_role(p_workspace, 'viewer') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  with page as (
    select * from public.nodes where workspace_id = p_workspace and server_seq > coalesce(p_node_since, 0)
    order by server_seq limit lim + 1
  ), cut as (select * from page order by server_seq limit lim)
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'parent_id', parent_id, 'kind', kind, 'title', title,
           'position', position, 'deleted_at', deleted_at, 'created_at', created_at, 'server_seq', server_seq) order by server_seq), '[]'::jsonb),
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

revoke execute on function public.sync_push(uuid, jsonb), public.sync_pull(uuid, bigint, bigint, int) from public, anon;
grant execute on function public.sync_push(uuid, jsonb), public.sync_pull(uuid, bigint, bigint, int) to authenticated;
