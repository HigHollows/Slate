-- Suppression définitive propagée et compaction des journaux de documents. Voir docs/SYNC.md.
alter table public.nodes add column purged_at timestamptz;

-- Efface le contenu d'un nœud de la corbeille (les clients n'ont pas le droit de supprimer ces lignes) et garde une pierre
-- tombale. L'appelant (sync_push) a déjà vérifié le rôle « éditeur » et que le nœud est dans la corbeille.
create function private.purge_node(p_workspace uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.doc_updates where node_id = p_id and workspace_id = p_workspace;
  delete from public.db_rows where workspace_id = p_workspace and (node_id = p_id or database_id = p_id);
  delete from public.db_properties where workspace_id = p_workspace and database_id = p_id;
  delete from public.db_views where workspace_id = p_workspace and database_id = p_id;
  update public.nodes set purged_at = now(), title = '', parent_id = null, version = version + 1
   where id = p_id and workspace_id = p_workspace;
end $$;
revoke execute on function private.purge_node(uuid, uuid) from public, anon;
grant execute on function private.purge_node(uuid, uuid) to authenticated;

-- Une base purgée n'accepte plus de propriétés, vues ou lignes.
create or replace function private.db_child_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.workspace_id <> old.workspace_id or new.database_id <> old.database_id) then
    raise exception 'workspace_id and database_id are immutable' using errcode = '42501';
  end if;
  if not exists (select 1 from public.nodes d where d.id = new.database_id and d.workspace_id = new.workspace_id and d.kind = 'database' and d.purged_at is null) then
    raise exception 'database must be a database node of the same workspace' using errcode = '23514';
  end if;
  return new;
end $$;
create or replace function private.db_row_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.workspace_id <> old.workspace_id or new.database_id <> old.database_id) then
    raise exception 'workspace_id and database_id are immutable' using errcode = '42501';
  end if;
  if not exists (select 1 from public.nodes d where d.id = new.database_id and d.workspace_id = new.workspace_id and d.kind = 'database' and d.purged_at is null) then
    raise exception 'database must be a database node of the same workspace' using errcode = '23514';
  end if;
  if not exists (select 1 from public.nodes n where n.id = new.node_id and n.workspace_id = new.workspace_id and n.parent_id = new.database_id) then
    raise exception 'row must be a direct child of its database' using errcode = '23514';
  end if;
  return new;
end $$;

create or replace function public.sync_push(p_workspace uuid, p_ops jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  op jsonb; results jsonb := '[]'::jsonb;
  v_op uuid; v_entity text; v_id uuid; v_fields jsonb; v_ms bigint; v_dev text;
  n public.nodes; f text; any_applied boolean; status text; reason text;
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
      elsif v_entity = 'node' and (op -> 'fields') ? 'purged_at' then
        -- Suppression définitive : seulement depuis la corbeille ; le contenu est effacé, une pierre tombale reste
        -- pour que les autres appareils suppriment aussi leur copie.
        select * into n from public.nodes where id = v_id and workspace_id = p_workspace for update;
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


create or replace function public.sync_pull(p_workspace uuid, p_node_since bigint, p_doc_since bigint, p_limit int default 200)
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


-- Compaction : le client remplace des mises à jour déjà fusionnées par leur état fusionné. Le journal reste en ajout seul pour
-- les clients ; cette fonction (SECURITY DEFINER, appelable par `authenticated`, vérifie elle-même le rôle) est la seule
-- à supprimer des lignes, uniquement celles dont le client donne la liste exacte, et seulement si le même nombre est trouvé.
create function public.sync_compact_doc(p_workspace uuid, p_node uuid, p_ids bigint[], p_op uuid, p_device uuid, p_state bytea)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_found int; v_new bigint;
begin
  if (select auth.uid()) is null or not private.has_role(p_workspace, 'editor') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) < 2 or cardinality(p_ids) > 5000 or p_state is null
     or octet_length(p_state) not between 1 and 33554432 then
    raise exception 'invalid compaction' using errcode = '22023';
  end if;
  if not exists (select 1 from public.nodes n where n.id = p_node and n.workspace_id = p_workspace and n.kind = 'page' and n.purged_at is null) then
    raise exception 'node_missing' using errcode = '22023';
  end if;
  select count(*) into v_found from public.doc_updates where id = any (p_ids) and node_id = p_node and workspace_id = p_workspace;
  if v_found <> cardinality(p_ids) then
    raise exception 'ids mismatch' using errcode = '22023';
  end if;
  insert into public.doc_updates (workspace_id, node_id, op_id, author_id, device_id, update)
  values (p_workspace, p_node, p_op, (select auth.uid()), p_device, p_state) returning id into v_new;
  delete from public.doc_updates where id = any (p_ids) and node_id = p_node and workspace_id = p_workspace;
  return v_new;
end $$;

-- Journaux volumineux d'un espace (candidats à la compaction), puis toutes les mises à jour d'une page.
create function public.sync_doc_stats(p_workspace uuid, p_min_count int default 100)
returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('node_id', node_id, 'count', c, 'bytes', b)), '[]'::jsonb)
  from (select node_id, count(*) c, sum(octet_length(update)) b from public.doc_updates
        where workspace_id = p_workspace and private.has_role(p_workspace, 'viewer')
        group by node_id having count(*) >= greatest(2, p_min_count) order by count(*) desc limit 20) s
$$;
create function public.sync_pull_node_docs(p_workspace uuid, p_node uuid, p_limit int default 500)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
begin
  if not private.has_role(p_workspace, 'viewer') then raise exception 'forbidden' using errcode = '42501'; end if;
  return (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'update', encode(update, 'base64')) order by id), '[]'::jsonb)
          from (select id, update from public.doc_updates where workspace_id = p_workspace and node_id = p_node
                order by id limit greatest(2, least(coalesce(p_limit, 500), 1000))) t);
end $$;

revoke execute on function public.sync_compact_doc(uuid, uuid, bigint[], uuid, uuid, bytea), public.sync_doc_stats(uuid, int),
  public.sync_pull_node_docs(uuid, uuid, int) from public, anon;
grant execute on function public.sync_compact_doc(uuid, uuid, bigint[], uuid, uuid, bytea), public.sync_doc_stats(uuid, int),
  public.sync_pull_node_docs(uuid, uuid, int) to authenticated;
