-- =====================================================================
-- Run this ONLY if you ran 01_schema.sql before the switch to
-- password sign-in (a fresh install doesn't need it — 01_schema.sql
-- already includes all of this). Safe to run more than once.
-- =====================================================================

-- New profile fields
alter table public.profiles add column if not exists must_change_password boolean not null default true;
alter table public.profiles add column if not exists disabled boolean not null default false;

-- Admins never need to replace a starting password
update public.profiles set must_change_password = false where is_admin;

-- Employees can set their own name and home location
grant update (home_location, full_name) on public.profiles to authenticated;

-- New accounts: readable starting name, admin flag, and "must change password" for employees
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not coalesce(lower(new.email) like '%@1915south.com', false) then
    raise exception 'Only @1915south.com accounts may sign in';
  end if;
  insert into public.profiles (id, email, full_name, is_admin, must_change_password)
  values (
    new.id,
    lower(new.email),
    coalesce(new.raw_user_meta_data->>'full_name',
             new.raw_user_meta_data->>'name',
             initcap(translate(split_part(new.email, '@', 1), '._-', '   '))),
    exists (select 1 from public.admin_emails a where a.email = lower(new.email)),
    not exists (select 1 from public.admin_emails a where a.email = lower(new.email))
  );
  return new;
end $$;

-- Called by the app right after an employee chooses their own password
create or replace function public.mark_password_changed()
returns void language sql security definer set search_path = public as $$
  update public.profiles set must_change_password = false where id = auth.uid();
$$;
revoke execute on function public.mark_password_changed() from public, anon;
grant execute on function public.mark_password_changed() to authenticated;
