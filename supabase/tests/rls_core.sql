-- Tests RLS de la migration 1 (à exécuter sur un Postgres Supabase ; tout est annulé à la fin par une exception volontaire).
-- Résultat attendu : ERROR "TESTS_OK: <n> assertions". Toute autre erreur = échec (message « ECHEC: … »).
do $outer$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  w uuid := gen_random_uuid(); w2 uuid := gen_random_uuid();
  n1 uuid := gen_random_uuid(); n2 uuid := gen_random_uuid();
  total int := 0; v bigint;
begin
  create function pg_temp.chk(cond boolean, msg text) returns void language plpgsql as $f$
  begin if cond is not true then raise exception 'ECHEC: %', msg; end if; end $f$;
  -- exécute `q` en tant que `u` ; retourne le nombre de lignes affectées/retournées
  create function pg_temp.run(u uuid, q text) returns bigint language plpgsql as $f$
  declare n bigint;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    set local role authenticated;
    execute q;
    get diagnostics n = row_count;
    reset role;
    return n;
  end $f$;
  create function pg_temp.cnt(u uuid, q text) returns bigint language plpgsql as $f$
  declare n bigint;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    set local role authenticated;
    execute 'select count(*) from (' || q || ') s' into n;
    reset role;
    return n;
  end $f$;
  -- vrai si `q` échoue avec le SQLSTATE attendu
  create function pg_temp.fails(u uuid, q text, state text default '42501') returns boolean language plpgsql as $f$
  declare r boolean;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true);
    begin
      set local role authenticated;
      execute q;
      r := false;
    exception when others then
      r := (sqlstate = state);
    end;
    reset role;
    return r;
  end $f$;

  insert into auth.users (id, email) values (a, 'a@test.invalid'), (b, 'b@test.invalid'), (c, 'c@test.invalid');
  perform pg_temp.chk((select count(*) from public.profiles where id in (a, b, c)) = 3, 'profil créé automatiquement'); total := total + 1;

  -- A crée un espace : il en devient administrateur.
  perform pg_temp.chk(pg_temp.run(a, format('insert into public.workspaces (id, name, owner_id) values (%L, ''Équipe'', %L)', w, a)) = 1, 'A crée un espace'); total := total + 1;
  perform pg_temp.chk((select role from public.workspace_members where workspace_id = w and user_id = a) = 'admin', 'créateur = admin'); total := total + 1;
  perform pg_temp.chk(pg_temp.cnt(a, format('select 1 from public.workspaces where id = %L', w)) = 1, 'A voit son espace'); total := total + 1;
  perform pg_temp.chk(pg_temp.cnt(b, 'select 1 from public.workspaces') = 0, 'B ne voit pas l''espace de A'); total := total + 1;

  -- Usurpation de propriétaire refusée.
  perform pg_temp.chk(pg_temp.fails(b, format('insert into public.workspaces (name, owner_id) values (''Vol'', %L)', a)), 'B ne peut pas créer un espace au nom de A'); total := total + 1;

  -- Données de A.
  perform pg_temp.chk(pg_temp.run(a, format('insert into public.nodes (id, workspace_id, kind, title, position) values (%L, %L, ''page'', ''Secret'', ''V0000000'')', n1, w)) = 1, 'A crée une page'); total := total + 1;
  perform pg_temp.chk(pg_temp.cnt(b, 'select 1 from public.nodes') = 0, 'B (non membre) ne lit aucun nœud'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(b, format('insert into public.nodes (workspace_id, kind, position) values (%L, ''page'', ''V0000001'')', w)), 'B (non membre) ne peut pas écrire'); total := total + 1;
  perform pg_temp.chk(pg_temp.run(b, format('update public.nodes set title = ''piraté'' where id = %L', n1)) = 0, 'B (non membre) ne modifie rien'); total := total + 1;
  perform pg_temp.chk(pg_temp.run(b, format('delete from public.nodes where id = %L', n1)) = 0, 'B (non membre) ne supprime rien'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(b, format('insert into public.workspace_members (workspace_id, user_id, role) values (%L, %L, ''admin'')', w, b)), 'B ne peut pas s''ajouter lui-même'); total := total + 1;

  -- A invite B en lecture.
  perform pg_temp.chk(pg_temp.run(a, format('insert into public.workspace_members (workspace_id, user_id, role) values (%L, %L, ''viewer'')', w, b)) = 1, 'A ajoute B en lecture'); total := total + 1;
  perform pg_temp.chk(pg_temp.cnt(b, format('select 1 from public.nodes where workspace_id = %L', w)) = 1, 'B (lecteur) lit'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(b, format('insert into public.nodes (workspace_id, kind, position) values (%L, ''page'', ''V0000002'')', w)), 'B (lecteur) n''écrit pas'); total := total + 1;
  perform pg_temp.chk(pg_temp.run(b, format('update public.nodes set title = ''x'' where id = %L', n1)) = 0, 'B (lecteur) ne modifie pas'); total := total + 1;
  perform pg_temp.chk(pg_temp.cnt(b, format('select 1 from public.profiles where id = %L', a)) = 1, 'B voit le profil de A (espace commun)'); total := total + 1;
  perform pg_temp.chk(pg_temp.cnt(c, format('select 1 from public.profiles where id = %L', a)) = 0, 'C ne voit pas le profil de A'); total := total + 1;
  perform pg_temp.chk(pg_temp.run(b, format('update public.workspaces set name = ''x'' where id = %L', w)) = 0, 'B (lecteur) ne renomme pas l''espace'); total := total + 1;

  -- B devient éditeur.
  perform pg_temp.chk(pg_temp.run(a, format('update public.workspace_members set role = ''editor'' where workspace_id = %L and user_id = %L', w, b)) = 1, 'A promeut B éditeur'); total := total + 1;
  perform pg_temp.chk(pg_temp.run(b, format('insert into public.nodes (id, workspace_id, kind, title, position) values (%L, %L, ''page'', ''De B'', ''V0000003'')', n2, w)) = 1, 'B (éditeur) crée'); total := total + 1;
  perform pg_temp.chk(pg_temp.run(b, format('update public.nodes set title = ''Modifié'' where id = %L', n1)) = 1, 'B (éditeur) modifie'); total := total + 1;
  perform pg_temp.chk(pg_temp.run(b, format('delete from public.nodes where id = %L', n1)) = 0, 'B (éditeur) ne supprime pas définitivement'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(b, format('insert into public.workspace_members (workspace_id, user_id, role) values (%L, %L, ''viewer'')', w, c)), 'B (éditeur) n''invite pas'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(b, format('insert into public.nodes (workspace_id, kind, position, created_by) values (%L, ''page'', ''V0000004'', %L)', w, a)), 'B ne peut pas écrire au nom de A (created_by)'); total := total + 1;

  -- Isolation entre espaces et intégrité de l'arbre.
  perform pg_temp.run(a, format('insert into public.workspaces (id, name, owner_id) values (%L, ''Autre'', %L)', w2, a));
  perform pg_temp.chk(pg_temp.fails(a, format('update public.nodes set workspace_id = %L where id = %L', w2, n1)), 'workspace_id immuable'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('insert into public.nodes (workspace_id, parent_id, kind, position) values (%L, %L, ''page'', ''V0000005'')', w2, n1), '23514'), 'un parent doit appartenir au même espace'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('update public.workspaces set owner_id = %L where id = %L', b, w)), 'owner_id immuable'); total := total + 1;
  perform pg_temp.chk(pg_temp.cnt(b, format('select 1 from public.nodes where workspace_id = %L', w2)) = 0, 'B ne voit pas l''autre espace'); total := total + 1;

  -- Administrateurs : le dernier ne peut pas partir.
  perform pg_temp.chk(pg_temp.fails(a, format('delete from public.workspace_members where workspace_id = %L and user_id = %L', w, a), '23514'), 'le dernier admin ne peut pas partir'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('update public.workspace_members set role = ''viewer'' where workspace_id = %L and user_id = %L', w, a), '23514'), 'le dernier admin ne peut pas être rétrogradé'); total := total + 1;
  perform pg_temp.chk(pg_temp.run(b, format('delete from public.workspace_members where workspace_id = %L and user_id = %L', w, b)) = 1, 'B peut quitter l''espace'); total := total + 1;
  perform pg_temp.chk(pg_temp.cnt(b, format('select 1 from public.nodes where workspace_id = %L', w)) = 0, 'B n''a plus accès après son départ'); total := total + 1;

  -- Profils : modification limitée au sien.
  perform pg_temp.chk(pg_temp.run(a, format('update public.profiles set display_name = ''Alice'' where id = %L', a)) = 1, 'A modifie son profil'); total := total + 1;
  perform pg_temp.chk(pg_temp.run(a, format('update public.profiles set display_name = ''X'' where id = %L', b)) = 0, 'A ne modifie pas le profil de B'); total := total + 1;
  perform pg_temp.chk(pg_temp.fails(a, format('update public.profiles set locale = ''de'' where id = %L', a), '23514'), 'langue invalide refusée'); total := total + 1;

  -- Anonyme : aucun accès.
  set local role anon;
  begin
    perform 1 from public.nodes limit 1;
    raise exception 'ECHEC: anon peut lire nodes';
  exception when insufficient_privilege then null;
  end;
  reset role;
  total := total + 1;

  -- Suppression de l'espace par son propriétaire seulement, en cascade.
  perform pg_temp.chk(pg_temp.run(b, format('delete from public.workspaces where id = %L', w)) = 0, 'B ne supprime pas l''espace'); total := total + 1;
  perform pg_temp.chk(pg_temp.run(a, format('delete from public.workspaces where id = %L', w)) = 1, 'A supprime son espace'); total := total + 1;
  perform pg_temp.chk((select count(*) from public.nodes where workspace_id = w) = 0, 'suppression en cascade'); total := total + 1;

  raise exception 'TESTS_OK: % assertions', total;
end
$outer$;
