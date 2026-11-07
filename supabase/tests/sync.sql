-- Tests de la migration 2 (synchronisation). Même convention que rls_core.sql :
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

  -- Création d'un dossier, d'une page enfant et d'une sous-page, dans l'ordre.
  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.node_op(gen_random_uuid(), root, '{"kind":"folder","title":"Racine","position":"V0000000","parent_id":null}', 100, dev1::text),
    pg_temp.node_op(gen_random_uuid(), pg, jsonb_build_object('kind','page','title','Page','position','V0000001','parent_id',root), 101, dev1::text),
    pg_temp.node_op(gen_random_uuid(), sub, jsonb_build_object('kind','page','title','Sous','position','V0000002','parent_id',pg), 102, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and pg_temp.st(r,1)='applied' and pg_temp.st(r,2)='applied', 'création dans l''ordre'); total := total + 1;
  perform pg_temp.chk((select count(*) from public.nodes where workspace_id = w) = 3, '3 nœuds créés'); total := total + 1;
  perform pg_temp.chk((select created_by from public.nodes where id = pg) = a, 'created_by = utilisateur'); total := total + 1;

  -- Idempotence : le même lot rejoué ne change rien.
  declare opid uuid := gen_random_uuid(); v1 bigint; v2 bigint;
  begin
    r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(opid, pg, '{"title":"Titre 1"}', 200, dev1::text)));
    perform pg_temp.chk(pg_temp.st(r,0)='applied', 'titre appliqué'); total := total + 1;
    select version into v1 from public.nodes where id = pg;
    r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(opid, pg, '{"title":"Titre 1"}', 200, dev1::text)));
    select version into v2 from public.nodes where id = pg;
    perform pg_temp.chk(pg_temp.st(r,0)='duplicate' and v1 = v2, 'rejeu = duplicate, sans effet'); total := total + 1;
  end;

  -- Dernière écriture gagne PAR CHAMP : ancienne ignorée, plus récente appliquée.
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg, '{"title":"Ancien"}', 150, dev2::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='merged' and (select title from public.nodes where id = pg) = 'Titre 1', 'modification plus ancienne ignorée'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg, '{"title":"Récent"}', 300, dev2::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and (select title from public.nodes where id = pg) = 'Récent', 'modification plus récente appliquée'); total := total + 1;
  -- Égalité d'horloge : le plus grand identifiant d'appareil gagne (départage déterministe).
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg, '{"title":"Egal-z"}', 300, 'zzz')));
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg, '{"title":"Egal-a"}', 300, 'aaa')));
  perform pg_temp.chk((select title from public.nodes where id = pg) = 'Egal-z', 'égalité : départage par appareil'); total := total + 1;
  -- Deux champs différents modifiés « en même temps » par deux appareils : aucun n'écrase l'autre.
  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.node_op(gen_random_uuid(), sub, '{"title":"T-dev1"}', 500, dev1::text),
    pg_temp.node_op(gen_random_uuid(), sub, '{"position":"V0000009"}', 400, dev2::text)));
  perform pg_temp.chk((select title from public.nodes where id = sub) = 'T-dev1' and (select position from public.nodes where id = sub) = 'V0000009', 'champs indépendants fusionnés'); total := total + 1;

  -- Corbeille (tombstone) et restauration.
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), sub, '{"deleted_at":"2026-01-01T00:00:00Z"}', 600, dev1::text)));
  perform pg_temp.chk((select deleted_at from public.nodes where id = sub) is not null, 'tombstone appliqué'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), sub, '{"deleted_at":null}', 700, dev1::text)));
  perform pg_temp.chk((select deleted_at from public.nodes where id = sub) is null, 'restauration appliquée'); total := total + 1;

  -- Refus motivés : parent inconnu, cycle, nœud d'un autre espace, création incomplète.
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), gen_random_uuid(), jsonb_build_object('kind','page','position','V1','parent_id',gen_random_uuid()), 800, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='rejected' and r -> 0 ->> 'reason' like '%parent_missing%', 'parent inconnu refusé'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), root, jsonb_build_object('parent_id', sub), 900, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='rejected' and r -> 0 ->> 'reason' like '%cycle%', 'cycle refusé'); total := total + 1;
  perform pg_temp.chk((select parent_id from public.nodes where id = root) is null, 'le cycle n''a rien modifié'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), gen_random_uuid(), '{"title":"sans type"}', 910, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='rejected', 'création incomplète refusée'); total := total + 1;
  r := pg_temp.push(a, w2, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), other, '{"kind":"page","position":"V5","parent_id":null}', 920, dev1::text)));
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), other, '{"title":"vol"}', 930, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='rejected' and r -> 0 ->> 'reason' like '%foreign_node%', 'nœud d''un autre espace refusé'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg, jsonb_build_object('kind','folder'), 940, dev1::text)));
  perform pg_temp.chk((select kind from public.nodes where id = pg) = 'page', 'le type ne change jamais après création'); total := total + 1;
  -- Un refus n'empêche pas les opérations suivantes du lot.
  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.node_op(gen_random_uuid(), gen_random_uuid(), '{"title":"x"}', 1, dev1::text),
    pg_temp.node_op(gen_random_uuid(), pg, '{"title":"Après refus"}', 5000, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='rejected' and pg_temp.st(r,1)='applied', 'un refus n''arrête pas le lot'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('select public.sync_push(%L, %L::jsonb)', w, '{"pas":"un tableau"}'), '22023'), 'lot invalide refusé'); total := total + 1;

  -- Contenu : mise à jour Yjs ajoutée pour une page, refusée pour un dossier, idempotente.
  declare d1 uuid := gen_random_uuid();
  begin
    r := pg_temp.push(a, w, jsonb_build_array(pg_temp.doc_op(d1, pg, encode('\x0102030405'::bytea, 'base64'), 1, dev1)));
    perform pg_temp.chk(pg_temp.st(r,0)='applied' and (select count(*) from public.doc_updates where node_id = pg) = 1, 'mise à jour de contenu ajoutée'); total := total + 1;
    r := pg_temp.push(a, w, jsonb_build_array(pg_temp.doc_op(d1, pg, encode('\x0102030405'::bytea, 'base64'), 1, dev1)));
    perform pg_temp.chk(pg_temp.st(r,0)='duplicate' and (select count(*) from public.doc_updates where node_id = pg) = 1, 'rejeu de contenu = duplicate'); total := total + 1;
    r := pg_temp.push(a, w, jsonb_build_array(pg_temp.doc_op(gen_random_uuid(), root, encode('\x01'::bytea, 'base64'), 1, dev1)));
    perform pg_temp.chk(pg_temp.st(r,0)='rejected', 'contenu d''un dossier refusé'); total := total + 1;
    r := pg_temp.push(a, w, jsonb_build_array(pg_temp.doc_op(gen_random_uuid(), pg, encode('\x0a0b'::bytea, 'base64'), 2, dev2)));
  end;
  perform pg_temp.chk((select count(*) from public.doc_updates where node_id = pg) = 2, 'deux appareils : deux mises à jour conservées'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('update public.doc_updates set update = ''\x00'' where node_id = %L', pg)) or (select count(*) from public.doc_updates where update = '\x00') = 0, 'mise à jour de contenu non modifiable'); total := total + 1;

  -- Lecture par curseurs.
  r := pg_temp.call(a, format('select public.sync_pull(%L, 0, 0, 200)', w));
  perform pg_temp.chk(jsonb_array_length(r -> 'nodes') = 3 and jsonb_array_length(r -> 'docs') = 2, 'pull initial : tout'); total := total + 1;
  perform pg_temp.chk((r ->> 'more_nodes')::boolean = false and (r ->> 'node_cursor')::bigint = (select max(server_seq) from public.nodes where workspace_id = w), 'curseur = dernière séquence'); total := total + 1;
  r := pg_temp.call(a, format('select public.sync_pull(%L, %s, %s, 200)', w, (select max(server_seq) from public.nodes where workspace_id = w), (select max(id) from public.doc_updates)));
  perform pg_temp.chk(jsonb_array_length(r -> 'nodes') = 0 and jsonb_array_length(r -> 'docs') = 0, 'pull à jour : rien'); total := total + 1;
  r := pg_temp.call(a, format('select public.sync_pull(%L, 0, 0, 2)', w));
  perform pg_temp.chk(jsonb_array_length(r -> 'nodes') = 2 and (r ->> 'more_nodes')::boolean, 'pagination des nœuds'); total := total + 1;
  r := pg_temp.call(a, format('select public.sync_pull(%L, %s, 0, 2)', w, r ->> 'node_cursor'));
  perform pg_temp.chk(jsonb_array_length(r -> 'nodes') = 1 and not (r ->> 'more_nodes')::boolean, 'page suivante'); total := total + 1;
  r := pg_temp.call(a, format('select public.sync_pull(%L, 0, 0, 200)', w));
  perform pg_temp.chk(r -> 'nodes' @> '[{"title":"Après refus"}]'::jsonb and (r -> 'docs' -> 0 ->> 'update') = encode('\x0102030405'::bytea, 'base64'), 'contenu du pull fidèle'); total := total + 1;

  -- Modification postérieure => séquence plus élevée => revient dans le pull.
  r := pg_temp.call(a, format('select public.sync_pull(%L, 0, 0, 200)', w));
  declare cur bigint := (r ->> 'node_cursor')::bigint;
  begin
    perform pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), root, '{"title":"Racine 2"}', 6000, dev1::text)));
    r := pg_temp.call(a, format('select public.sync_pull(%L, %s, 0, 200)', w, cur));
    perform pg_temp.chk(jsonb_array_length(r -> 'nodes') = 1 and r -> 'nodes' -> 0 ->> 'title' = 'Racine 2', 'une modification réapparaît dans le pull'); total := total + 1;
  end;

  -- Droits : non-membre et lecteur.
  perform pg_temp.chk(pg_temp.fails(b, format('select public.sync_push(%L, ''[]''::jsonb)', w)), 'non-membre : push refusé'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(b, format('select public.sync_pull(%L, 0, 0, 10)', w)), 'non-membre : pull refusé'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(c, format('select public.sync_push(%L, ''[]''::jsonb)', w)), 'lecteur : push refusé'); total := total + 1;
  r := pg_temp.call(c, format('select public.sync_pull(%L, 0, 0, 200)', w));
  perform pg_temp.chk(jsonb_array_length(r -> 'nodes') = 3, 'lecteur : pull autorisé'); total := total + 1;
  -- Un non-membre ne voit pas les journaux ni les opérations.
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform pg_temp.chk((select count(*) from public.doc_updates) = 0 and (select count(*) from public.applied_ops) = 0, 'non-membre : aucun journal visible'); total := total + 1;
  reset role;
  -- anon n'a aucun accès.
  begin
    set local role anon;
    perform public.sync_pull(w, 0, 0, 10);
    raise exception 'ECHEC: anon exécute sync_pull';
  exception when insufficient_privilege then null;
  end;
  reset role;
  total := total + 1;

  raise exception 'TESTS_OK: % assertions', total;
end
$outer$;
