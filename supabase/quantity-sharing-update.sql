-- Run this file once in the Supabase SQL Editor.
-- It adds atomic per-person quantity saving for shared bills.

create or replace function public.set_participant_item_quantity(
  p_token text,
  p_participant_id uuid,
  p_edit_token text,
  p_item_id text,
  p_quantity integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
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
  select b.* into target_bill
  from public.share_tokens s
  join public.bills b on b.id = s.bill_id
  where s.token_hash = encode(digest(p_token, 'sha256'), 'hex')
    and s.revoked_at is null
    and (s.expires_at is null or s.expires_at > now())
  limit 1
  for update of b;

  if target_bill.id is null or target_bill.status <> 'open' then
    raise exception 'This bill is closed or unavailable';
  end if;

  select * into target_participant
  from public.participants
  where id = p_participant_id
    and bill_id = target_bill.id
    and participant_token_hash = encode(digest(p_edit_token, 'sha256'), 'hex');

  if target_participant.id is null then
    raise exception 'Your participant access has expired';
  end if;

  current_draft := target_bill.settings->'draft';

  select value->>'id' into guest_person_id
  from jsonb_array_elements(coalesce(current_draft->'people', '[]'::jsonb))
  where lower(value->>'name') = lower(target_participant.name)
  limit 1;

  if guest_person_id is null then
    raise exception 'Participant is no longer on this bill';
  end if;

  for current_item in
    select value from jsonb_array_elements(coalesce(current_draft->'expenses', '[]'::jsonb))
  loop
    updated_item := current_item;
    if current_item->>'id' = p_item_id then
      select coalesce(jsonb_agg(value), '[]'::jsonb) into consumers
      from jsonb_array_elements(coalesce(current_item->'consumers', '[]'::jsonb))
      where value #>> '{}' <> guest_person_id;

      quantities := coalesce(current_item->'quantities', '{}'::jsonb) - guest_person_id;

      if safe_quantity > 0 then
        consumers := consumers || jsonb_build_array(guest_person_id);
        quantities := jsonb_set(quantities, array[guest_person_id], to_jsonb(safe_quantity), true);
      end if;

      updated_item := jsonb_set(
        jsonb_set(current_item, '{consumers}', consumers, true),
        '{quantities}',
        quantities,
        true
      );
    end if;
    updated_expenses := updated_expenses || jsonb_build_array(updated_item);
  end loop;

  current_draft := jsonb_set(current_draft, '{expenses}', updated_expenses, true);

  update public.bills
  set settings = jsonb_set(settings, '{draft}', current_draft, true),
      updated_at = now()
  where id = target_bill.id;

  update public.participants
  set claimed_at = now()
  where id = target_participant.id;

  return current_draft;
end;
$$;

grant execute on function public.set_participant_item_quantity(text, uuid, text, text, integer)
to anon, authenticated;

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
  select * into target_bill
  from public.bills
  where id = p_bill_id
    and owner_id = auth.uid()
  for update;

  if target_bill.id is null then
    raise exception 'Only the bill organizer can update this quantity';
  end if;

  if target_bill.status <> 'open' then
    raise exception 'This bill is closed or unavailable';
  end if;

  current_draft := target_bill.settings->'draft';

  for current_item in
    select value from jsonb_array_elements(coalesce(current_draft->'expenses', '[]'::jsonb))
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

      updated_item := jsonb_set(
        jsonb_set(current_item, '{consumers}', consumers, true),
        '{quantities}',
        quantities,
        true
      );
    end if;
    updated_expenses := updated_expenses || jsonb_build_array(updated_item);
  end loop;

  current_draft := jsonb_set(current_draft, '{expenses}', updated_expenses, true);

  update public.bills
  set settings = jsonb_set(settings, '{draft}', current_draft, true),
      updated_at = now()
  where id = target_bill.id;

  return current_draft;
end;
$$;

revoke all on function public.set_owner_item_quantity(uuid, text, text, integer) from public, anon;
grant execute on function public.set_owner_item_quantity(uuid, text, text, integer)
to authenticated;

notify pgrst, 'reload schema';

select
  case
    when to_regprocedure('public.set_participant_item_quantity(text,uuid,text,text,integer)') is not null
      and to_regprocedure('public.set_owner_item_quantity(uuid,text,text,integer)') is not null
      then 'Quantity sharing is installed correctly'
    else 'Quantity sharing was not installed'
  end as result;
