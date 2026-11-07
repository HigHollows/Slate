-- Tests de la migration 6 (commentaires partagés). Même convention que rls_core.sql :
-- résultat attendu = ERROR "TESTS_OK: <n> assertions" (tout est annulé par cette exception volontaire).
do $outer$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
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

  insert into auth.users (id, email) values (a, 'a@test.invalid'), (b, 'b@test.invalid'), (c, 'c@test.invalid');
  perform pg_temp.call(a, format('select to_jsonb(1) from (select 1 where false) x'));
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.workspaces (id, name, owner_id) values (w, 'Perso', a), (w2, 'Autre', a);
  reset role;
  insert into public.workspace_members (workspace_id, user_id, role) values (w, c, 'viewer'), (w, b, 'editor');

  r := pg_temp.push(a, w, jsonb_build_array(
    pg_temp.node_op(gen_random_uuid(), pg, jsonb_build_object('kind','page','title','Page','position','V0000001','parent_id',null), 100, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied', 'page créée'); total := total + 1;

  -- Création d'un fil et d'un message par l'éditeur b ; l'étiquette d'auteur vient du jeton, pas du client.
  r := pg_temp.push(b, w, jsonb_build_array(
    pg_temp.cop(gen_random_uuid(), 'thread', th, jsonb_build_object('node_id', pg, 'quote', 'extrait', 'author_label', 'usurpateur@x.y', 'created_at', '2026-01-01T10:00:00Z'), 200, dev1::text),
    pg_temp.cop(gen_random_uuid(), 'comment', c1, jsonb_build_object('thread_id', th, 'body', 'Bonjour', 'author_label', 'usurpateur@x.y', 'created_at', '2026-01-01T10:01:00Z'), 201, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and pg_temp.st(r,1)='applied', 'fil + message créés'); total := total + 1;
  perform pg_temp.chk((select author_label from public.comment_threads where id = th) = b::text || '@test.invalid', 'étiquette du fil = adresse du jeton'); total := total + 1;
  perform pg_temp.chk((select author_label from public.comments where id = c1) = b::text || '@test.invalid', 'étiquette du message = adresse du jeton'); total := total + 1;
  perform pg_temp.chk((select author_id from public.comments where id = c1) = b, 'auteur = appelant'); total := total + 1;

  -- Rejeu : sans effet.
  declare o uuid := gen_random_uuid();
  begin
    r := pg_temp.push(b, w, jsonb_build_array(pg_temp.cop(o, 'comment', c2, jsonb_build_object('thread_id', th, 'body', 'Deux'), 210, dev1::text)));
    r := pg_temp.push(b, w, jsonb_build_array(pg_temp.cop(o, 'comment', c2, jsonb_build_object('thread_id', th, 'body', 'Deux'), 210, dev1::text)));
    perform pg_temp.chk(pg_temp.st(r,0)='duplicate' and (select count(*) from public.comments where thread_id = th) = 2, 'rejeu = duplicate'); total := total + 1;
  end;

  -- Refus : lecteur, fil inconnu, page inconnue.
  perform pg_temp.chk(pg_temp.fails(c, format('select public.sync_push(%L, %L::jsonb)', w,
    jsonb_build_array(pg_temp.cop(gen_random_uuid(), 'comment', gen_random_uuid(), jsonb_build_object('thread_id', th, 'body', 'x'), 220, dev1::text))::text)), 'lecteur : ne commente pas'); total := total + 1;
  r := pg_temp.push(b, w, jsonb_build_array(
    pg_temp.cop(gen_random_uuid(), 'comment', gen_random_uuid(), jsonb_build_object('thread_id', ghost, 'body', 'x'), 221, dev1::text),
    pg_temp.cop(gen_random_uuid(), 'thread', gen_random_uuid(), jsonb_build_object('node_id', ghost, 'quote', 'q'), 222, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='rejected' and r -> 0 ->> 'reason' like '%thread_missing%', 'message sans fil refusé'); total := total + 1;
  perform pg_temp.chk(pg_temp.st(r,1)='rejected' and r -> 1 ->> 'reason' like '%node_missing%', 'fil sans page refusé'); total := total + 1;
  r := pg_temp.push(b, w, jsonb_build_array(pg_temp.cop(gen_random_uuid(), 'comment', gen_random_uuid(), jsonb_build_object('thread_id', th, 'body', repeat('x', 5001)), 223, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='rejected', 'message trop long refusé'); total := total + 1;

  -- Modification : l'auteur oui (le plus récent gagne), un autre éditeur non, un administrateur oui.
  r := pg_temp.push(b, w, jsonb_build_array(pg_temp.cop(gen_random_uuid(), 'comment', c1, '{"body":"Édité"}', 300, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and (select body from public.comments where id = c1) = 'Édité' and (select edited_at from public.comments where id = c1) is not null, 'auteur modifie'); total := total + 1;
  r := pg_temp.push(b, w, jsonb_build_array(pg_temp.cop(gen_random_uuid(), 'comment', c1, '{"body":"Ancien"}', 250, dev2::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='merged' and (select body from public.comments where id = c1) = 'Édité', 'modification plus ancienne ignorée'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.cop(gen_random_uuid(), 'comment', c3, jsonb_build_object('thread_id', th, 'body', 'De a'), 310, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied', 'a commente aussi'); total := total + 1;
  r := pg_temp.push(b, w, jsonb_build_array(
    pg_temp.cop(gen_random_uuid(), 'comment', c3, '{"body":"Piraté"}', 320, dev1::text),
    pg_temp.cop(gen_random_uuid(), 'comment', c3, '{"deleted_at":"2026-02-01T00:00:00Z"}', 321, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='rejected' and pg_temp.st(r,1)='rejected', 'un autre éditeur ne modifie ni ne supprime');
  total := total + 1;
  perform pg_temp.chk((select body from public.comments where id = c3) = 'De a' and (select deleted_at from public.comments where id = c3) is null, 'message intact'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.cop(gen_random_uuid(), 'comment', c1, '{"body":"Modéré"}', 400, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and (select body from public.comments where id = c1) = 'Modéré', 'administrateur modère'); total := total + 1;
  -- Suppression logique par l'auteur.
  r := pg_temp.push(b, w, jsonb_build_array(pg_temp.cop(gen_random_uuid(), 'comment', c2, '{"deleted_at":"2026-02-01T00:00:00Z"}', 330, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and (select deleted_at from public.comments where id = c2) is not null, 'auteur supprime son message'); total := total + 1;

  -- Résoudre un fil : tout éditeur ; l'étiquette de résolution vient du jeton ; supprimer un fil : créateur ou administrateur.
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.cop(gen_random_uuid(), 'thread', th, '{"resolved_at":"2026-03-01T00:00:00Z"}', 500, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and (select resolved_label from public.comment_threads where id = th) = a::text || '@test.invalid', 'fil résolu, étiquette du jeton'); total := total + 1;
  r := pg_temp.push(b, w, jsonb_build_array(pg_temp.cop(gen_random_uuid(), 'thread', th, '{"resolved_at":null}', 510, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and (select resolved_at from public.comment_threads where id = th) is null and (select resolved_label from public.comment_threads where id = th) is null, 'fil rouvert'); total := total + 1;
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.cop(gen_random_uuid(), 'thread', th2, jsonb_build_object('node_id', pg, 'quote', 'autre'), 520, dev1::text)));
  r := pg_temp.push(b, w, jsonb_build_array(pg_temp.cop(gen_random_uuid(), 'thread', th2, '{"deleted_at":"2026-03-02T00:00:00Z"}', 530, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='rejected' and r -> 0 ->> 'reason' like '%not_author%', 'seul le créateur ou un administrateur supprime un fil'); total := total + 1;

  -- Flux : un message arrive toujours après son fil, même si le fil est modifié ensuite ; le lecteur voit tout.
  declare items jsonb; ti int; ci int;
  begin
    r := pg_temp.call(c, format('select public.sync_pull_struct(%L, 0, 500)', w));
    items := r -> 'items';
    select min(ord) into ti from jsonb_array_elements(items) with ordinality e(x, ord) where x ->> 'kind' = 'thread' and x ->> 'id' = th::text;
    select max(ord) into ci from jsonb_array_elements(items) with ordinality e(x, ord) where x ->> 'kind' = 'comment' and x ->> 'thread_id' = th::text;
    perform pg_temp.chk(ti is not null and ci is not null and ti < ci, 'le fil précède ses messages dans le flux'); total := total + 1;
    perform pg_temp.chk(exists (select 1 from jsonb_array_elements(items) e(x) where x ->> 'id' = c1::text and x ->> 'author_label' = b::text || '@test.invalid'), 'le lecteur voit l''auteur'); total := total + 1;
  end;

  -- Purge de la page : fils et messages disparaissent.
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg, '{"deleted_at":"2026-04-01T00:00:00Z"}', 600, dev1::text)));
  r := pg_temp.push(a, w, jsonb_build_array(pg_temp.node_op(gen_random_uuid(), pg, '{"purged_at":"2026-04-01T00:00:00Z"}', 610, dev1::text)));
  perform pg_temp.chk(pg_temp.st(r,0)='applied' and (select count(*) from public.comment_threads where node_id = pg) = 0 and (select count(*) from public.comments where workspace_id = w) = 0, 'purge de la page : commentaires effacés'); total := total + 1;
  -- Aucun accès anonyme.
  begin
    set local role anon;
    perform count(*) from public.comments;
    raise exception 'ECHEC: anon lit les commentaires';
  exception when insufficient_privilege then null;
  end;
  reset role;
  total := total + 1;

  raise exception 'TESTS_OK: % assertions', total;
end
$outer$;
