-- Restore Data API privileges for authenticated users, including anonymous sign-ins.
-- Row Level Security policies still restrict every row to its permitted owner/member.

grant usage on schema public to anon, authenticated;

grant select, insert, update, delete on table
  public.profiles,
  public.bills,
  public.participants,
  public.items,
  public.assignments,
  public.payments,
  public.share_tokens
to authenticated;

notify pgrst, 'reload schema';
