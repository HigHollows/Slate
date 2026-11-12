-- Tests de la migration 9 (partage d'un dossier ou d'une page précis). Même convention que rls_core.sql :
-- résultat attendu = ERROR "TESTS_OK: <n> assertions" (tout est annulé par cette exception volontaire).
do $outer$
declare
  a uuid := gen_random_uuid(); g uuid := gen_random_uuid(); v uuid := gen_random_uuid(); o uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  w uuid := gen_random_uuid();
  r_ uuid := gen_random_uuid(); f_ uuid := gen_random_uuid(); p_ uuid := gen_random_uuid(); x_ uuid := gen_random_uuid(); q_ uuid := gen_random_uuid();
  th uuid := gen_random_uuid(); dev1 uuid := gen_random_uuid();
  total int := 0; r jsonb; tok text; nodes jsonb;
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

  insert into auth.users (id, email) values (a, a::text || '@test.invalid'), (g, g::text || '@test.invalid'), (v, v::text || '@test.invalid'), (o, o::text || '@test.invalid'), (c, c::text || '@test.invalid');
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.workspaces (id, name, owner_id) values (w, 'Espace', a);
  reset role;
  insert into public.workspace_members (workspace_id, user_id, role) values (w, c, 'viewer');

  -- Arbre : R (racine) > F (dossier partagé) > P (page) ; X (page hors partage, à la racine).
  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.node_op(gen_random_uuid(), r_, '{"kind":"folder","title":"R","position":"V1","parent_id":null}', 100, dev1::text),
    pg_temp.node_op(gen_random_uuid(), f_, jsonb_build_object('kind','folder','title','F','position','V1','parent_id',r_), 101, dev1::text),
    pg_temp.node_op(gen_random_uuid(), p_, jsonb_build_object('kind','page','title','P','position','V1','parent_id',f_), 102, dev1::text),
    pg_temp.node_op(gen_random_uuid(), x_, '{"kind":"page","title":"X secret","position":"V2","parent_id":null}', 103, dev1::text),
    pg_temp.doc_op(gen_random_uuid(), p_, encode('\x01'::bytea, 'base64'), 104, dev1),
    pg_temp.doc_op(gen_random_uuid(), x_, encode('\x02'::bytea, 'base64'), 105, dev1)));
  perform pg_temp.chk((select bool_and(e ->> 'status' = 'applied') from jsonb_array_elements(r) e), 'arbre créé par le membre'); total := total + 1;

  -- Avant tout partage : l'extérieur ne voit rien et ne peut rien.
  perform pg_temp.chk(pg_temp.fails(g, format('select public.sync_pull(%L, 0, 0, 100)', w)), 'sans partage : lecture refusée'); total := total + 1;
  perform pg_temp.chk((pg_temp.call(g, 'select to_jsonb(count(*)) from public.nodes') #>> '{}')::int = 0, 'sans partage : aucune ligne visible'); total := total + 1;

  -- Invitation ciblée : administrateurs seulement, jamais « administrateur », nœud existant.
  perform pg_temp.chk(pg_temp.fails(c, format('select public.create_node_invitation(%L, %L, %L)', f_, 'x@test.invalid', 'viewer')), 'un lecteur membre ne peut pas inviter'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(o, format('select public.create_node_invitation(%L, %L, %L)', f_, 'x@test.invalid', 'viewer')), 'un extérieur ne peut pas inviter'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('select public.create_node_invitation(%L, %L, %L)', f_, 'x@test.invalid', 'admin'), '22023'), 'pas de rôle administrateur sur un élément'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('select public.create_node_invitation(%L, %L, %L)', gen_random_uuid(), 'x@test.invalid', 'viewer')), 'élément inconnu refusé'); total := total + 1;
  r := pg_temp.call(a, format('select public.create_node_invitation(%L, %L, %L)', f_, g::text || '@test.invalid', 'editor'));
  tok := r ->> 'token';
  perform pg_temp.chk(tok ~ '^[0-9a-f]{64}$' and r ->> 'node_id' = f_::text, 'invitation ciblée créée'); total := total + 1;

  -- Acceptation : un partage, PAS une adhésion à l'espace.
  perform pg_temp.chk(pg_temp.fails(o, format('select public.accept_invitation(%L)', tok), 'P0001'), 'mauvaise adresse : refusé'); total := total + 1;
  r := pg_temp.call(g, format('select public.accept_invitation(%L)', tok));
  perform pg_temp.chk(r ->> 'scope' = 'shared' and r ->> 'role' = 'editor' and r ->> 'node_id' = f_::text and r ->> 'workspace_id' = w::text, 'accepté : portée « partagé »'); total := total + 1;
  perform pg_temp.chk(not exists (select 1 from public.workspace_members where user_id = g), 'l''invité n''est PAS membre de l''espace'); total := total + 1;
  perform pg_temp.chk(exists (select 1 from public.node_shares where user_id = g and node_id = f_ and role = 'editor'), 'partage enregistré'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(g, format('select public.accept_invitation(%L)', tok), 'P0001'), 'jeton à usage unique'); total := total + 1;
  r := pg_temp.call(g, 'select public.my_access()');
  perform pg_temp.chk(jsonb_array_length(r) = 1 and r -> 0 ->> 'scope' = 'shared' and r -> 0 ->> 'role' = 'editor', 'my_access : espace en portée partagée'); total := total + 1;

  -- Lecture : seulement F et P ; F apparaît à la racine (son parent R est masqué) ; X et R invisibles.
  r := pg_temp.call(g, format('select public.sync_pull(%L, 0, 0, 100)', w));
  nodes := r -> 'nodes';
  perform pg_temp.chk((select array_agg(e ->> 'id' order by e ->> 'id') from jsonb_array_elements(nodes) e) = (select array_agg(i::text order by i::text) from unnest(array[f_, p_]) i), 'l''invité ne reçoit que le dossier partagé et son contenu'); total := total + 1;
  perform pg_temp.chk((select e ->> 'parent_id' from jsonb_array_elements(nodes) e where e ->> 'id' = f_::text) is null, 'le parent du dossier partagé est masqué'); total := total + 1;
  perform pg_temp.chk((select e ->> 'parent_id' from jsonb_array_elements(nodes) e where e ->> 'id' = p_::text) = f_::text, 'la hiérarchie interne est conservée'); total := total + 1;
  perform pg_temp.chk(r::text not like '%X secret%', 'aucune fuite du titre hors partage'); total := total + 1;
  perform pg_temp.chk(jsonb_array_length(r -> 'docs') = 1 and r -> 'docs' -> 0 ->> 'node_id' = p_::text, 'contenu : seulement la page partagée'); total := total + 1;
  perform pg_temp.chk((pg_temp.call(g, 'select to_jsonb(count(*)) from public.nodes') #>> '{}')::int = 2, 'RLS directe : 2 lignes visibles'); total := total + 1;
  perform pg_temp.chk((pg_temp.call(g, format('select to_jsonb(count(*)) from public.doc_updates where node_id = %L', x_)) #>> '{}')::int = 0, 'RLS directe : contenu hors partage invisible'); total := total + 1;

  -- Écriture dans le partage : renommer, écrire, créer une sous-page, commenter.
  r := pg_temp.push(g, w, jsonb_build_array(
    pg_temp.node_op(gen_random_uuid(), p_, '{"title":"P modifié"}', 200, dev1::text),
    pg_temp.doc_op(gen_random_uuid(), p_, encode('\x03'::bytea, 'base64'), 201, dev1),
    pg_temp.node_op(gen_random_uuid(), q_, jsonb_build_object('kind','page','title','Q','position','V2','parent_id',f_), 202, dev1::text),
    pg_temp.cop(gen_random_uuid(), 'thread', th, jsonb_build_object('node_id', p_, 'quote', 'q'), 203, dev1::text),
    pg_temp.cop(gen_random_uuid(), 'comment', gen_random_uuid(), jsonb_build_object('thread_id', th, 'body', 'Bonjour'), 204, dev1::text)));
  perform pg_temp.chk((select bool_and(e ->> 'status' = 'applied') from jsonb_array_elements(r) e), 'l''invité éditeur écrit dans le partage : ' || r::text); total := total + 1;
  perform pg_temp.chk((select title from public.nodes where id = p_) = 'P modifié' and (select created_by from public.nodes where id = q_) = g, 'modifications enregistrées'); total := total + 1;

  -- Écriture HORS du partage : chaque opération est refusée, sans bloquer les autres.
  r := pg_temp.push(g, w, jsonb_build_array(
    pg_temp.node_op(gen_random_uuid(), x_, '{"title":"piraté"}', 300, dev1::text),
    pg_temp.doc_op(gen_random_uuid(), x_, encode('\x09'::bytea, 'base64'), 301, dev1),
    pg_temp.node_op(gen_random_uuid(), gen_random_uuid(), '{"kind":"page","title":"à la racine","position":"V9","parent_id":null}', 302, dev1::text),
    pg_temp.node_op(gen_random_uuid(), gen_random_uuid(), jsonb_build_object('kind','page','title','sous R','position','V9','parent_id',r_), 303, dev1::text),
    pg_temp.node_op(gen_random_uuid(), p_, jsonb_build_object('parent_id', r_), 304, dev1::text),
    pg_temp.node_op(gen_random_uuid(), p_, '{"parent_id":null}', 305, dev1::text),
    pg_temp.node_op(gen_random_uuid(), f_, '{"deleted_at":"2026-01-01T00:00:00Z"}', 306, dev1::text),
    pg_temp.node_op(gen_random_uuid(), f_, jsonb_build_object('parent_id', p_), 307, dev1::text),
    pg_temp.node_op(gen_random_uuid(), p_, '{"purged_at":"2026-01-01T00:00:00Z"}', 308, dev1::text),
    pg_temp.cop(gen_random_uuid(), 'thread', gen_random_uuid(), jsonb_build_object('node_id', x_, 'quote', 'q'), 309, dev1::text),
    pg_temp.node_op(gen_random_uuid(), f_, '{"title":"F renommé"}', 310, dev1::text)));
  perform pg_temp.chk((select bool_and(e ->> 'status' = 'rejected') from jsonb_array_elements(r) with ordinality t(e, i) where i <= 10), 'hors partage : tout est refusé : ' || r::text); total := total + 1;
  perform pg_temp.chk(r -> 10 ->> 'status' = 'applied', 'une opération permise du même lot passe quand même'); total := total + 1;
  perform pg_temp.chk((select title from public.nodes where id = x_) = 'X secret' and (select count(*) from public.doc_updates where node_id = x_) = 1, 'page hors partage intacte'); total := total + 1;
  perform pg_temp.chk((select parent_id from public.nodes where id = p_) = f_ and (select parent_id from public.nodes where id = f_) = r_ and (select deleted_at from public.nodes where id = f_) is null, 'rien n''est sorti du partage ni supprimé'); total := total + 1;
  perform pg_temp.chk((select count(*) from public.nodes where workspace_id = w) = 5, 'aucun nœud créé hors partage'); total := total + 1;

  -- Présence en direct : la page partagée oui, l'autre non.
  perform set_config('request.jwt.claims', json_build_object('sub', g, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform pg_temp.chk(private.realtime_doc_allowed('doc:' || w || ':' || p_, 'editor'), 'canal de la page partagée autorisé');
  perform pg_temp.chk(not private.realtime_doc_allowed('doc:' || w || ':' || x_, 'viewer'), 'canal d''une autre page refusé');
  reset role;
  total := total + 2;

  -- Partage en LECTURE seule : reçoit, n'écrit pas.
  r := pg_temp.call(a, format('select public.create_node_invitation(%L, %L, %L)', p_, v::text || '@test.invalid', 'viewer'));
  r := pg_temp.call(v, format('select public.accept_invitation(%L)', r ->> 'token'));
  r := pg_temp.call(v, format('select public.sync_pull(%L, 0, 0, 100)', w));
  perform pg_temp.chk(jsonb_array_length(r -> 'nodes') = 1 and r -> 'nodes' -> 0 ->> 'id' = p_::text and r -> 'nodes' -> 0 ->> 'parent_id' is null, 'page seule partagée : elle seule, à la racine'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(v, format('select public.sync_push(%L, %L::jsonb)', w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), p_, '{"title":"non"}', 400, dev1::text))::text)), 'lecteur invité : écriture refusée'); total := total + 1;

  -- Les membres gardent exactement leurs droits.
  r := pg_temp.call(c, format('select public.sync_pull(%L, 0, 0, 100)', w));
  perform pg_temp.chk(jsonb_array_length(r -> 'nodes') = 5, 'membre lecteur : voit tout l''espace'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), x_, '{"title":"X par le membre"}', 500, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0) = 'applied', 'membre éditeur : écrit partout'); total := total + 1;

  -- Gestion des partages : liste réservée aux administrateurs ; retrait = fin immédiate de l'accès.
  perform pg_temp.chk(pg_temp.fails(g, format('select public.list_node_shares(%L)', f_)), 'l''invité ne liste pas les partages'); total := total + 1;
  r := pg_temp.call(a, format('select public.list_node_shares(%L)', f_));
  perform pg_temp.chk(jsonb_array_length(r -> 'shares') = 1 and r -> 'shares' -> 0 ->> 'user_id' = g::text, 'l''administrateur voit qui a accès'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(o, format('select to_jsonb(1) from (select public.remove_node_share(%L, %L)) x', f_, g)), 'un extérieur ne retire pas un partage'); total := total + 1;
  perform pg_temp.call(a, format('select to_jsonb(1) from (select public.remove_node_share(%L, %L)) x', f_, g));
  perform pg_temp.chk(pg_temp.fails(g, format('select public.sync_pull(%L, 0, 0, 100)', w)), 'partage retiré : lecture refusée'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(g, format('select public.sync_push(%L, %L::jsonb)', w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), p_, '{"title":"après"}', 600, dev1::text))::text)), 'partage retiré : écriture refusée'); total := total + 1;
  perform pg_temp.chk((pg_temp.call(g, 'select to_jsonb(count(*)) from public.nodes') #>> '{}')::int = 0, 'partage retiré : plus aucune ligne visible'); total := total + 1;

  begin
    set local role anon;
    perform public.my_access();
    raise exception 'ECHEC: anon appelle my_access';
  exception when insufficient_privilege then null;
  end;
  reset role;
  total := total + 1;

  raise exception 'TESTS_OK: % assertions', total;
end
$outer$;
