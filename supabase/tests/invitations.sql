-- Tests de la migration 4 (invitations et membres). Résultat attendu : ERROR "TESTS_OK: <n> assertions" (tout est annulé).
do $outer$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); e uuid := gen_random_uuid(); v uuid := gen_random_uuid();
  w uuid := gen_random_uuid(); w2 uuid := gen_random_uuid();
  total int := 0; r jsonb; tok text; tok2 text; inv uuid;
begin
  create function pg_temp.chk(cond boolean, msg text) returns void language plpgsql as $f$
  begin if cond is not true then raise exception 'ECHEC: %', msg; end if; end $f$;
  create function pg_temp.call(u uuid, q text) returns jsonb language plpgsql as $f$
  declare res jsonb;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated', 'email', (select email from auth.users where id = u))::text, true);
    set local role authenticated; execute q into res; reset role; return res;
  end $f$;
  create function pg_temp.fails(u uuid, q text, msg text default null, state text default null) returns boolean language plpgsql as $f$
  declare ok boolean;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated', 'email', (select email from auth.users where id = u))::text, true);
    begin set local role authenticated; execute q; ok := false;
    exception when others then ok := (state is null or sqlstate = state) and (msg is null or sqlerrm like '%' || msg || '%'); end;
    reset role; return ok;
  end $f$;
  create function pg_temp.mk(u uuid, ws uuid, em text, rl text) returns jsonb language sql as $f$
    select pg_temp.call(u, format('select public.create_invitation(%L, %L, %L::public.workspace_role)', ws, em, rl)) $f$;

  insert into auth.users (id, email) values (a, 'a@test.invalid'), (b, 'b@test.invalid'), (c, 'c@test.invalid'), (e, 'ed@test.invalid'), (v, 'v@test.invalid');
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.workspaces (id, name, owner_id) values (w, 'Équipe', a), (w2, 'Autre', a);
  reset role;
  insert into public.workspace_members (workspace_id, user_id, role) values (w, e, 'editor'), (w, v, 'viewer');

  perform pg_temp.chk(pg_temp.fails(e, format('select public.create_invitation(%L, ''x@y.fr'', ''viewer'')', w), 'forbidden', '42501'), 'un éditeur ne peut pas inviter'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(v, format('select public.create_invitation(%L, ''x@y.fr'', ''viewer'')', w), 'forbidden', '42501'), 'un lecteur ne peut pas inviter'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(b, format('select public.create_invitation(%L, ''x@y.fr'', ''viewer'')', w), 'forbidden', '42501'), 'un non-membre ne peut pas inviter'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('select public.create_invitation(%L, ''pas-une-adresse'', ''viewer'')', w), 'invalid_email', '22023'), 'adresse invalide refusée'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('select public.create_invitation(%L, ''x@y.fr'', ''superman'')', w)), 'rôle inconnu refusé'); total := total + 1;
  r := pg_temp.mk(a, w, '  B@Test.Invalid ', 'editor');
  tok := r ->> 'token'; inv := (r ->> 'id')::uuid;
  perform pg_temp.chk(tok ~ '^[0-9a-f]{64}$' and r ->> 'email' = 'b@test.invalid', 'jeton de 64 hexadécimaux, adresse normalisée'); total := total + 1;
  perform pg_temp.chk((select token_hash from public.workspace_invitations where id = inv) <> tok and (select token_hash from public.workspace_invitations where id = inv) = encode(sha256(convert_to(tok, 'UTF8')), 'hex'), 'seule l''empreinte est stockée'); total := total + 1;
  perform pg_temp.chk(not exists (select 1 from public.workspace_invitations where token_hash = tok), 'le jeton en clair n''existe nulle part'); total := total + 1;

  perform pg_temp.chk(jsonb_array_length(pg_temp.call(a, format('select coalesce(jsonb_agg(i), ''[]'') from public.workspace_invitations i where workspace_id = %L', w))) = 1, 'l''admin voit ses invitations'); total := total + 1;
  perform pg_temp.chk(jsonb_array_length(pg_temp.call(e, format('select coalesce(jsonb_agg(i), ''[]'') from public.workspace_invitations i where workspace_id = %L', w))) = 0, 'un éditeur ne voit aucune invitation'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('insert into public.workspace_invitations (workspace_id, email, role, token_hash, created_by, expires_at) values (%L, ''z@z.fr'', ''admin'', repeat(''a'', 64), %L, now())', w, a)), 'aucune insertion directe'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('update public.workspace_invitations set role = ''admin'' where id = %L', inv)), 'aucune modification directe'); total := total + 1;

  perform pg_temp.chk(pg_temp.fails(c, format('select public.accept_invitation(%L)', tok), 'invitation_invalid'), 'un autre compte ne peut pas utiliser le jeton'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(b, 'select public.accept_invitation(''0000'')', 'invitation_invalid'), 'jeton inconnu'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(b, 'select public.accept_invitation(null)', 'invitation_invalid'), 'jeton nul'); total := total + 1;
  perform pg_temp.chk(not exists (select 1 from public.workspace_members where workspace_id = w and user_id in (b, c)), 'les échecs n''ajoutent personne'); total := total + 1;
  r := pg_temp.call(b, format('select public.accept_invitation(%L)', '  ' || tok || ' '));
  perform pg_temp.chk(r ->> 'role' = 'editor' and (r ->> 'workspace_id')::uuid = w and r ->> 'name' = 'Équipe', 'acceptation par le bon compte'); total := total + 1;
  perform pg_temp.chk((select role from public.workspace_members where workspace_id = w and user_id = b) = 'editor', 'membre créé avec le bon rôle'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(b, format('select public.accept_invitation(%L)', tok), 'invitation_invalid'), 'usage unique'); total := total + 1;
  perform pg_temp.chk((select accepted_by from public.workspace_invitations where id = inv) = b, 'invitation marquée acceptée par b'); total := total + 1;

  perform pg_temp.chk(jsonb_array_length(pg_temp.call(b, format('select public.sync_pull(%L, 0, 0, 10) -> ''nodes''', w))) = 0, 'b peut lire l''espace'); total := total + 1;
  r := pg_temp.call(b, format('select public.sync_push(%L, %L::jsonb)', w, jsonb_build_array(jsonb_build_object('op_id', gen_random_uuid(), 'entity', 'node', 'entity_id', gen_random_uuid(), 'fields', '{"kind":"page","title":"Écrit par b","position":"V1","parent_id":null}'::jsonb, 'clock', '{"ms":1,"device":"d"}'::jsonb))::text));
  perform pg_temp.chk(r -> 0 ->> 'status' = 'applied', 'b (éditeur) peut écrire'); total := total + 1;
  perform pg_temp.chk((select created_by from public.nodes where title = 'Écrit par b') = b, 'auteur = b'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(b, format('select public.create_invitation(%L, ''q@q.fr'', ''viewer'')', w), 'forbidden', '42501'), 'un éditeur invité ne peut pas inviter'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(b, format('select public.sync_pull(%L, 0, 0, 10)', w2), 'forbidden', '42501'), 'l''autre espace reste fermé'); total := total + 1;

  r := pg_temp.mk(a, w, 'c@test.invalid', 'viewer'); tok := r ->> 'token'; inv := (r ->> 'id')::uuid;
  update public.workspace_invitations set expires_at = now() - interval '1 second' where id = inv;
  perform pg_temp.chk(pg_temp.fails(c, format('select public.accept_invitation(%L)', tok), 'invitation_invalid'), 'invitation expirée'); total := total + 1;
  r := pg_temp.mk(a, w, 'c@test.invalid', 'viewer'); tok := r ->> 'token'; inv := (r ->> 'id')::uuid;
  perform pg_temp.call(a, format('select to_jsonb(public.revoke_invitation(%L)::text)', inv));
  perform pg_temp.chk(pg_temp.fails(c, format('select public.accept_invitation(%L)', tok), 'invitation_invalid'), 'invitation révoquée'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(e, format('select public.revoke_invitation(%L)', inv), 'forbidden', '42501'), 'un éditeur ne révoque pas'); total := total + 1;
  r := pg_temp.mk(a, w, 'c@test.invalid', 'viewer'); tok := r ->> 'token';
  r := pg_temp.mk(a, w, 'c@test.invalid', 'admin'); tok2 := r ->> 'token';
  perform pg_temp.chk(pg_temp.fails(c, format('select public.accept_invitation(%L)', tok), 'invitation_invalid'), 'une nouvelle invitation remplace l''ancienne'); total := total + 1;
  r := pg_temp.call(c, format('select public.accept_invitation(%L)', tok2));
  perform pg_temp.chk(r ->> 'role' = 'admin', 'la nouvelle invitation fonctionne (admin)'); total := total + 1;

  r := pg_temp.mk(a, w, 'ed@test.invalid', 'viewer');
  r := pg_temp.call(e, format('select public.accept_invitation(%L)', r ->> 'token'));
  perform pg_temp.chk(r ->> 'role' = 'editor', 'pas de rétrogradation par invitation'); total := total + 1;
  r := pg_temp.mk(a, w, 'ed@test.invalid', 'admin');
  r := pg_temp.call(e, format('select public.accept_invitation(%L)', r ->> 'token'));
  perform pg_temp.chk(r ->> 'role' = 'admin', 'promotion par invitation'); total := total + 1;

  r := pg_temp.call(b, format('select public.list_members(%L)', w));
  perform pg_temp.chk(jsonb_array_length(r) = 5 and r @> '[{"email":"a@test.invalid"}]'::jsonb, 'un membre liste les membres avec leur adresse'); total := total + 1;
  perform pg_temp.chk((select count(*) from jsonb_array_elements(r) x where (x ->> 'is_me')::boolean) = 1, 'is_me'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(c, format('select public.list_members(%L)', w2), 'forbidden', '42501') , 'un non-membre ne liste pas'); total := total + 1;
  perform pg_temp.chk(pg_temp.call(a, format('with u as (update public.workspace_members set role = ''viewer'' where workspace_id = %L and user_id = %L returning 1) select to_jsonb(count(*)) from u', w, b)) = '1'::jsonb, 'un admin change un rôle'); total := total + 1;
  perform pg_temp.chk(pg_temp.call(b, format('with u as (update public.workspace_members set role = ''admin'' where workspace_id = %L and user_id = %L returning 1) select to_jsonb(count(*)) from u', w, b)) = '0'::jsonb, 'un non-admin ne s''élève pas'); total := total + 1;
  perform pg_temp.chk(pg_temp.call(a, format('with d as (delete from public.workspace_members where workspace_id = %L and user_id = %L returning 1) select to_jsonb(count(*)) from d', w, b)) = '1'::jsonb, 'un admin retire un membre'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(b, format('select public.sync_pull(%L, 0, 0, 10)', w), 'forbidden', '42501'), 'accès coupé immédiatement après le retrait'); total := total + 1;

  for i in 1..50 loop perform pg_temp.mk(a, w, format('u%s@test.invalid', i), 'viewer'); end loop;
  perform pg_temp.chk(pg_temp.fails(a, format('select public.create_invitation(%L, ''trop@test.invalid'', ''viewer'')', w), 'too_many_invitations', '54000'), 'plafond de 50 invitations en attente'); total := total + 1;

  begin
    set local role anon;
    perform public.accept_invitation('x');
    raise exception 'ECHEC: anon accepte';
  exception when insufficient_privilege then null;
  end;
  reset role; total := total + 1;

  raise exception 'TESTS_OK: % assertions', total;
end
$outer$;
