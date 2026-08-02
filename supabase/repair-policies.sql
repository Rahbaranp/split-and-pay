-- Repair the initial recursive member-read policies.
-- Organizer cloud saving remains protected by "owners manage bills".
drop policy if exists "members read bills" on public.bills;
drop policy if exists "members read participants" on public.participants;

-- Participant access will be restored with SECURITY DEFINER membership
-- helpers when shared editing is enabled in the next stage.
