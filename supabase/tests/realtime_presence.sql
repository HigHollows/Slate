-- Tests de la migration 7 (présence : autorisation des canaux Realtime privés). Même convention que rls_core.sql :
-- résultat attendu = ERROR "TESTS_OK: <n> assertions" (tout est annulé par cette exception volontaire).
do $outer$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); d uuid := gen_random_uuid();
  w uuid := gen_random_uuid(); w2 uuid := gen_random_uuid();
  root uuid := gen_random_uuid(); pg uuid := gen_random_uuid(); th uuid := gen_random_uuid(); th2 uuid := gen_random_uuid(); c1 uuid := gen_random_uuid(); c2 uuid := gen_random_uuid(); c3 uuid := gen_random_uuid(); ghost uuid := gen_random_uuid();
  dev1 uuid := gen_random_uuid(); dev2 uuid := gen_random_uuid();
  total int := 0; r jsonb; q text;
begin
  create function pg_temp.chk(cond boolean, msg text) returns void language plpgsql as $f$
  begin if cond is not true then raise exception 'ECHEC: %', msg; end if; end $f$;
  create function pg_temp.call(u uuid, q text) returns jsonb language plpgsql as $f$
  declare res jsonb;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated', 'email', u::text || '@test.invalid')::text, true);
    set local role authenticated;
    execute q into res;
    reset role;
    return res;
  end $f$;
  create function pg_temp.fails(u uuid, q text, state text default '42501') returns boolean language plpgsql as $f$
  declare ok boolean;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated', 'email', u::text || '@test.invalid')::text, true);
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
  create function pg_temp.cop(opid uuid, ent text, id uuid, fields jsonb, ms bigint, dev text) returns jsonb language sql as $f$
    select jsonb_build_object('op_id', opid, 'entity', ent, 'entity_id', id, 'fields', fields, 'clock', jsonb_build_object('ms', ms, 'device', dev)) $f$;
  create function pg_temp.doc_op(opid uuid, id uuid, upd text, ms bigint, dev uuid) returns jsonb language sql as $f$
    select jsonb_build_object('op_id', opid, 'entity', 'doc', 'entity_id', id, 'update', upd, 'clock', jsonb_build_object('ms', ms, 'device', dev::text)) $f$;

  -- Décision d'autorisation telle que la politique l'évalue (même fonction, même rôle) : 'send' = éditeur, 'recv' = lecteur.
  -- (Le rôle SQL des tests n'a pas le droit de créer les partitions de realtime.messages : on évalue donc la fonction que les
  -- deux politiques appellent, et on vérifie séparément que les politiques sont bien en place et bien formées.)
  create function pg_temp.allowed(u uuid, topic text, op text) returns boolean language plpgsql as $f$
  declare ok boolean;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    set local role authenticated;
    ok := private.realtime_doc_allowed(topic, case when op = 'send' then 'editor'::public.workspace_role else 'viewer'::public.workspace_role end);
    reset role;
    return ok;
  end $f$;

  perform pg_temp.chk((select count(*) from pg_policies where schemaname = 'realtime' and tablename = 'messages'
     and policyname in ('realtime_doc_receive', 'realtime_doc_send') and roles = '{authenticated}'
     and coalesce(qual, with_check) like '%extension = ''broadcast''%' and coalesce(qual, with_check) like '%realtime_doc_allowed%') = 2, 'politiques en place');
  total := total + 1;
  perform pg_temp.chk((select cmd from pg_policies where policyname = 'realtime_doc_receive') = 'SELECT' and (select cmd from pg_policies where policyname = 'realtime_doc_send') = 'INSERT', 'réception = select, envoi = insert');
  total := total + 1;
  perform pg_temp.chk((select coalesce(with_check, '') like '%''editor''%' from pg_policies where policyname = 'realtime_doc_send') and (select qual like '%''viewer''%' from pg_policies where policyname = 'realtime_doc_receive'), 'envoi = éditeur, réception = lecteur');
  total := total + 1;

  insert into auth.users (id, email) values (a, 'a@test.invalid'), (b, 'b@test.invalid'), (c, 'c@test.invalid'), (d, 'd@test.invalid');
  perform pg_temp.call(a, format('select to_jsonb(1) from (select 1 where false) x'));
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.workspaces (id, name, owner_id) values (w, 'Perso', a), (w2, 'Autre', a);
  reset role;
  insert into public.workspace_members (workspace_id, user_id, role) values (w, c, 'viewer'), (w, b, 'editor');

  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.node_op(gen_random_uuid(), pg, jsonb_build_object('kind','page','title','Page','position','V0000001','parent_id',null), 100, dev1::text),
    pg_temp.node_op(gen_random_uuid(), root, jsonb_build_object('kind','folder','title','Dossier','position','V0000002','parent_id',null), 101, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and pg_temp.st(r,1)='applied', 'page et dossier créés'); total := total + 1;
  -- Une page de l'autre espace (w2), pour tester les sujets croisés.
  declare pg2 uuid := gen_random_uuid(); topic text := 'doc:' || w || ':' || pg; ttopic text;
  begin
    r := pg_temp.push(a, w2, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg2, jsonb_build_object('kind','page','title','Autre','position','V0000001','parent_id',null), 102, dev1::text)));
    -- éditeur : envoi accepté
    perform pg_temp.chk(pg_temp.allowed(b, topic, 'send'), 'éditeur : peut envoyer'); total := total + 1;
    perform pg_temp.chk(pg_temp.allowed(a, topic, 'send'), 'administrateur : peut envoyer'); total := total + 1;
    -- lecteur : ne peut pas envoyer, mais reçoit
    perform pg_temp.chk(not pg_temp.allowed(c, topic, 'send'), 'lecteur : ne peut pas envoyer'); total := total + 1;
    perform pg_temp.chk(pg_temp.allowed(c, topic, 'recv'), 'lecteur : peut recevoir'); total := total + 1;
    -- extérieur : ni l'un ni l'autre
    perform pg_temp.chk(not pg_temp.allowed(d, topic, 'send'), 'extérieur : ne peut pas envoyer'); total := total + 1;
    perform pg_temp.chk(not pg_temp.allowed(d, topic, 'recv'), 'extérieur : ne peut pas recevoir'); total := total + 1;
    -- extension autre que broadcast : refusée même pour un éditeur
    -- sujets invalides ou croisés : refusés
    perform pg_temp.chk(not pg_temp.allowed(b, 'doc:' || w || ':' || pg2, 'send'), 'page d''un autre espace refusée'); total := total + 1;
    perform pg_temp.chk(not pg_temp.allowed(b, 'doc:' || w2 || ':' || pg2, 'send'), 'espace dont on n''est pas membre refusé'); total := total + 1;
    perform pg_temp.chk(not pg_temp.allowed(b, 'doc:' || w || ':' || root, 'send'), 'un dossier n''a pas de canal'); total := total + 1;
    perform pg_temp.chk(not pg_temp.allowed(b, 'doc:' || w || ':' || gen_random_uuid(), 'send'), 'page inconnue refusée'); total := total + 1;
    perform pg_temp.chk(not pg_temp.allowed(b, topic || ':x', 'send'), 'sujet mal formé refusé'); total := total + 1;
    perform pg_temp.chk(not pg_temp.allowed(b, 'room:1', 'send'), 'autre sujet refusé'); total := total + 1;
    perform pg_temp.chk(not pg_temp.allowed(b, upper(topic), 'send'), 'sujet en majuscules refusé'); total := total + 1;
    -- page purgée : plus de canal
    r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg, '{"deleted_at":"2026-04-01T00:00:00Z"}', 600, dev1::text)));
    r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg, '{"purged_at":"2026-04-01T00:00:00Z"}', 610, dev1::text)));
    perform pg_temp.chk(not pg_temp.allowed(b, topic, 'send'), 'page purgée : plus de canal'); total := total + 1;
  end;
  begin
    set local role anon;
    perform private.realtime_doc_allowed('doc:x', 'viewer');
    raise exception 'ECHEC: anon exécute la fonction';
  exception when insufficient_privilege then null;
  end;
  reset role;
  total := total + 1;

  raise exception 'TESTS_OK: % assertions', total;
end
$outer$;
