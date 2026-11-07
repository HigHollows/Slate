-- Envoi des invitations par e-mail. Voir docs/COLLABORATION.md.
-- La fonction Edge `send-invitation` n'a AUCUN pouvoir propre : elle agit avec le jeton de l'appelant. Le destinataire n'est
-- jamais fourni par le client : il est lu ICI, dans l'invitation. Cette fonction « réserve » un envoi (limites) et renvoie ce
-- qu'il faut pour écrire le message ; en cas d'échec d'envoi la réservation est rendue.
alter table public.workspace_invitations
  add column emailed_at timestamptz,
  add column email_count int not null default 0 check (email_count between 0 and 3);

create function public.claim_invitation_email(p_token text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  inv public.workspace_invitations; ws_name text; inviter text;
begin
  if (select auth.uid()) is null or p_token is null or char_length(p_token) > 200 then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into inv from public.workspace_invitations
   where token_hash = encode(sha256(convert_to(btrim(p_token), 'UTF8')), 'hex') for update;
  -- Mêmes réponses pour « jeton inconnu » et « pas administrateur » : pas d'oracle sur l'existence d'un jeton.
  if not found or not private.has_role(inv.workspace_id, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if inv.accepted_at is not null or inv.revoked_at is not null or inv.expires_at <= now() then
    raise exception 'invitation_invalid' using errcode = 'P0001';
  end if;
  -- Au plus 3 envois par invitation, et pas deux envois à moins d'une minute d'écart.
  if inv.email_count >= 3 or (inv.emailed_at is not null and inv.emailed_at > now() - interval '1 minute') then
    raise exception 'rate_limited' using errcode = '54000';
  end if;
  update public.workspace_invitations set emailed_at = now(), email_count = email_count + 1 where id = inv.id;
  select name into ws_name from public.workspaces where id = inv.workspace_id;
  select coalesce(nullif(btrim(p.display_name), ''), (select auth.jwt() ->> 'email'), '') into inviter
    from (select 1) x left join public.profiles p on p.id = (select auth.uid());
  return jsonb_build_object('id', inv.id, 'email', inv.email, 'role', inv.role, 'workspace_name', coalesce(ws_name, ''),
    'inviter', left(coalesce(inviter, ''), 200), 'expires_at', inv.expires_at);
end $$;

-- Rend la réservation quand l'envoi a échoué (le fournisseur n'a rien accepté).
create function public.release_invitation_email(p_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare ws uuid;
begin
  select workspace_id into ws from public.workspace_invitations where id = p_id;
  if ws is null or (select auth.uid()) is null or not private.has_role(ws, 'admin') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update public.workspace_invitations set email_count = greatest(email_count - 1, 0), emailed_at = null where id = p_id;
end $$;

revoke execute on function public.claim_invitation_email(text), public.release_invitation_email(uuid) from public, anon;
grant execute on function public.claim_invitation_email(text), public.release_invitation_email(uuid) to authenticated;
