create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users(id) on delete cascade,
  title text not null default '',
  occurred_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open','locked','archived')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.participants (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  name text not null,
  color text not null default '#67d99a',
  participant_token_hash text,
  created_at timestamptz not null default now(),
  unique (bill_id, user_id)
);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills(id) on delete cascade,
  added_by uuid not null references public.participants(id) on delete cascade,
  name text not null default '',
  cents integer not null check (cents > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.assignments (
  item_id uuid not null references public.items(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (item_id, participant_id)
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills(id) on delete cascade,
  participant_id uuid not null references public.participants(id) on delete cascade,
  cents integer not null check (cents >= 0),
  no_repayment boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (bill_id, participant_id)
);

create table if not exists public.share_tokens (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
alter table public.bills enable row level security;
alter table public.participants enable row level security;
alter table public.items enable row level security;
alter table public.assignments enable row level security;
alter table public.payments enable row level security;
alter table public.share_tokens enable row level security;

create policy "profiles are self managed" on public.profiles for all using (id = auth.uid()) with check (id = auth.uid());
create policy "owners manage bills" on public.bills for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "members read bills" on public.bills for select using (exists (select 1 from public.participants p where p.bill_id = id and p.user_id = auth.uid()));
create policy "members read participants" on public.participants for select using (exists (select 1 from public.participants me where me.bill_id = bill_id and me.user_id = auth.uid()));
create policy "owners manage participants" on public.participants for all using (exists (select 1 from public.bills b where b.id = bill_id and b.owner_id = auth.uid())) with check (exists (select 1 from public.bills b where b.id = bill_id and b.owner_id = auth.uid()));
create policy "members read items" on public.items for select using (exists (select 1 from public.participants p where p.bill_id = bill_id and p.user_id = auth.uid()));
create policy "participants create own items" on public.items for insert with check (exists (select 1 from public.participants p where p.id = added_by and p.bill_id = bill_id and p.user_id = auth.uid()));
create policy "participants update own items" on public.items for update using (exists (select 1 from public.participants p where p.id = added_by and p.user_id = auth.uid())) with check (exists (select 1 from public.participants p where p.id = added_by and p.user_id = auth.uid()));
create policy "participants delete own items" on public.items for delete using (exists (select 1 from public.participants p where p.id = added_by and p.user_id = auth.uid()));
create policy "owners manage all items" on public.items for all using (exists (select 1 from public.bills b where b.id = bill_id and b.owner_id = auth.uid())) with check (exists (select 1 from public.bills b where b.id = bill_id and b.owner_id = auth.uid()));
create policy "members read assignments" on public.assignments for select using (exists (select 1 from public.participants me join public.items i on i.bill_id = me.bill_id where i.id = item_id and me.user_id = auth.uid()));
create policy "participants manage own assignments" on public.assignments for all using (exists (select 1 from public.participants p where p.id = participant_id and p.user_id = auth.uid())) with check (exists (select 1 from public.participants p where p.id = participant_id and p.user_id = auth.uid()));
create policy "owners manage assignments" on public.assignments for all using (exists (select 1 from public.items i join public.bills b on b.id = i.bill_id where i.id = item_id and b.owner_id = auth.uid())) with check (exists (select 1 from public.items i join public.bills b on b.id = i.bill_id where i.id = item_id and b.owner_id = auth.uid()));
create policy "members read payments" on public.payments for select using (exists (select 1 from public.participants p where p.bill_id = bill_id and p.user_id = auth.uid()));
create policy "participants manage own payments" on public.payments for all using (exists (select 1 from public.participants p where p.id = participant_id and p.user_id = auth.uid())) with check (exists (select 1 from public.participants p where p.id = participant_id and p.user_id = auth.uid()));
create policy "owners manage payments" on public.payments for all using (exists (select 1 from public.bills b where b.id = bill_id and b.owner_id = auth.uid())) with check (exists (select 1 from public.bills b where b.id = bill_id and b.owner_id = auth.uid()));
create policy "owners manage share tokens" on public.share_tokens for all using (exists (select 1 from public.bills b where b.id = bill_id and b.owner_id = auth.uid())) with check (exists (select 1 from public.bills b where b.id = bill_id and b.owner_id = auth.uid()));

alter publication supabase_realtime add table public.bills, public.participants, public.items, public.assignments, public.payments;

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
