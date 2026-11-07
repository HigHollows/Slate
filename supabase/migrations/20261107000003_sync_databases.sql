-- Synchronisation des bases de données : propriétés, vues, lignes (valeurs par cellule). Voir docs/SYNC.md.
-- Même séquence `sync_seq` que les nœuds ; un seul curseur « structure » pour les trois tables (pagination correcte).

create table public.db_properties (
  id           uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  database_id  uuid not null references public.nodes (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 200),
  type         text not null check (type in ('title','text','longtext','number','percent','date','datetime','checkbox',
                 'select','multiselect','status','url','email','phone','relation','formula','id','created_time','last_edited_time')),
  config       jsonb not null default '{}'::jsonb check (octet_length(config::text) <= 65536),
  position     text not null check (char_length(position) between 1 and 255),
  deleted_at   timestamptz,
  clocks       jsonb not null default '{}'::jsonb,
  server_seq   bigint not null default nextval('public.sync_seq')
);
create index db_properties_sync on public.db_properties (workspace_id, server_seq);
create index db_properties_db on public.db_properties (database_id);

create table public.db_views (
  id           uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  database_id  uuid not null references public.nodes (id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 200),
  layout       text not null check (layout in ('table', 'kanban', 'list', 'gallery', 'calendar')),
  config       jsonb not null default '{}'::jsonb check (octet_length(config::text) <= 65536),
  position     text not null check (char_length(position) between 1 and 255),
  deleted_at   timestamptz,
  clocks       jsonb not null default '{}'::jsonb,
  server_seq   bigint not null default nextval('public.sync_seq')
);
create index db_views_sync on public.db_views (workspace_id, server_seq);
create index db_views_db on public.db_views (database_id);

create table public.db_rows (
  node_id      uuid primary key references public.nodes (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  database_id  uuid not null references public.nodes (id) on delete cascade,
  props        jsonb not null default '{}'::jsonb check (octet_length(props::text) <= 1048576),
  clocks       jsonb not null default '{}'::jsonb,
  server_seq   bigint not null default nextval('public.sync_seq')
);
create index db_rows_sync on public.db_rows (workspace_id, server_seq);
create index db_rows_db on public.db_rows (database_id);

create trigger db_properties_bump before insert or update on public.db_properties for each row execute function private.bump_node_seq();
create trigger db_views_bump before insert or update on public.db_views for each row execute function private.bump_node_seq();
create trigger db_rows_bump before insert or update on public.db_rows for each row execute function private.bump_node_seq();

-- La base visée doit être un nœud « database » du même espace ; une ligne est un enfant direct de sa base.
create function private.db_child_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.workspace_id <> old.workspace_id or new.database_id <> old.database_id) then
    raise exception 'workspace_id and database_id are immutable' using errcode = '42501';
  end if;
  if not exists (select 1 from public.nodes d where d.id = new.database_id and d.workspace_id = new.workspace_id and d.kind = 'database') then
    raise exception 'database must be a database node of the same workspace' using errcode = '23514';
  end if;
  return new;
end $$;
create function private.db_row_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.workspace_id <> old.workspace_id or new.database_id <> old.database_id) then
    raise exception 'workspace_id and database_id are immutable' using errcode = '42501';
  end if;
  if not exists (select 1 from public.nodes d where d.id = new.database_id and d.workspace_id = new.workspace_id and d.kind = 'database') then
    raise exception 'database must be a database node of the same workspace' using errcode = '23514';
  end if;
  if not exists (select 1 from public.nodes n where n.id = new.node_id and n.workspace_id = new.workspace_id and n.parent_id = new.database_id) then
    raise exception 'row must be a direct child of its database' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger db_properties_guard before insert or update on public.db_properties for each row execute function private.db_child_guard();
create trigger db_views_guard before insert or update on public.db_views for each row execute function private.db_child_guard();
create trigger db_rows_guard before insert or update on public.db_rows for each row execute function private.db_row_guard();

alter table public.db_properties enable row level security;
alter table public.db_views enable row level security;
alter table public.db_rows enable row level security;
create policy db_properties_select on public.db_properties for select to authenticated using (private.has_role(workspace_id, 'viewer'));
create policy db_properties_insert on public.db_properties for insert to authenticated with check (private.has_role(workspace_id, 'editor'));
create policy db_properties_update on public.db_properties for update to authenticated using (private.has_role(workspace_id, 'editor')) with check (private.has_role(workspace_id, 'editor'));
create policy db_properties_delete on public.db_properties for delete to authenticated using (private.has_role(workspace_id, 'admin'));
create policy db_views_select on public.db_views for select to authenticated using (private.has_role(workspace_id, 'viewer'));
create policy db_views_insert on public.db_views for insert to authenticated with check (private.has_role(workspace_id, 'editor'));
create policy db_views_update on public.db_views for update to authenticated using (private.has_role(workspace_id, 'editor')) with check (private.has_role(workspace_id, 'editor'));
create policy db_views_delete on public.db_views for delete to authenticated using (private.has_role(workspace_id, 'admin'));
create policy db_rows_select on public.db_rows for select to authenticated using (private.has_role(workspace_id, 'viewer'));
create policy db_rows_insert on public.db_rows for insert to authenticated with check (private.has_role(workspace_id, 'editor'));
create policy db_rows_update on public.db_rows for update to authenticated using (private.has_role(workspace_id, 'editor')) with check (private.has_role(workspace_id, 'editor'));
create policy db_rows_delete on public.db_rows for delete to authenticated using (private.has_role(workspace_id, 'admin'));
revoke all on public.db_properties, public.db_views, public.db_rows from anon;

-- Opérations « prop » / « view » / « row » : fusion par champ (propriétés, vues) ou par cellule (lignes), horloge (ms, appareil).
create function private.apply_struct_op(p_workspace uuid, p_entity text, p_id uuid, p_fields jsonb, p_ms bigint, p_dev text)
returns text
language plpgsql security invoker set search_path = '' as $$
declare
  f text; v jsonb; any_applied boolean := false; v_clocks jsonb; v_props jsonb; db uuid; v_exists boolean;
  allowed text[]; vals jsonb := '{}'::jsonb;
begin
  db := (p_fields ->> 'database_id')::uuid;
  if p_entity = 'row' then
    select r.props, r.clocks into v_props, v_clocks from public.db_rows r where r.node_id = p_id and r.workspace_id = p_workspace for update;
    if not found then
      if exists (select 1 from public.db_rows r where r.node_id = p_id) then raise exception 'foreign_row'; end if;
      if db is null then raise exception 'incomplete_create'; end if;
      if not exists (select 1 from public.nodes n where n.id = p_id and n.workspace_id = p_workspace and n.parent_id = db) then
        raise exception 'node_missing';
      end if;
      insert into public.db_rows (node_id, workspace_id, database_id) values (p_id, p_workspace, db);
      v_props := '{}'::jsonb; v_clocks := '{}'::jsonb;
    end if;
    for f, v in select e.key, e.value from jsonb_each(coalesce(p_fields -> 'cells', '{}'::jsonb)) e loop
      if f !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'bad_cell_key'; end if;
      continue when not private.clock_newer(v_clocks -> ('c:' || f), p_ms, p_dev);
      if v is null or jsonb_typeof(v) = 'null' then v_props := v_props - f; else v_props := jsonb_set(v_props, array[f], v); end if;
      v_clocks := jsonb_set(v_clocks, array['c:' || f], jsonb_build_array(p_ms, p_dev));
      any_applied := true;
    end loop;
    if any_applied then
      update public.db_rows set props = v_props, clocks = v_clocks where node_id = p_id;
    end if;
    return case when any_applied then 'applied' else 'merged' end;
  end if;

  allowed := case p_entity when 'prop' then array['name','type','config','position','deleted_at']
                           else array['name','layout','config','position','deleted_at'] end;
  if p_entity = 'prop' then
    select x.clocks into v_clocks from public.db_properties x where x.id = p_id and x.workspace_id = p_workspace for update;
  else
    select x.clocks into v_clocks from public.db_views x where x.id = p_id and x.workspace_id = p_workspace for update;
  end if;
  v_exists := found;
  if not v_exists then
    if (p_entity = 'prop' and exists (select 1 from public.db_properties x where x.id = p_id))
       or (p_entity = 'view' and exists (select 1 from public.db_views x where x.id = p_id)) then
      raise exception 'foreign_object';
    end if;
    if db is null or not (p_fields ? 'name' and p_fields ? 'position' and p_fields ? (case p_entity when 'prop' then 'type' else 'layout' end)) then
      raise exception 'incomplete_create';
    end if;
    if not exists (select 1 from public.nodes d where d.id = db and d.workspace_id = p_workspace and d.kind = 'database') then
      raise exception 'node_missing';
    end if;
    v_clocks := (select coalesce(jsonb_object_agg(k, jsonb_build_array(p_ms, p_dev)), '{}'::jsonb)
                 from jsonb_object_keys(p_fields) k where k = any (allowed));
    if p_entity = 'prop' then
      insert into public.db_properties (id, workspace_id, database_id, name, type, config, position, deleted_at, clocks)
      values (p_id, p_workspace, db, p_fields ->> 'name', p_fields ->> 'type', coalesce(p_fields -> 'config', '{}'::jsonb),
              p_fields ->> 'position', (p_fields ->> 'deleted_at')::timestamptz, v_clocks);
    else
      insert into public.db_views (id, workspace_id, database_id, name, layout, config, position, deleted_at, clocks)
      values (p_id, p_workspace, db, p_fields ->> 'name', p_fields ->> 'layout', coalesce(p_fields -> 'config', '{}'::jsonb),
              p_fields ->> 'position', (p_fields ->> 'deleted_at')::timestamptz, v_clocks);
    end if;
    return 'applied';
  end if;
  for f in select k from jsonb_object_keys(p_fields) k loop
    continue when not (f = any (allowed));
    continue when not private.clock_newer(v_clocks -> f, p_ms, p_dev);
    vals := vals || jsonb_build_object(f, p_fields -> f);
    v_clocks := jsonb_set(v_clocks, array[f], jsonb_build_array(p_ms, p_dev));
    any_applied := true;
  end loop;
  if not any_applied then return 'merged'; end if;
  if p_entity = 'prop' then
    update public.db_properties x set
      name = coalesce(vals ->> 'name', x.name), type = coalesce(vals ->> 'type', x.type),
      config = case when vals ? 'config' then coalesce(vals -> 'config', '{}'::jsonb) else x.config end,
      position = coalesce(vals ->> 'position', x.position),
      deleted_at = case when vals ? 'deleted_at' then (vals ->> 'deleted_at')::timestamptz else x.deleted_at end,
      clocks = v_clocks where x.id = p_id;
  else
    update public.db_views x set
      name = coalesce(vals ->> 'name', x.name), layout = coalesce(vals ->> 'layout', x.layout),
      config = case when vals ? 'config' then coalesce(vals -> 'config', '{}'::jsonb) else x.config end,
      position = coalesce(vals ->> 'position', x.position),
      deleted_at = case when vals ? 'deleted_at' then (vals ->> 'deleted_at')::timestamptz else x.deleted_at end,
      clocks = v_clocks where x.id = p_id;
  end if;
  return 'applied';
end $$;
revoke execute on function private.apply_struct_op(uuid, text, uuid, jsonb, bigint, text) from public, anon;
grant execute on function private.apply_struct_op(uuid, text, uuid, jsonb, bigint, text) to authenticated;

-- sync_push : même fonction que la migration 2, avec les trois nouvelles entités.
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

-- Lecture « structure » : propriétés, vues et lignes dans UN flux ordonné par séquence (un seul curseur).
create function public.sync_pull_struct(p_workspace uuid, p_since bigint, p_limit int default 200) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  lim int := greatest(1, least(coalesce(p_limit, 200), 500));
  items jsonb; cursor_max bigint; more boolean;
begin
  if not private.has_role(p_workspace, 'viewer') then
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
  ), page as (select * from u order by server_seq limit lim + 1), cut as (select * from page order by server_seq limit lim)
  select coalesce(jsonb_agg(j order by server_seq), '[]'::jsonb), max(server_seq), (select count(*) from page) > lim
    into items, cursor_max, more from cut;
  return jsonb_build_object('items', items, 'cursor', cursor_max, 'more', more);
end $$;

revoke execute on function public.sync_pull_struct(uuid, bigint, int) from public, anon;
grant execute on function public.sync_pull_struct(uuid, bigint, int) to authenticated;
