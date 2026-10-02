-- =====================================================================
-- Run this ONLY if you already ran 01_schema.sql before the switch from
-- Microsoft sign-in to email-code sign-in. (A fresh install doesn't need it —
-- 01_schema.sql already includes these changes.)
-- Safe to run more than once.
-- =====================================================================

-- Employees can now set their own name on first sign-in.
grant update (home_location, full_name) on public.profiles to authenticated;

-- Nicer starting name when someone signs in by email:
-- sam.taylor@1915south.com → "Sam Taylor"
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(lower(new.email) like '%@1915south.com', false) then
    raise exception 'Only @1915south.com accounts may sign in';
  end if;
  insert into public.profiles (id, email, full_name, is_admin)
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data->>'full_name',
             new.raw_user_meta_data->>'name',
             initcap(translate(split_part(new.email, '@', 1), '._-', '   '))),
    exists (select 1 from public.admin_emails a where a.email = lower(new.email))
  );
  return new;
end $$;
