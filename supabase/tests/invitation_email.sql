-- Tests de la migration 8 (envoi des invitations par e-mail : réservation et limites). Même convention que rls_core.sql :
-- résultat attendu = ERROR "TESTS_OK: <n> assertions" (tout est annulé par cette exception volontaire).
do $outer$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid(); d uuid := gen_random_uuid();
  w uuid := gen_random_uuid(); w2 uuid := gen_random_uuid();
  tok text; inv uuid; root uuid := gen_random_uuid(); pg uuid := gen_random_uuid(); th uuid := gen_random_uuid(); th2 uuid := gen_random_uuid(); c1 uuid := gen_random_uuid(); c2 uuid := gen_random_uuid(); c3 uuid := gen_random_uuid(); ghost uuid := gen_random_uuid();
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

  insert into auth.users (id, email) values (a, 'a@test.invalid'), (b, 'b@test.invalid'), (c, 'c@test.invalid'), (d, 'd@test.invalid');
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.workspaces (id, name, owner_id) values (w, 'Équipe <b>', a), (w2, 'Autre', a);
  reset role;
  insert into public.workspace_members (workspace_id, user_id, role) values (w, c, 'viewer'), (w, b, 'editor');

  r := pg_temp.call(a, format('select public.create_invitation(%L, %L, %L, 168)', w, 'bob@example.com', 'editor'));
  tok := r ->> 'token'; inv := (r ->> 'id')::uuid;
  perform pg_temp.chk(tok ~ '^[0-9a-f]{64}$', 'invitation créée'); total := total + 1;

  -- Réservation par l'administrateur : le destinataire vient de l'INVITATION, jamais du client.
  r := pg_temp.call(a, format('select public.claim_invitation_email(%L)', ' ' || tok || ' '));
  perform pg_temp.chk(r ->> 'email' = 'bob@example.com' and r ->> 'role' = 'editor' and r ->> 'id' = inv::text, 'destinataire lu dans l''invitation'); total := total + 1;
  perform pg_temp.chk(r ->> 'workspace_name' = 'Équipe <b>', 'nom de l''espace renvoyé tel quel (l''échappement est fait à l''envoi)'); total := total + 1;
  perform pg_temp.chk(r ->> 'inviter' = a::text || '@test.invalid' or (r ->> 'inviter') <> '', 'invitant identifié'); total := total + 1;
  perform pg_temp.chk((select email_count from public.workspace_invitations where id = inv) = 1, 'compteur = 1'); total := total + 1;

  -- Limites : pas deux envois à moins d'une minute, au plus trois par invitation.
  perform pg_temp.chk(pg_temp.fails(a, format('select public.claim_invitation_email(%L)', tok), '54000'), 'deuxième envoi immédiat refusé'); total := total + 1;
  update public.workspace_invitations set emailed_at = now() - interval '2 minutes' where id = inv;
  r := pg_temp.call(a, format('select public.claim_invitation_email(%L)', tok));
  perform pg_temp.chk((select email_count from public.workspace_invitations where id = inv) = 2, 'deuxième envoi après une minute'); total := total + 1;
  update public.workspace_invitations set emailed_at = now() - interval '2 minutes' where id = inv;
  r := pg_temp.call(a, format('select public.claim_invitation_email(%L)', tok));
  update public.workspace_invitations set emailed_at = now() - interval '2 minutes' where id = inv;
  perform pg_temp.chk(pg_temp.fails(a, format('select public.claim_invitation_email(%L)', tok), '54000'), 'plafond de 3 envois'); total := total + 1;
  perform pg_temp.chk((select email_count from public.workspace_invitations where id = inv) = 3, 'compteur plafonné à 3'); total := total + 1;

  -- Rendre une réservation (échec du fournisseur) : le compteur redescend et l'envoi redevient possible.
  perform pg_temp.call(a, format('select to_jsonb(1) from (select public.release_invitation_email(%L)) x', inv));
  perform pg_temp.chk((select email_count from public.workspace_invitations where id = inv) = 2 and (select emailed_at from public.workspace_invitations where id = inv) is null, 'réservation rendue'); total := total + 1;
  r := pg_temp.call(a, format('select public.claim_invitation_email(%L)', tok));
  perform pg_temp.chk(r ->> 'email' = 'bob@example.com', 'envoi à nouveau possible'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(b, format('select to_jsonb(1) from (select public.release_invitation_email(%L)) x', inv)), 'un éditeur ne rend pas la réservation'); total := total + 1;

  -- Droits : seuls les administrateurs de l'espace ; même erreur pour un jeton inconnu (aucun oracle).
  r := pg_temp.call(a, format('select public.create_invitation(%L, %L, %L, 168)', w, 'carol@example.com', 'viewer'));
  tok := r ->> 'token'; inv := (r ->> 'id')::uuid;
  perform pg_temp.chk(pg_temp.fails(b, format('select public.claim_invitation_email(%L)', tok)), 'éditeur refusé'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(c, format('select public.claim_invitation_email(%L)', tok)), 'lecteur refusé'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(d, format('select public.claim_invitation_email(%L)', tok)), 'extérieur refusé'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('select public.claim_invitation_email(%L)', repeat('0', 64))), 'jeton inconnu : même erreur'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('select public.claim_invitation_email(%L)', repeat('x', 300))), 'jeton démesuré refusé'); total := total + 1;
  perform pg_temp.chk((select email_count from public.workspace_invitations where id = inv) = 0, 'aucune réservation par les refus'); total := total + 1;

  -- Invitation révoquée, expirée ou acceptée : plus d'envoi.
  perform pg_temp.call(a, format('select to_jsonb(1) from (select public.revoke_invitation(%L)) x', inv));
  perform pg_temp.chk(pg_temp.fails(a, format('select public.claim_invitation_email(%L)', tok), 'P0001'), 'révoquée : pas d''envoi'); total := total + 1;
  r := pg_temp.call(a, format('select public.create_invitation(%L, %L, %L, 168)', w, 'dan@example.com', 'editor'));
  tok := r ->> 'token'; inv := (r ->> 'id')::uuid;
  update public.workspace_invitations set expires_at = now() - interval '1 hour' where id = inv;
  perform pg_temp.chk(pg_temp.fails(a, format('select public.claim_invitation_email(%L)', tok), 'P0001'), 'expirée : pas d''envoi'); total := total + 1;
  r := pg_temp.call(a, format('select public.create_invitation(%L, %L, %L, 168)', w, 'eve@example.com', 'editor'));
  tok := r ->> 'token'; inv := (r ->> 'id')::uuid;
  update public.workspace_invitations set accepted_at = now() where id = inv;
  perform pg_temp.chk(pg_temp.fails(a, format('select public.claim_invitation_email(%L)', tok), 'P0001'), 'acceptée : pas d''envoi'); total := total + 1;

  begin
    set local role anon;
    perform public.claim_invitation_email('x');
    raise exception 'ECHEC: anon réserve un envoi';
  exception when insufficient_privilege then null;
  end;
  reset role;
  total := total + 1;

  raise exception 'TESTS_OK: % assertions', total;
end
$outer$;
