-- Présence et curseurs en direct : canaux Realtime PRIVÉS, un par page, sujet « doc:<espace>:<page> ».
-- Sans politique sur `realtime.messages`, tout canal privé est refusé : on n'autorise que
--   * recevoir  (select) : lecteurs, éditeurs, administrateurs de l'espace ;
--   * envoyer   (insert) : éditeurs et administrateurs (un lecteur regarde, il n'écrit pas dans le document).
-- La page doit exister dans l'espace nommé par le sujet. Seule l'extension « broadcast » est ouverte (pas de présence
-- Realtime native, pas de changements Postgres) : la présence est portée par nos propres messages.
create function private.realtime_doc_allowed(p_topic text, p_min public.workspace_role) returns boolean
language plpgsql stable set search_path = '' as $$
declare ws uuid; pg uuid;
begin
  if p_topic is null or p_topic !~ '^doc:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  ws := split_part(p_topic, ':', 2)::uuid;
  pg := split_part(p_topic, ':', 3)::uuid;
  return private.has_role(ws, p_min)
     and exists (select 1 from public.nodes n where n.id = pg and n.workspace_id = ws and n.kind = 'page' and n.purged_at is null);
end $$;
revoke execute on function private.realtime_doc_allowed(text, public.workspace_role) from public, anon;
grant execute on function private.realtime_doc_allowed(text, public.workspace_role) to authenticated;

create policy realtime_doc_receive on realtime.messages for select to authenticated
  using (extension = 'broadcast' and private.realtime_doc_allowed((select realtime.topic()), 'viewer'));
create policy realtime_doc_send on realtime.messages for insert to authenticated
  with check (extension = 'broadcast' and private.realtime_doc_allowed((select realtime.topic()), 'editor'));
