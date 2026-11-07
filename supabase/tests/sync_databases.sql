-- Tests de la migration 3 (synchronisation des bases de données). Résultat attendu : ERROR "TESTS_OK: <n> assertions".
do $outer$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  w uuid := gen_random_uuid(); w2 uuid := gen_random_uuid();
  db uuid := gen_random_uuid(); r1 uuid := gen_random_uuid(); r2 uuid := gen_random_uuid(); loose uuid := gen_random_uuid(); db2 uuid := gen_random_uuid();
  p1 uuid := gen_random_uuid(); p2 uuid := gen_random_uuid(); v1 uuid := gen_random_uuid();
  total int := 0; r jsonb; d1 text := 'dev-a'; d2 text := 'dev-b';
begin
  create function pg_temp.chk(cond boolean, msg text) returns void language plpgsql as $f$
  begin if cond is not true then raise exception 'ECHEC: %', msg; end if; end $f$;
  create function pg_temp.call(u uuid, q text) returns jsonb language plpgsql as $f$
  declare res jsonb;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    set local role authenticated; execute q into res; reset role; return res;
  end $f$;
  create function pg_temp.fails(u uuid, q text, state text default '42501') returns boolean language plpgsql as $f$
  declare ok boolean;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    begin set local role authenticated; execute q; ok := false;
    exception when others then ok := (sqlstate = state); end;
    reset role; return ok;
  end $f$;
  create function pg_temp.st(res jsonb, i int) returns text language sql as $f$ select res -> i ->> 'status' $f$;
  create function pg_temp.push(u uuid, ws uuid, ops jsonb) returns jsonb language sql as $f$
    select pg_temp.call(u, format('select public.sync_push(%L, %L::jsonb)', ws, ops::text)) $f$;
  create function pg_temp.op(ent text, id uuid, fields jsonb, ms bigint, dev text) returns jsonb language sql as $f$
    select jsonb_build_object('op_id', gen_random_uuid(), 'entity', ent, 'entity_id', id, 'fields', fields, 'clock', jsonb_build_object('ms', ms, 'device', dev)) $f$;

  insert into auth.users (id, email) values (a, 'a@test.invalid'), (b, 'b@test.invalid'), (c, 'c@test.invalid');
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.workspaces (id, name, owner_id) values (w, 'Perso', a), (w2, 'Autre', a);
  reset role;
  insert into public.workspace_members (workspace_id, user_id, role) values (w, c, 'viewer');

  -- nœuds : base, deux lignes (enfants de la base), un nœud hors base, une base dans l'autre espace
  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.op('node', db, '{"kind":"database","title":"Tâches","position":"V1","parent_id":null}', 10, d1),
    pg_temp.op('node', r1, jsonb_build_object('kind','page','title','L1','position','V1','parent_id',db), 11, d1),
    pg_temp.op('node', r2, jsonb_build_object('kind','page','title','L2','position','V2','parent_id',db), 12, d1),
    pg_temp.op('node', loose, '{"kind":"page","title":"Libre","position":"V9","parent_id":null}', 13, d1)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and pg_temp.st(r,3)='applied', 'nœuds de base créés'); total := total + 1;
  r := pg_temp.push(a, w2, jsonb_build_array(pg_temp.op('node', db2, '{"kind":"database","title":"Autre","position":"V1","parent_id":null}', 14, d1)));

  -- propriétés
  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.op('prop', p1, jsonb_build_object('database_id', db, 'name', 'Nom', 'type', 'title', 'position', 'U1', 'config', '{}'::jsonb), 20, d1),
    pg_temp.op('prop', p2, jsonb_build_object('database_id', db, 'name', 'Statut', 'type', 'status', 'position', 'U2', 'config', '{"options":[{"id":"a","name":"A","group":"todo"}]}'::jsonb), 21, d1)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and pg_temp.st(r,1)='applied', 'propriétés créées'); total := total + 1;
  perform pg_temp.chk((select config -> 'options' -> 0 ->> 'name' from public.db_properties where id = p2) = 'A', 'configuration conservée'); total := total + 1;
  -- fusion par champ : nom (ancien) ignoré, config (récente) appliquée, nom récent appliqué
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.op('prop', p2, '{"name":"Ancien nom"}', 5, d2)));
  perform pg_temp.chk(pg_temp.st(r,0)='merged' and (select name from public.db_properties where id = p2) = 'Statut', 'nom plus ancien ignoré'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.op('prop', p2, '{"name":"Etat"}', 30, d1),
    pg_temp.op('prop', p2, '{"config":{"options":[]}}', 25, d2)));
  perform pg_temp.chk((select name from public.db_properties where id = p2) = 'Etat' and (select config from public.db_properties where id = p2) = '{"options":[]}'::jsonb, 'champs indépendants fusionnés'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.op('prop', p2, '{"deleted_at":"2026-01-01T00:00:00Z"}', 40, d1)));
  perform pg_temp.chk((select deleted_at from public.db_properties where id = p2) is not null, 'propriété supprimée (tombstone)'); total := total + 1;
  -- refus
  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.op('prop', gen_random_uuid(), jsonb_build_object('database_id', db, 'name', 'X', 'type', 'inconnu', 'position', 'U3'), 50, d1),
    pg_temp.op('prop', gen_random_uuid(), jsonb_build_object('database_id', gen_random_uuid(), 'name', 'X', 'type', 'text', 'position', 'U3'), 51, d1),
    pg_temp.op('prop', gen_random_uuid(), jsonb_build_object('database_id', loose, 'name', 'X', 'type', 'text', 'position', 'U3'), 52, d1),
    pg_temp.op('prop', gen_random_uuid(), jsonb_build_object('database_id', db2, 'name', 'X', 'type', 'text', 'position', 'U3'), 53, d1),
    pg_temp.op('prop', gen_random_uuid(), jsonb_build_object('database_id', db, 'name', 'sans type'), 54, d1)));
  perform pg_temp.chk((select count(*) from jsonb_array_elements(r) e where e ->> 'status' = 'rejected') = 5, 'type inconnu, base inconnue, nœud non-base, autre espace, création incomplète : refusés'); total := total + 1;
  r := pg_temp.push(a, w2, jsonb_build_array(pg_temp.op('prop', p1, jsonb_build_object('name', 'Vol'), 60, d1)));
  perform pg_temp.chk(r -> 0 ->> 'reason' like '%foreign_object%' and (select name from public.db_properties where id = p1) = 'Nom', 'propriété d''un autre espace intouchable'); total := total + 1;

  -- vues
  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.op('view', v1, jsonb_build_object('database_id', db, 'name', 'Calendrier', 'layout', 'calendar', 'position', 'W1', 'config', '{"dateProperty":"x"}'::jsonb), 70, d1),
    pg_temp.op('view', gen_random_uuid(), jsonb_build_object('database_id', db, 'name', 'Bizarre', 'layout', 'bizarre', 'position', 'W2'), 71, d1)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and pg_temp.st(r,1)='rejected', 'vue valide créée, mise en page inconnue refusée'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.op('view', v1, '{"name":"Agenda"}', 80, d1)));
  perform pg_temp.chk((select name from public.db_views where id = v1) = 'Agenda', 'vue renommée'); total := total + 1;

  -- lignes : valeurs par cellule
  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.op('row', r1, jsonb_build_object('database_id', db, 'cells', jsonb_build_object(p1, 'Écrire', p2, 'a')), 100, d1),
    pg_temp.op('row', loose, jsonb_build_object('database_id', db, 'cells', '{}'::jsonb), 101, d1),
    pg_temp.op('row', r2, jsonb_build_object('cells', '{}'::jsonb), 102, d1)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and pg_temp.st(r,1)='rejected' and r -> 1 ->> 'reason' like '%node_missing%', 'ligne créée ; un nœud qui n''est pas enfant de la base est refusé'); total := total + 1;
  perform pg_temp.chk(pg_temp.st(r,2)='rejected', 'création de ligne sans base refusée'); total := total + 1;
  perform pg_temp.chk((select props ->> p1::text from public.db_rows where node_id = r1) = 'Écrire', 'cellule enregistrée'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.op('row', r1, jsonb_build_object('cells', jsonb_build_object(p1, 'Ancien')), 50, d2)));
  perform pg_temp.chk(pg_temp.st(r,0)='merged' and (select props ->> p1::text from public.db_rows where node_id = r1) = 'Écrire', 'cellule plus ancienne ignorée'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.op('row', r1, jsonb_build_object('cells', jsonb_build_object(p1, 'Réviser')), 200, d1),
    pg_temp.op('row', r1, jsonb_build_object('cells', jsonb_build_object(p2, 'b')), 150, d2)));
  perform pg_temp.chk((select props ->> p1::text from public.db_rows where node_id = r1) = 'Réviser' and (select props ->> p2::text from public.db_rows where node_id = r1) = 'b', 'deux cellules modifiées par deux appareils : toutes deux conservées'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.op('row', r1, jsonb_build_object('cells', jsonb_build_object(p2, null)), 300, d1)));
  perform pg_temp.chk(not ((select props from public.db_rows where node_id = r1) ? p2::text), 'cellule vidée = retirée');  total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.op('row', r1, jsonb_build_object('cells', jsonb_build_object(p2, 'tard')), 250, d2)));
  perform pg_temp.chk(pg_temp.st(r,0)='merged', 'une écriture plus ancienne que le vidage ne ressuscite pas la cellule'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.op('row', r1, '{"cells":{"pas-un-uuid":1}}', 400, d1)));
  perform pg_temp.chk(pg_temp.st(r,0)='rejected' and r -> 0 ->> 'reason' like '%bad_cell_key%', 'clé de cellule invalide refusée'); total := total + 1;
  -- valeurs structurées (listes de relations)
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.op('row', r2, jsonb_build_object('database_id', db, 'cells', jsonb_build_object(p1, jsonb_build_array(r1::text))), 500, d1)));
  perform pg_temp.chk((select props -> p1::text -> 0 from public.db_rows where node_id = r2) = to_jsonb(r1::text), 'liste conservée telle quelle'); total := total + 1;

  -- rejeu
  declare o jsonb := pg_temp.op('row', r2, jsonb_build_object('cells', jsonb_build_object(p2, 'x')), 600, d1);
  begin
    r := pg_temp.push(a, w, jsonb_build_array(o)); r := pg_temp.push(a, w, jsonb_build_array(o));
    perform pg_temp.chk(pg_temp.st(r,0)='duplicate', 'rejeu = duplicate'); total := total + 1;
  end;

  -- lecture unifiée
  r := pg_temp.call(a, format('select public.sync_pull_struct(%L, 0, 200)', w));
  perform pg_temp.chk(jsonb_array_length(r -> 'items') = 5, 'pull : 2 propriétés, 1 vue, 2 lignes'); total := total + 1;
  perform pg_temp.chk((select count(*) from jsonb_array_elements(r -> 'items') e where e ->> 'kind' = 'prop') = 2 and (select count(*) from jsonb_array_elements(r -> 'items') e where e ->> 'kind' = 'row') = 2, 'types mêlés'); total := total + 1;
  perform pg_temp.chk((r -> 'items' @> jsonb_build_array(jsonb_build_object('kind','view','name','Agenda'))) is not false, 'vue présente'); total := total + 1;
  perform pg_temp.chk((r ->> 'more')::boolean = false and (r ->> 'cursor')::bigint = (select max(s) from (select max(server_seq) s from public.db_properties union all select max(server_seq) from public.db_views union all select max(server_seq) from public.db_rows) x), 'curseur = dernière séquence'); total := total + 1;
  perform pg_temp.chk((select e ->> 'deleted_at' from jsonb_array_elements(r -> 'items') e where e ->> 'id' = p2::text) is not null, 'tombstone de propriété transmis'); total := total + 1;
  r := pg_temp.call(a, format('select public.sync_pull_struct(%L, 0, 2)', w));
  perform pg_temp.chk(jsonb_array_length(r -> 'items') = 2 and (r ->> 'more')::boolean, 'pagination du flux unifié'); total := total + 1;
  declare seen int := 0; cur bigint := 0; res jsonb; n int;
  begin
    loop
      res := pg_temp.call(a, format('select public.sync_pull_struct(%L, %s, 2)', w, cur));
      n := jsonb_array_length(res -> 'items'); seen := seen + n; exit when n = 0;
      cur := (res ->> 'cursor')::bigint; exit when not (res ->> 'more')::boolean;
    end loop;
    perform pg_temp.chk(seen = 5, 'toutes les pages du flux couvrent chaque élément exactement une fois'); total := total + 1;
  end;
  r := pg_temp.call(a, format('select public.sync_pull_struct(%L, %s, 200)', w, (select max(server_seq) from public.db_rows)));
  perform pg_temp.chk(jsonb_array_length(r -> 'items') = 0, 'à jour : rien'); total := total + 1;
  r := pg_temp.call(a, format('select public.sync_pull_struct(%L, 0, 200)', w2));
  perform pg_temp.chk(jsonb_array_length(r -> 'items') = 0, 'l''autre espace est isolé'); total := total + 1;

  -- droits
  perform pg_temp.chk(pg_temp.fails(b, format('select public.sync_pull_struct(%L, 0, 10)', w)), 'non-membre : lecture refusée'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(c, format('select public.sync_push(%L, %L::jsonb)', w, jsonb_build_array(pg_temp.op('prop', gen_random_uuid(), '{}', 1, d1))::text)), 'lecteur : écriture refusée'); total := total + 1;
  r := pg_temp.call(c, format('select public.sync_pull_struct(%L, 0, 200)', w));
  perform pg_temp.chk(jsonb_array_length(r -> 'items') = 5, 'lecteur : lecture autorisée'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('insert into public.db_rows (node_id, workspace_id, database_id) values (%L, %L, %L)', loose, w, db), '23514'), 'garde : une ligne doit être enfant de sa base'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('insert into public.db_properties (id, workspace_id, database_id, name, type, position) values (gen_random_uuid(), %L, %L, ''x'', ''text'', ''U'')', w, loose), '23514'), 'garde : une propriété doit viser une base'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('delete from public.db_rows where node_id = %L', r1)) or (select count(*) from public.db_rows where node_id = r1) = 1, 'un éditeur ne supprime pas de ligne'); total := total + 1;
  begin
    set local role anon;
    perform public.sync_pull_struct(w, 0, 10);
    raise exception 'ECHEC: anon exécute sync_pull_struct';
  exception when insufficient_privilege then null;
  end;
  reset role; total := total + 1;

  raise exception 'TESTS_OK: % assertions', total;
end
$outer$;
