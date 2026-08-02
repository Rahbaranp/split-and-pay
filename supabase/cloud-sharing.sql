-- Permanent private links and participant identity.
-- Run once in the Supabase SQL Editor.

alter table public.participants add column if not exists claimed_at timestamptz;

create or replace function public.create_bill_share(p_bill_id uuid)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  raw_token text := encode(gen_random_bytes(24), 'hex');
begin
  if not exists (select 1 from public.bills where id = p_bill_id and owner_id = auth.uid()) then
    raise exception 'Only the bill owner can create a sharing link';
  end if;
  update public.share_tokens set revoked_at = now() where bill_id = p_bill_id and revoked_at is null;
  insert into public.share_tokens (bill_id, token_hash)
  values (p_bill_id, encode(digest(raw_token, 'sha256'), 'hex'));
  return raw_token;
end;
$$;

drop function if exists public.open_shared_bill(text);
create function public.open_shared_bill(p_token text)
returns table (bill_id uuid, title text, status text, settings jsonb, updated_at timestamptz, claimed_names jsonb)
language sql
security definer
set search_path = public, extensions
as $$
  select b.id, b.title, b.status, b.settings, b.updated_at,
    coalesce((select jsonb_agg(p.name) from public.participants p where p.bill_id = b.id and p.participant_token_hash is not null and p.claimed_at > now() - interval '90 seconds'), '[]'::jsonb)
  from public.share_tokens s
  join public.bills b on b.id = s.bill_id
  where s.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > now())
  limit 1;
$$;

create or replace function public.claim_bill_participant(p_token text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target_bill public.bills%rowtype;
  person jsonb;
  participant_uuid uuid;
  raw_edit_token text := encode(gen_random_bytes(24), 'hex');
begin
  select b.* into target_bill
  from public.share_tokens s join public.bills b on b.id = s.bill_id
  where s.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and s.revoked_at is null and b.status = 'open'
  limit 1;
  if target_bill.id is null then raise exception 'This sharing link is invalid or closed'; end if;

  -- Serialize claims for the same bill/name so simultaneous devices cannot
  -- both observe the name as available.
  perform pg_advisory_xact_lock(hashtextextended(target_bill.id::text || ':' || lower(trim(p_name)), 0));

  select value into person
  from jsonb_array_elements(coalesce(target_bill.settings->'draft'->'people', '[]'::jsonb))
  where lower(value->>'name') = lower(trim(p_name)) limit 1;
  if person is null then raise exception 'Choose a person already listed on this bill'; end if;

  select id into participant_uuid from public.participants
  where bill_id = target_bill.id and lower(name) = lower(trim(p_name)) limit 1;
  if participant_uuid is null then
    insert into public.participants (bill_id, name, color, participant_token_hash)
    values (target_bill.id, person->>'name', coalesce(person->>'color','#67d99a'), encode(digest(raw_edit_token,'sha256'),'hex'))
    returning id into participant_uuid;
    update public.participants set claimed_at = now() where id = participant_uuid;
  else
    if exists (select 1 from public.participants where id = participant_uuid and participant_token_hash is not null and claimed_at > now() - interval '90 seconds') then
      raise exception 'That name is already in use on another device';
    end if;
    update public.participants set participant_token_hash = encode(digest(raw_edit_token,'sha256'),'hex'), claimed_at = now() where id = participant_uuid;
  end if;
  return jsonb_build_object('participant_id', participant_uuid, 'edit_token', raw_edit_token, 'name', person->>'name');
end;
$$;

grant execute on function public.create_bill_share(uuid) to authenticated;
grant execute on function public.open_shared_bill(text) to anon, authenticated;
grant execute on function public.claim_bill_participant(text,text) to anon, authenticated;

create or replace function public.release_bill_participant(p_token text, p_participant_id uuid, p_edit_token text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare target_bill_id uuid;
begin
  select b.id into target_bill_id from public.share_tokens s join public.bills b on b.id=s.bill_id
  where s.token_hash=encode(digest(p_token,'sha256'),'hex') and s.revoked_at is null limit 1;
  update public.participants set participant_token_hash=null, claimed_at=null
  where id=p_participant_id and bill_id=target_bill_id
    and participant_token_hash=encode(digest(p_edit_token,'sha256'),'hex');
  return found;
end; $$;
grant execute on function public.release_bill_participant(text,uuid,text) to anon, authenticated;

create or replace function public.heartbeat_bill_participant(p_token text, p_participant_id uuid, p_edit_token text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare target_bill_id uuid;
begin
  select b.id into target_bill_id from public.share_tokens s join public.bills b on b.id=s.bill_id
  where s.token_hash=encode(digest(p_token,'sha256'),'hex') and s.revoked_at is null limit 1;
  update public.participants set claimed_at=now()
  where id=p_participant_id and bill_id=target_bill_id
    and participant_token_hash=encode(digest(p_edit_token,'sha256'),'hex');
  return found;
end; $$;
grant execute on function public.heartbeat_bill_participant(text,uuid,text) to anon, authenticated;

create or replace function public.set_participant_assignment(
  p_token text, p_participant_id uuid, p_edit_token text, p_item_id text, p_selected boolean
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  target_bill public.bills%rowtype;
  target_participant public.participants%rowtype;
  current_draft jsonb;
  current_item jsonb;
  updated_item jsonb;
  updated_expenses jsonb := '[]'::jsonb;
  guest_person_id text;
  consumers jsonb;
begin
  select b.* into target_bill from public.share_tokens s join public.bills b on b.id=s.bill_id
  where s.token_hash=encode(digest(p_token,'sha256'),'hex') and s.revoked_at is null limit 1 for update of b;
  if target_bill.id is null or target_bill.status <> 'open' then raise exception 'This bill is closed or unavailable'; end if;
  select * into target_participant from public.participants where id=p_participant_id and bill_id=target_bill.id
    and participant_token_hash=encode(digest(p_edit_token,'sha256'),'hex');
  if target_participant.id is null then raise exception 'Your participant access has expired'; end if;
  current_draft := target_bill.settings->'draft';
  select value->>'id' into guest_person_id from jsonb_array_elements(coalesce(current_draft->'people','[]'::jsonb))
    where lower(value->>'name')=lower(target_participant.name) limit 1;
  if guest_person_id is null then raise exception 'Participant is no longer on this bill'; end if;
  for current_item in select value from jsonb_array_elements(coalesce(current_draft->'expenses','[]'::jsonb)) loop
    updated_item := current_item;
    if current_item->>'id'=p_item_id then
      select coalesce(jsonb_agg(value),'[]'::jsonb) into consumers from jsonb_array_elements(coalesce(current_item->'consumers','[]'::jsonb))
        where value #>> '{}' <> guest_person_id;
      if p_selected then consumers := consumers || jsonb_build_array(guest_person_id); end if;
      updated_item := jsonb_set(current_item,'{consumers}',consumers,true);
    end if;
    updated_expenses := updated_expenses || jsonb_build_array(updated_item);
  end loop;
  current_draft := jsonb_set(current_draft,'{expenses}',updated_expenses,true);
  update public.bills set settings=jsonb_set(settings,'{draft}',current_draft,true), updated_at=now() where id=target_bill.id;
  update public.participants set claimed_at=now() where id=target_participant.id;
  return current_draft;
end; $$;
grant execute on function public.set_participant_assignment(text,uuid,text,text,boolean) to anon, authenticated;

-- Atomically update only the current participant's quantity for one item.
create or replace function public.set_participant_item_quantity(
  p_token text, p_participant_id uuid, p_edit_token text, p_item_id text, p_quantity integer
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  target_bill public.bills%rowtype;
  target_participant public.participants%rowtype;
  current_draft jsonb;
  current_item jsonb;
  updated_item jsonb;
  updated_expenses jsonb := '[]'::jsonb;
  guest_person_id text;
  consumers jsonb;
  quantities jsonb;
  safe_quantity integer := greatest(0, least(99, coalesce(p_quantity, 0)));
begin
  select b.* into target_bill from public.share_tokens s join public.bills b on b.id=s.bill_id
  where s.token_hash=encode(digest(p_token,'sha256'),'hex') and s.revoked_at is null limit 1 for update of b;
  if target_bill.id is null or target_bill.status <> 'open' then raise exception 'This bill is closed or unavailable'; end if;
  select * into target_participant from public.participants where id=p_participant_id and bill_id=target_bill.id
    and participant_token_hash=encode(digest(p_edit_token,'sha256'),'hex');
  if target_participant.id is null then raise exception 'Your participant access has expired'; end if;
  current_draft := target_bill.settings->'draft';
  select value->>'id' into guest_person_id from jsonb_array_elements(coalesce(current_draft->'people','[]'::jsonb))
    where lower(value->>'name')=lower(target_participant.name) limit 1;
  if guest_person_id is null then raise exception 'Participant is no longer on this bill'; end if;
  for current_item in select value from jsonb_array_elements(coalesce(current_draft->'expenses','[]'::jsonb)) loop
    updated_item := current_item;
    if current_item->>'id'=p_item_id then
      select coalesce(jsonb_agg(value),'[]'::jsonb) into consumers from jsonb_array_elements(coalesce(current_item->'consumers','[]'::jsonb))
        where value #>> '{}' <> guest_person_id;
      quantities := coalesce(current_item->'quantities','{}'::jsonb) - guest_person_id;
      if safe_quantity > 0 then
        consumers := consumers || jsonb_build_array(guest_person_id);
        quantities := jsonb_set(quantities,array[guest_person_id],to_jsonb(safe_quantity),true);
      end if;
      updated_item := jsonb_set(jsonb_set(current_item,'{consumers}',consumers,true),'{quantities}',quantities,true);
    end if;
    updated_expenses := updated_expenses || jsonb_build_array(updated_item);
  end loop;
  current_draft := jsonb_set(current_draft,'{expenses}',updated_expenses,true);
  update public.bills set settings=jsonb_set(settings,'{draft}',current_draft,true), updated_at=now() where id=target_bill.id;
  update public.participants set claimed_at=now() where id=target_participant.id;
  return current_draft;
end; $$;
grant execute on function public.set_participant_item_quantity(text,uuid,text,text,integer) to anon, authenticated;

create or replace function public.set_owner_item_quantity(
  p_bill_id uuid,
  p_item_id text,
  p_person_id text,
  p_quantity integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_bill public.bills%rowtype;
  current_draft jsonb;
  current_item jsonb;
  updated_item jsonb;
  updated_expenses jsonb := '[]'::jsonb;
  consumers jsonb;
  quantities jsonb;
  safe_quantity integer := greatest(0, least(99, coalesce(p_quantity, 0)));
begin
  select * into target_bill from public.bills
  where id = p_bill_id and owner_id = auth.uid()
  for update;
  if target_bill.id is null then raise exception 'Only the bill organizer can update this quantity'; end if;
  if target_bill.status <> 'open' then raise exception 'This bill is closed or unavailable'; end if;
  current_draft := target_bill.settings->'draft';
  for current_item in select value from jsonb_array_elements(coalesce(current_draft->'expenses', '[]'::jsonb))
  loop
    updated_item := current_item;
    if current_item->>'id' = p_item_id then
      select coalesce(jsonb_agg(value), '[]'::jsonb) into consumers
      from jsonb_array_elements(coalesce(current_item->'consumers', '[]'::jsonb))
      where value #>> '{}' <> p_person_id;
      quantities := coalesce(current_item->'quantities', '{}'::jsonb) - p_person_id;
      if safe_quantity > 0 then
        consumers := consumers || jsonb_build_array(p_person_id);
        quantities := jsonb_set(quantities, array[p_person_id], to_jsonb(safe_quantity), true);
      end if;
      updated_item := jsonb_set(jsonb_set(current_item, '{consumers}', consumers, true), '{quantities}', quantities, true);
    end if;
    updated_expenses := updated_expenses || jsonb_build_array(updated_item);
  end loop;
  current_draft := jsonb_set(current_draft, '{expenses}', updated_expenses, true);
  update public.bills set settings = jsonb_set(settings, '{draft}', current_draft, true), updated_at = now()
  where id = target_bill.id;
  return current_draft;
end;
$$;

revoke all on function public.set_owner_item_quantity(uuid,text,text,integer) from public, anon;
grant execute on function public.set_owner_item_quantity(uuid,text,text,integer) to authenticated;

-- Item owners control whether their own item is split equally or by quantity.
create or replace function public.set_participant_item_split_mode(
  p_token text, p_participant_id uuid, p_edit_token text, p_item_id text, p_split_equally boolean
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  target_bill public.bills%rowtype;
  target_participant public.participants%rowtype;
  current_draft jsonb;
  current_item jsonb;
  updated_item jsonb;
  updated_expenses jsonb := '[]'::jsonb;
  quantities jsonb;
begin
  select b.* into target_bill from public.share_tokens s join public.bills b on b.id=s.bill_id
  where s.token_hash=encode(digest(p_token,'sha256'),'hex') and s.revoked_at is null limit 1 for update of b;
  if target_bill.id is null or target_bill.status <> 'open' then raise exception 'This bill is closed or unavailable'; end if;
  select * into target_participant from public.participants where id=p_participant_id and bill_id=target_bill.id
    and participant_token_hash=encode(digest(p_edit_token,'sha256'),'hex');
  if target_participant.id is null then raise exception 'Your participant access has expired'; end if;
  current_draft := target_bill.settings->'draft';
  for current_item in select value from jsonb_array_elements(coalesce(current_draft->'expenses','[]'::jsonb)) loop
    updated_item := current_item;
    if current_item->>'id'=p_item_id then
      if coalesce(current_item->>'addedBy','organizer') <> p_participant_id::text then raise exception 'Only the item owner can change its split mode'; end if;
      select coalesce(jsonb_object_agg(value #>> '{}',1),'{}'::jsonb) into quantities
      from jsonb_array_elements(coalesce(current_item->'consumers','[]'::jsonb));
      updated_item := jsonb_set(jsonb_set(current_item,'{splitEqually}',to_jsonb(coalesce(p_split_equally,true)),true),'{quantities}',quantities,true);
    end if;
    updated_expenses := updated_expenses || jsonb_build_array(updated_item);
  end loop;
  current_draft := jsonb_set(current_draft,'{expenses}',updated_expenses,true);
  update public.bills set settings=jsonb_set(settings,'{draft}',current_draft,true), updated_at=now() where id=target_bill.id;
  return current_draft;
end; $$;
grant execute on function public.set_participant_item_split_mode(text,uuid,text,text,boolean) to anon, authenticated;

create or replace function public.save_participant_draft(
  p_token text,
  p_participant_id uuid,
  p_edit_token text,
  p_draft jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  target_bill public.bills%rowtype;
  target_participant public.participants%rowtype;
  old_draft jsonb;
  old_item jsonb;
  new_item jsonb;
  guest_person_id text;
  old_other jsonb;
  new_other jsonb;
begin
  select b.* into target_bill
  from public.share_tokens s join public.bills b on b.id = s.bill_id
  where s.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
  limit 1;
  if target_bill.id is null or target_bill.status <> 'open' then raise exception 'This bill is closed or unavailable'; end if;

  select * into target_participant from public.participants
  where id = p_participant_id and bill_id = target_bill.id
    and participant_token_hash = encode(digest(p_edit_token, 'sha256'), 'hex');
  if target_participant.id is null then raise exception 'Your participant access has expired'; end if;
  update public.participants set claimed_at = now() where id = target_participant.id;

  old_draft := target_bill.settings->'draft';
  select value->>'id' into guest_person_id
  from jsonb_array_elements(coalesce(old_draft->'people','[]'::jsonb))
  where lower(value->>'name') = lower(target_participant.name) limit 1;
  if guest_person_id is null then raise exception 'Participant is no longer on this bill'; end if;

  for new_item in select value from jsonb_array_elements(coalesce(p_draft->'expenses','[]'::jsonb)) loop
    select value into old_item from jsonb_array_elements(coalesce(old_draft->'expenses','[]'::jsonb)) where value->>'id' = new_item->>'id' limit 1;
    if old_item is null then
      if new_item->>'addedBy' <> p_participant_id::text then raise exception 'New items must belong to you'; end if;
    elsif coalesce(old_item->>'addedBy','organizer') <> p_participant_id::text then
      if old_item->>'name' is distinct from new_item->>'name'
        or old_item->>'cents' is distinct from new_item->>'cents'
        or coalesce(old_item->>'addedBy','organizer') is distinct from coalesce(new_item->>'addedBy','organizer')
      then raise exception 'You cannot edit another person''s item'; end if;
      select coalesce(jsonb_agg(value order by value::text),'[]'::jsonb) into old_other from jsonb_array_elements(coalesce(old_item->'consumers','[]'::jsonb)) where value #>> '{}' <> guest_person_id;
      select coalesce(jsonb_agg(value order by value::text),'[]'::jsonb) into new_other from jsonb_array_elements(coalesce(new_item->'consumers','[]'::jsonb)) where value #>> '{}' <> guest_person_id;
      if old_other <> new_other then raise exception 'You can change only your own item selection'; end if;
    end if;
  end loop;

  if exists (
    select 1 from jsonb_array_elements(coalesce(old_draft->'expenses','[]'::jsonb)) old
    where coalesce(old->>'addedBy','organizer') <> p_participant_id::text
      and not exists (select 1 from jsonb_array_elements(coalesce(p_draft->'expenses','[]'::jsonb)) new where new->>'id' = old->>'id')
  ) then raise exception 'You cannot delete another person''s item'; end if;

  old_draft := jsonb_set(old_draft, '{expenses}', coalesce(p_draft->'expenses','[]'::jsonb), true);
  update public.bills set settings = jsonb_set(settings, '{draft}', old_draft, true), updated_at = now() where id = target_bill.id;
  return old_draft;
end;
$$;

grant execute on function public.save_participant_draft(text,uuid,text,jsonb) to anon, authenticated;

-- Atomic participant merge. This replaces the earlier whole-array save so two
-- people can edit simultaneously without one participant deleting another's work.
create or replace function public.save_participant_draft(
  p_token text, p_participant_id uuid, p_edit_token text, p_draft jsonb
) returns jsonb
language plpgsql security definer
set search_path = public, extensions
as $$
declare
  target_bill public.bills%rowtype;
  target_participant public.participants%rowtype;
  old_draft jsonb;
  old_item jsonb;
  submitted_item jsonb;
  merged_item jsonb;
  merged_expenses jsonb := '[]'::jsonb;
  own_consumers jsonb;
  guest_person_id text;
  has_own_selection boolean;
begin
  select b.* into target_bill
  from public.share_tokens s join public.bills b on b.id = s.bill_id
  where s.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and s.revoked_at is null and (s.expires_at is null or s.expires_at > now())
  limit 1 for update of b;
  if target_bill.id is null or target_bill.status <> 'open' then raise exception 'This bill is closed or unavailable'; end if;

  select * into target_participant from public.participants
  where id = p_participant_id and bill_id = target_bill.id
    and participant_token_hash = encode(digest(p_edit_token, 'sha256'), 'hex');
  if target_participant.id is null then raise exception 'Your participant access has expired'; end if;

  old_draft := target_bill.settings->'draft';
  select value->>'id' into guest_person_id
  from jsonb_array_elements(coalesce(old_draft->'people','[]'::jsonb))
  where lower(value->>'name') = lower(target_participant.name) limit 1;
  if guest_person_id is null then raise exception 'Participant is no longer on this bill'; end if;

  -- Preserve every other participant's item. For those items, merge only this
  -- participant's own assignment checkbox. Replace/delete only owned items.
  for old_item in select value from jsonb_array_elements(coalesce(old_draft->'expenses','[]'::jsonb)) loop
    submitted_item := null;
    select value into submitted_item from jsonb_array_elements(coalesce(p_draft->'expenses','[]'::jsonb))
      where value->>'id' = old_item->>'id' limit 1;
    if coalesce(old_item->>'addedBy','organizer') = p_participant_id::text then
      if submitted_item is not null then
        -- The owner may edit the item's fields, but may never replace other
        -- participants' assignments with a stale consumers array.
        select exists(select 1 from jsonb_array_elements_text(coalesce(submitted_item->'consumers','[]'::jsonb)) x where x = guest_person_id) into has_own_selection;
        select coalesce(jsonb_agg(value),'[]'::jsonb) into own_consumers
        from jsonb_array_elements(coalesce(old_item->'consumers','[]'::jsonb)) where value #>> '{}' <> guest_person_id;
        if has_own_selection then own_consumers := own_consumers || jsonb_build_array(guest_person_id); end if;
        submitted_item := jsonb_set(submitted_item, '{consumers}', own_consumers, true);
        merged_expenses := merged_expenses || jsonb_build_array(submitted_item);
      else
        -- Absence from a potentially stale client snapshot is never a delete.
        merged_expenses := merged_expenses || jsonb_build_array(old_item);
      end if;
    else
      merged_item := old_item;
      if submitted_item is not null then
        select exists(select 1 from jsonb_array_elements_text(coalesce(submitted_item->'consumers','[]'::jsonb)) x where x = guest_person_id) into has_own_selection;
        select coalesce(jsonb_agg(value),'[]'::jsonb) into own_consumers
        from jsonb_array_elements(coalesce(old_item->'consumers','[]'::jsonb)) where value #>> '{}' <> guest_person_id;
        if has_own_selection then own_consumers := own_consumers || jsonb_build_array(guest_person_id); end if;
        merged_item := jsonb_set(old_item, '{consumers}', own_consumers, true);
      end if;
      merged_expenses := merged_expenses || jsonb_build_array(merged_item);
    end if;
  end loop;

  -- Append only genuinely new items owned by this participant.
  for submitted_item in select value from jsonb_array_elements(coalesce(p_draft->'expenses','[]'::jsonb)) loop
    if not exists (select 1 from jsonb_array_elements(coalesce(old_draft->'expenses','[]'::jsonb)) x where x->>'id' = submitted_item->>'id') then
      if submitted_item->>'addedBy' <> p_participant_id::text then raise exception 'New items must belong to you'; end if;
      merged_expenses := merged_expenses || jsonb_build_array(submitted_item);
    end if;
  end loop;

  old_draft := jsonb_set(old_draft, '{expenses}', merged_expenses, true);
  old_draft := jsonb_set(old_draft, '{participantAdjustments}', coalesce(old_draft->'participantAdjustments','{}'::jsonb), true);
  old_draft := jsonb_set(old_draft, '{payments}', coalesce(old_draft->'payments','{}'::jsonb), true);
  old_draft := jsonb_set(old_draft, '{noRepayment}', coalesce(old_draft->'noRepayment','{}'::jsonb), true);
  old_draft := jsonb_set(old_draft, '{canPayMerchant}', coalesce(old_draft->'canPayMerchant','{}'::jsonb), true);
  old_draft := jsonb_set(old_draft, '{settlementPreferences}', coalesce(old_draft->'settlementPreferences','{}'::jsonb), true);
  old_draft := jsonb_set(old_draft, '{venmoUsernames}', coalesce(old_draft->'venmoUsernames','{}'::jsonb), true);
  old_draft := jsonb_set(old_draft, array['participantAdjustments',p_participant_id::text], coalesce(p_draft->'participantAdjustments'->p_participant_id::text,'{}'::jsonb), true);
  old_draft := jsonb_set(old_draft, array['payments',guest_person_id], coalesce(p_draft->'payments'->guest_person_id,'0'::jsonb), true);
  old_draft := jsonb_set(old_draft, array['noRepayment',guest_person_id], coalesce(p_draft->'noRepayment'->guest_person_id,'false'::jsonb), true);
  old_draft := jsonb_set(old_draft, array['canPayMerchant',guest_person_id], coalesce(p_draft->'canPayMerchant'->guest_person_id,'true'::jsonb), true);
  old_draft := jsonb_set(old_draft, array['settlementPreferences',guest_person_id], coalesce(p_draft->'settlementPreferences'->guest_person_id,'[]'::jsonb), true);
  old_draft := jsonb_set(old_draft, array['venmoUsernames',guest_person_id], to_jsonb(coalesce(p_draft->'venmoUsernames'->>guest_person_id,'')), true);
  update public.bills set settings = jsonb_set(settings, '{draft}', old_draft, true), updated_at = now() where id = target_bill.id;
  return old_draft;
end;
$$;

grant execute on function public.save_participant_draft(text,uuid,text,jsonb) to anon, authenticated;

create or replace function public.delete_participant_item(
  p_token text, p_participant_id uuid, p_edit_token text, p_item_id text
) returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  target_bill public.bills%rowtype;
  target_participant public.participants%rowtype;
  current_draft jsonb;
  owned boolean;
begin
  select b.* into target_bill from public.share_tokens s join public.bills b on b.id=s.bill_id
  where s.token_hash=encode(digest(p_token,'sha256'),'hex') and s.revoked_at is null limit 1 for update of b;
  if target_bill.id is null or target_bill.status <> 'open' then raise exception 'This bill is closed or unavailable'; end if;
  select * into target_participant from public.participants where id=p_participant_id and bill_id=target_bill.id
    and participant_token_hash=encode(digest(p_edit_token,'sha256'),'hex');
  if target_participant.id is null then raise exception 'Your participant access has expired'; end if;
  current_draft := target_bill.settings->'draft';
  select exists(select 1 from jsonb_array_elements(coalesce(current_draft->'expenses','[]'::jsonb)) item
    where item->>'id'=p_item_id and item->>'addedBy'=p_participant_id::text) into owned;
  if not owned then raise exception 'You can delete only your own item'; end if;
  current_draft := jsonb_set(current_draft,'{expenses}',coalesce((select jsonb_agg(item) from jsonb_array_elements(coalesce(current_draft->'expenses','[]'::jsonb)) item where item->>'id'<>p_item_id),'[]'::jsonb),true);
  update public.bills set settings=jsonb_set(settings,'{draft}',current_draft,true),updated_at=now() where id=target_bill.id;
  return current_draft;
end; $$;
grant execute on function public.delete_participant_item(text,uuid,text,text) to anon, authenticated;

-- Organizer-only reusable groups. Contact information is never exposed by shared-bill RPCs.
create table if not exists public.saved_groups (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.saved_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.saved_groups(id) on delete cascade,
  name text not null,
  phone text,
  venmo_username text,
  color text not null default '#67d99a',
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.saved_groups enable row level security;
alter table public.saved_group_members enable row level security;

drop policy if exists "owners manage saved groups" on public.saved_groups;
create policy "owners manage saved groups" on public.saved_groups
for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop policy if exists "owners manage saved group members" on public.saved_group_members;
create policy "owners manage saved group members" on public.saved_group_members
for all
using (exists (select 1 from public.saved_groups g where g.id = group_id and g.owner_id = auth.uid()))
with check (exists (select 1 from public.saved_groups g where g.id = group_id and g.owner_id = auth.uid()));

grant select, insert, update, delete on public.saved_groups to authenticated;
grant select, insert, update, delete on public.saved_group_members to authenticated;
-- Private reusable contacts created from saved group members.
create table if not exists public.saved_contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  normalized_name text not null,
  name text not null,
  phone text,
  venmo_username text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, normalized_name)
);

alter table public.saved_contacts enable row level security;

drop policy if exists "owners manage saved contacts" on public.saved_contacts;
create policy "owners manage saved contacts" on public.saved_contacts
for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

grant select, insert, update, delete on public.saved_contacts to authenticated;
