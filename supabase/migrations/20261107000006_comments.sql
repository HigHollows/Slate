-- Commentaires partagés : fils ancrés à une page et messages, synchronisés dans le flux « structure ».
-- Écriture : éditeurs ; modifier ou supprimer un message : son auteur ou un administrateur ; l'étiquette d'auteur est
-- fixée par le serveur d'après l'adresse du jeton (jamais fournie par le client).
create table public.comment_threads (
  id             uuid primary key,
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  node_id        uuid not null references public.nodes (id) on delete cascade,
  quote          text not null check (char_length(quote) <= 400),
  created_by     uuid not null default auth.uid() references auth.users (id) on delete restrict,
  author_label   text check (author_label is null or char_length(author_label) <= 320),
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  resolved_label text check (resolved_label is null or char_length(resolved_label) <= 320),
  deleted_at     timestamptz,
  clocks         jsonb not null default '{}'::jsonb,
  server_seq     bigint not null default nextval('public.sync_seq')
);
create index comment_threads_sync on public.comment_threads (workspace_id, server_seq);
create index comment_threads_node on public.comment_threads (node_id);

create table public.comments (
  id           uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  thread_id    uuid not null references public.comment_threads (id) on delete cascade,
  body         text not null check (char_length(body) between 1 and 5000),
  author_id    uuid not null default auth.uid() references auth.users (id) on delete restrict,
  author_label text check (author_label is null or char_length(author_label) <= 320),
  created_at   timestamptz not null default now(),
  edited_at    timestamptz,
  deleted_at   timestamptz,
  clocks       jsonb not null default '{}'::jsonb,
  server_seq   bigint not null default nextval('public.sync_seq')
);
create index comments_sync on public.comments (workspace_id, server_seq);
create index comments_thread on public.comments (thread_id);

create trigger comment_threads_bump before insert or update on public.comment_threads for each row execute function private.bump_node_seq();
create trigger comments_bump before insert or update on public.comments for each row execute function private.bump_node_seq();

-- Un message est toujours renvoyé APRÈS son fil dans le flux ordonné (un client qui démarre de zéro n'a ainsi jamais un
-- message sans son fil) : toute modification d'un fil « touche » ses messages.
create function private.touch_thread_comments() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.comments set thread_id = thread_id where thread_id = new.id;
  return null;
end $$;
create trigger comment_threads_touch after update on public.comment_threads for each row execute function private.touch_thread_comments();

-- Même espace, même page : les messages ne peuvent pas changer de fil ni d'espace.
create function private.comment_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.workspace_id <> old.workspace_id or new.thread_id <> old.thread_id) then
    raise exception 'workspace_id and thread_id are immutable' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and not exists (select 1 from public.comment_threads t where t.id = new.thread_id and t.workspace_id = new.workspace_id) then
    raise exception 'thread must belong to the same workspace' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger comments_guard before insert or update on public.comments for each row execute function private.comment_guard();
create function private.thread_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (new.workspace_id <> old.workspace_id or new.node_id <> old.node_id) then
    raise exception 'workspace_id and node_id are immutable' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and not exists (select 1 from public.nodes n where n.id = new.node_id and n.workspace_id = new.workspace_id and n.kind = 'page' and n.purged_at is null) then
    raise exception 'thread must be anchored to a page of the same workspace' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger comment_threads_guard before insert or update on public.comment_threads for each row execute function private.thread_guard();

alter table public.comment_threads enable row level security;
alter table public.comments enable row level security;
create policy comment_threads_select on public.comment_threads for select to authenticated using (private.has_role(workspace_id, 'viewer'));
create policy comment_threads_insert on public.comment_threads for insert to authenticated
  with check (private.has_role(workspace_id, 'editor') and created_by = (select auth.uid()));
create policy comment_threads_update on public.comment_threads for update to authenticated
  using (private.has_role(workspace_id, 'editor')) with check (private.has_role(workspace_id, 'editor'));
create policy comments_select on public.comments for select to authenticated using (private.has_role(workspace_id, 'viewer'));
create policy comments_insert on public.comments for insert to authenticated
  with check (private.has_role(workspace_id, 'editor') and author_id = (select auth.uid()));
create policy comments_update on public.comments for update to authenticated
  using (private.has_role(workspace_id, 'editor') and (author_id = (select auth.uid()) or private.has_role(workspace_id, 'admin')))
  with check (private.has_role(workspace_id, 'editor') and (author_id = (select auth.uid()) or private.has_role(workspace_id, 'admin')));
revoke all on public.comment_threads, public.comments from anon;

-- Opérations « thread » / « comment » : champ par champ, horloge (ms, appareil), comme les autres entités.
create function private.apply_comment_op(p_workspace uuid, p_entity text, p_id uuid, p_fields jsonb, p_ms bigint, p_dev text)
returns text
language plpgsql security invoker set search_path = '' as $$
declare
  t public.comment_threads; c public.comments; f text; me uuid := (select auth.uid());
  label text := left((select auth.jwt() ->> 'email'), 320);
  new_clocks jsonb; any_applied boolean := false;
begin
  if p_entity = 'thread' then
    select * into t from public.comment_threads where id = p_id and workspace_id = p_workspace for update;
    if not found then
      if exists (select 1 from public.comment_threads where id = p_id) then raise exception 'foreign_thread'; end if;
      if not (p_fields ? 'node_id' and p_fields ? 'quote') then raise exception 'incomplete_create'; end if;
      if not exists (select 1 from public.nodes n where n.id = (p_fields ->> 'node_id')::uuid and n.workspace_id = p_workspace and n.kind = 'page') then
        raise exception 'node_missing';
      end if;
      insert into public.comment_threads (id, workspace_id, node_id, quote, author_label, created_at, resolved_at, resolved_label, deleted_at, clocks)
      values (p_id, p_workspace, (p_fields ->> 'node_id')::uuid, left(p_fields ->> 'quote', 400), label,
              coalesce((p_fields ->> 'created_at')::timestamptz, now()), (p_fields ->> 'resolved_at')::timestamptz,
              case when (p_fields ->> 'resolved_at') is not null then label end, (p_fields ->> 'deleted_at')::timestamptz,
              (select coalesce(jsonb_object_agg(k, jsonb_build_array(p_ms, p_dev)), '{}'::jsonb)
                 from jsonb_object_keys(p_fields) k where k in ('resolved_at', 'deleted_at')));
      return 'applied';
    end if;
    new_clocks := t.clocks;
    for f in select * from jsonb_object_keys(p_fields) loop
      continue when f not in ('resolved_at', 'deleted_at');
      continue when not private.clock_newer(t.clocks -> f, p_ms, p_dev);
      if f = 'deleted_at' then
        if t.created_by <> me and not private.has_role(p_workspace, 'admin') then raise exception 'not_author'; end if;
        t.deleted_at := (p_fields ->> f)::timestamptz;
      else
        t.resolved_at := (p_fields ->> f)::timestamptz;
        t.resolved_label := case when t.resolved_at is not null then label end;
      end if;
      new_clocks := jsonb_set(new_clocks, array[f], jsonb_build_array(p_ms, p_dev));
      any_applied := true;
    end loop;
    if any_applied then
      update public.comment_threads set resolved_at = t.resolved_at, resolved_label = t.resolved_label,
        deleted_at = t.deleted_at, clocks = new_clocks where id = p_id;
    end if;
    return case when any_applied then 'applied' else 'merged' end;
  end if;

  select * into c from public.comments where id = p_id and workspace_id = p_workspace for update;
  if not found then
    if exists (select 1 from public.comments where id = p_id) then raise exception 'foreign_comment'; end if;
    if not (p_fields ? 'thread_id' and p_fields ? 'body') then raise exception 'incomplete_create'; end if;
    if not exists (select 1 from public.comment_threads x where x.id = (p_fields ->> 'thread_id')::uuid and x.workspace_id = p_workspace) then
      raise exception 'thread_missing';
    end if;
    insert into public.comments (id, workspace_id, thread_id, body, author_label, created_at, deleted_at, clocks)
    values (p_id, p_workspace, (p_fields ->> 'thread_id')::uuid, p_fields ->> 'body', label,
            coalesce((p_fields ->> 'created_at')::timestamptz, now()), (p_fields ->> 'deleted_at')::timestamptz,
            (select coalesce(jsonb_object_agg(k, jsonb_build_array(p_ms, p_dev)), '{}'::jsonb)
               from jsonb_object_keys(p_fields) k where k in ('body', 'deleted_at')));
    return 'applied';
  end if;
  if c.author_id <> me and not private.has_role(p_workspace, 'admin') then raise exception 'not_author'; end if;
  new_clocks := c.clocks;
  for f in select * from jsonb_object_keys(p_fields) loop
    continue when f not in ('body', 'deleted_at');
    continue when not private.clock_newer(c.clocks -> f, p_ms, p_dev);
    if f = 'body' then
      c.body := p_fields ->> f;
      c.edited_at := now();
    else
      c.deleted_at := (p_fields ->> f)::timestamptz;
    end if;
    new_clocks := jsonb_set(new_clocks, array[f], jsonb_build_array(p_ms, p_dev));
    any_applied := true;
  end loop;
  if any_applied then
    update public.comments set body = c.body, edited_at = c.edited_at, deleted_at = c.deleted_at, clocks = new_clocks where id = p_id;
  end if;
  return case when any_applied then 'applied' else 'merged' end;
end $$;
revoke execute on function private.apply_comment_op(uuid, text, uuid, jsonb, bigint, text) from public, anon;
grant execute on function private.apply_comment_op(uuid, text, uuid, jsonb, bigint, text) to authenticated;

-- La purge d'une page efface aussi ses fils (et, par cascade, leurs messages).
create or replace function private.purge_node(p_workspace uuid, p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  delete from public.doc_updates where node_id = p_id and workspace_id = p_workspace;
  delete from public.comment_threads where node_id = p_id and workspace_id = p_workspace;
  delete from public.db_rows where workspace_id = p_workspace and (node_id = p_id or database_id = p_id);
  delete from public.db_properties where workspace_id = p_workspace and database_id = p_id;
  delete from public.db_views where workspace_id = p_workspace and database_id = p_id;
  update public.nodes set purged_at = now(), title = '', parent_id = null, version = version + 1
   where id = p_id and workspace_id = p_workspace;
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
      elsif v_entity in ('thread', 'comment') then
        status := private.apply_comment_op(p_workspace, v_entity, v_id, coalesce(op -> 'fields', '{}'::jsonb), v_ms, v_dev);
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

create or replace function public.sync_pull_struct(p_workspace uuid, p_since bigint, p_limit int default 200) returns jsonb
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

