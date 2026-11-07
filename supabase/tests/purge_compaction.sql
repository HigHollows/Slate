-- Tests de la migration 5 (suppression définitive propagée, compaction). Même convention que rls_core.sql :
-- résultat attendu = ERROR "TESTS_OK: <n> assertions" (tout est annulé par cette exception volontaire).
do $outer$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  w uuid := gen_random_uuid(); w2 uuid := gen_random_uuid();
  root uuid := gen_random_uuid(); pg uuid := gen_random_uuid(); sub uuid := gen_random_uuid(); other uuid := gen_random_uuid();
  dev1 uuid := gen_random_uuid(); dev2 uuid := gen_random_uuid();
  total int := 0; r jsonb; q text;
begin
  create function pg_temp.chk(cond boolean, msg text) returns void language plpgsql as $f$
  begin if cond is not true then raise exception 'ECHEC: %', msg; end if; end $f$;
  create function pg_temp.call(u uuid, q text) returns jsonb language plpgsql as $f$
  declare res jsonb;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    set local role authenticated;
    execute q into res;
    reset role;
    return res;
  end $f$;
  create function pg_temp.fails(u uuid, q text, state text default '42501') returns boolean language plpgsql as $f$
  declare ok boolean;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      execute q;
      ok := false;
    exception when others then
      ok := (sqlstate = state);
    end;
    reset role;
    return ok;
  end $f$;
  create function pg_temp.st(res jsonb, i int) returns text language sql as $f$ select res -> i ->> 'status' $f$;
  create function pg_temp.push(u uuid, ws uuid, ops jsonb) returns jsonb language sql as $f$
    select pg_temp.call(u, format('select public.sync_push(%L, %L::jsonb)', ws, ops::text)) $f$;
  create function pg_temp.node_op(opid uuid, id uuid, fields jsonb, ms bigint, dev text) returns jsonb language sql as $f$
    select jsonb_build_object('op_id', opid, 'entity', 'node', 'entity_id', id, 'fields', fields, 'clock', jsonb_build_object('ms', ms, 'device', dev)) $f$;
  create function pg_temp.doc_op(opid uuid, id uuid, upd text, ms bigint, dev uuid) returns jsonb language sql as $f$
    select jsonb_build_object('op_id', opid, 'entity', 'doc', 'entity_id', id, 'update', upd, 'clock', jsonb_build_object('ms', ms, 'device', dev::text)) $f$;

  insert into auth.users (id, email) values (a, 'a@test.invalid'), (b, 'b@test.invalid'), (c, 'c@test.invalid');
  perform pg_temp.call(a, format('select to_jsonb(1) from (select 1 where false) x'));
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.workspaces (id, name, owner_id) values (w, 'Perso', a), (w2, 'Autre', a);
  reset role;
  insert into public.workspace_members (workspace_id, user_id, role) values (w, c, 'viewer');

  -- Un dossier, une page, une base ; la page est mise à la corbeille puis purgée.
  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.node_op(gen_random_uuid(), root, '{"kind":"folder","title":"Racine","position":"V0000000","parent_id":null}', 100, dev1::text),
    pg_temp.node_op(gen_random_uuid(), pg, jsonb_build_object('kind','page','title','Secret','position','V0000001','parent_id',root), 101, dev1::text),
    pg_temp.node_op(gen_random_uuid(), other, jsonb_build_object('kind','page','title','Autre','position','V0000002','parent_id',root), 102, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and pg_temp.st(r,1)='applied', 'création'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.doc_op(gen_random_uuid(), pg, encode('\x0102'::bytea, 'base64'), 110, dev1)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied', 'contenu ajouté'); total := total + 1;

  -- Purge refusée hors corbeille.
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg, '{"purged_at":"2026-01-01T00:00:00Z"}', 200, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='rejected' and r -> 0 ->> 'reason' like '%not_in_trash%', 'purge refusée hors corbeille'); total := total + 1;
  perform pg_temp.chk((select purged_at from public.nodes where id = pg) is null and (select count(*) from public.doc_updates where node_id = pg) = 1, 'rien n''a changé'); total := total + 1;

  -- Lecteur : ne peut pas purger (même à la corbeille).
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg, '{"deleted_at":"2026-01-01T00:00:00Z"}', 210, dev1::text)));
  perform pg_temp.chk(pg_temp.fails(c, format('select public.sync_push(%L, %L::jsonb)', w,
    jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg, '{"purged_at":"2026-01-01T00:00:00Z"}', 220, dev1::text))::text)), 'lecteur : purge refusée'); total := total + 1;

  -- Purge depuis la corbeille : contenu effacé, titre vidé, pierre tombale visible au pull.
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg, '{"purged_at":"2026-01-01T00:00:00Z"}', 230, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied', 'purge appliquée'); total := total + 1;
  perform pg_temp.chk((select purged_at from public.nodes where id = pg) is not null, 'pierre tombale'); total := total + 1;
  perform pg_temp.chk((select title from public.nodes where id = pg) = '', 'titre effacé'); total := total + 1;
  perform pg_temp.chk((select count(*) from public.doc_updates where node_id = pg) = 0, 'contenu effacé'); total := total + 1;
  r := pg_temp.call(c, format('select public.sync_pull(%L, 0, 0, 100)', w));
  perform pg_temp.chk(exists (select 1 from jsonb_array_elements(r -> 'nodes') x where x ->> 'id' = pg::text and x ->> 'purged_at' is not null), 'le pull annonce la purge');
  total := total + 1;
  -- Rejeu et purge d'un nœud inconnu : sans effet.
  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.node_op(gen_random_uuid(), pg, '{"purged_at":"2026-01-01T00:00:00Z"}', 240, dev1::text),
    pg_temp.node_op(gen_random_uuid(), gen_random_uuid(), '{"purged_at":"2026-01-01T00:00:00Z"}', 241, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='merged' and pg_temp.st(r,1)='merged', 'purge répétée / inconnue : sans effet'); total := total + 1;
  -- Un nœud purgé ne ressuscite pas et n''accepte plus de contenu.
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg, '{"title":"Retour","deleted_at":null}', 900, dev2::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='rejected' and (select purged_at from public.nodes where id = pg) is not null, 'pas de résurrection'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.doc_op(gen_random_uuid(), pg, encode('\x03'::bytea, 'base64'), 901, dev2)));
  perform pg_temp.chk(pg_temp.st(r,0)='rejected', 'pas de contenu sur un nœud purgé'); total := total + 1;

  -- Compaction : 3 mises à jour de « Autre » remplacées par 1.
  declare ids bigint[]; newid bigint; ndev uuid := gen_random_uuid();
  begin
    r := pg_temp.push(a, w, jsonb_build_array(
      pg_temp.doc_op(gen_random_uuid(), other, encode('\x0a'::bytea, 'base64'), 300, dev1),
      pg_temp.doc_op(gen_random_uuid(), other, encode('\x0b'::bytea, 'base64'), 301, dev1),
      pg_temp.doc_op(gen_random_uuid(), other, encode('\x0c'::bytea, 'base64'), 302, dev1)));
    select array_agg(id order by id) into ids from public.doc_updates where node_id = other;
    perform pg_temp.chk(cardinality(ids) = 3, '3 mises à jour'); total := total + 1;
    r := pg_temp.call(a, format('select public.sync_doc_stats(%L, 2)', w));
    perform pg_temp.chk(r -> 0 ->> 'node_id' = other::text and (r -> 0 ->> 'count')::int = 3, 'statistiques : la page est candidate'); total := total + 1;
    perform pg_temp.chk(pg_temp.fails(c, format('select public.sync_compact_doc(%L, %L, %L::bigint[], %L, %L, %L::bytea)', w, other, ids, gen_random_uuid(), ndev, '\x0d')), 'lecteur : compaction refusée'); total := total + 1;
    perform pg_temp.chk(pg_temp.fails(a, format('select public.sync_compact_doc(%L, %L, %L::bigint[], %L, %L, %L::bytea)', w, other, ids || 999999999::bigint, gen_random_uuid(), ndev, '\x0d'), '22023'), 'identifiants inconnus : refusé'); total := total + 1;
    perform pg_temp.chk(pg_temp.fails(a, format('select public.sync_compact_doc(%L, %L, %L::bigint[], %L, %L, %L::bytea)', w, other, ids[1:1], gen_random_uuid(), ndev, '\x0d'), '22023'), 'moins de 2 identifiants : refusé'); total := total + 1;
    perform pg_temp.chk((select count(*) from public.doc_updates where node_id = other) = 3, 'rien supprimé par les refus'); total := total + 1;
    r := pg_temp.call(a, format('select to_jsonb(public.sync_compact_doc(%L, %L, %L::bigint[], %L, %L, %L::bytea))', w, other, ids, gen_random_uuid(), ndev, '\x0d0e'));
    newid := (r #>> '{}')::bigint;
    perform pg_temp.chk((select count(*) from public.doc_updates where node_id = other) = 1 and newid > ids[3], 'compaction : une seule ligne, plus récente'); total := total + 1;
    perform pg_temp.chk((select author_id from public.doc_updates where id = newid) = a, 'auteur = appelant'); total := total + 1;
    r := pg_temp.call(c, format('select public.sync_pull_node_docs(%L, %L, 10)', w, other));
    perform pg_temp.chk(jsonb_array_length(r) = 1, 'le lecteur voit l''état compacté'); total := total + 1;
    -- Un autre espace ne peut pas compacter la page de w.
    perform pg_temp.chk(pg_temp.fails(a, format('select public.sync_compact_doc(%L, %L, %L::bigint[], %L, %L, %L::bytea)', w2, other, array[newid, newid+1], gen_random_uuid(), ndev, '\x0d'), '22023'), 'espace différent : refusé'); total := total + 1;
  end;
  begin
    set local role anon;
    perform public.sync_doc_stats(w, 2);
    raise exception 'ECHEC: anon exécute sync_doc_stats';
  exception when insufficient_privilege then null;
  end;
  reset role;
  total := total + 1;

  raise exception 'TESTS_OK: % assertions', total;
end
$outer$;
