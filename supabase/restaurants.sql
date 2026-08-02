-- Registered restaurant profiles and permanent public payment QR codes.
-- Run once in the Supabase SQL Editor.

create table if not exists public.restaurants (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null,
  location_name text not null default '',
  address_line_1 text not null,
  city text not null,
  region text not null,
  postal_code text not null,
  phone text not null default '',
  public_code text not null unique default encode(gen_random_bytes(18), 'hex'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.bills
  add column if not exists restaurant_id uuid references public.restaurants(id) on delete set null;

create index if not exists bills_restaurant_id_idx on public.bills(restaurant_id);
create index if not exists restaurants_public_code_idx on public.restaurants(public_code);

alter table public.restaurants enable row level security;

drop policy if exists "restaurant owners manage their profile" on public.restaurants;
create policy "restaurant owners manage their profile" on public.restaurants
for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

grant select, insert, update, delete on public.restaurants to authenticated;

drop function if exists public.open_registered_restaurant(text);
create function public.open_registered_restaurant(p_code text)
returns table (
  id uuid,
  name text,
  location_name text,
  address_line_1 text,
  city text,
  region text,
  postal_code text,
  paypal_connected boolean
)
language sql
security definer
set search_path = public
as $$
  select
    r.id,
    r.name,
    r.location_name,
    r.address_line_1,
    r.city,
    r.region,
    r.postal_code,
    exists (
      select 1
      from public.paypal_merchant_accounts p
      where p.owner_id = r.owner_id
        and p.status = 'connected'
        and p.payments_receivable = true
    ) as paypal_connected
  from public.restaurants r
  where r.public_code = p_code
    and r.active = true
  limit 1;
$$;

grant execute on function public.open_registered_restaurant(text) to anon, authenticated;

notify pgrst, 'reload schema';
