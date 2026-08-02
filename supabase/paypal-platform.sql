-- Run once in the Supabase SQL Editor before testing PayPal seller onboarding.

create table if not exists public.paypal_merchant_accounts (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  tracking_id text not null unique,
  merchant_id text unique,
  environment text not null default 'sandbox' check (environment in ('sandbox','live')),
  status text not null default 'pending' check (status in ('pending','connected','needs_attention','disconnected')),
  payments_receivable boolean not null default false,
  email_confirmed boolean not null default false,
  paypal_details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.paypal_transactions (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills(id) on delete cascade,
  person_id text not null,
  payer_participant_id uuid references public.participants(id) on delete set null,
  organizer_id uuid not null references auth.users(id) on delete cascade,
  paypal_merchant_id text not null,
  paypal_order_id text unique,
  paypal_capture_id text unique,
  amount_cents integer not null check (amount_cents > 0),
  currency text not null default 'USD',
  status text not null default 'created' check (status in ('created','approved','completed','cancelled','failed','refunded')),
  idempotency_key text not null unique,
  provider_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.paypal_merchant_accounts enable row level security;
alter table public.paypal_transactions enable row level security;

drop policy if exists "owners read own PayPal connection" on public.paypal_merchant_accounts;
create policy "owners read own PayPal connection" on public.paypal_merchant_accounts
for select using (owner_id = auth.uid());

drop policy if exists "organizers read bill PayPal transactions" on public.paypal_transactions;
create policy "organizers read bill PayPal transactions" on public.paypal_transactions
for select using (organizer_id = auth.uid());

revoke all on public.paypal_merchant_accounts from anon, authenticated;
revoke all on public.paypal_transactions from anon, authenticated;
grant select on public.paypal_merchant_accounts to authenticated;
grant select on public.paypal_transactions to authenticated;

notify pgrst, 'reload schema';
