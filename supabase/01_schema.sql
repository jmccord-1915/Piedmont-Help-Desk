-- =====================================================================
-- 1915 South Help Desk — database schema
-- Run this once in Supabase: SQL Editor → New query → paste → Run.
-- =====================================================================

-- ---------- Constants ------------------------------------------------
-- Locations are enforced by CHECK constraints below. To add a location
-- later, update these constraints AND docs/app.js (LOCATIONS).

-- ---------- Admins ---------------------------------------------------
create table if not exists public.admin_emails (
  email text primary key
);
insert into public.admin_emails (email) values ('jmccord@1915south.com')
  on conflict do nothing;

-- ---------- Profiles (one per employee) ------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null unique,
  full_name     text,
  home_location text check (home_location in (
                  '1201 Greensboro','1202 Winston Salem','1203 Burlington',
                  '1204 Danville','1205 Greensboro Outlet','DC')),
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Create a profile on first sign-in; reject anything outside @1915south.com.
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
             split_part(new.email, '@', 1)),
    exists (select 1 from public.admin_emails a where a.email = lower(new.email))
  );
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

-- ---------- Tickets --------------------------------------------------
create table if not exists public.tickets (
  id              bigint generated always as identity (start with 1001) primary key,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  created_by      uuid not null default auth.uid() references public.profiles(id),
  requester_name  text,
  requester_email text,
  location        text not null check (location in (
                    '1201 Greensboro','1202 Winston Salem','1203 Burlington',
                    '1204 Danville','1205 Greensboro Outlet','DC')),
  category        text not null check (category in ('Question','Problem','Request')),
  priority        text not null check (priority in ('Low','Medium','High')),
  -- Color shown everywhere for this priority (Low=green, Medium=yellow, High=red)
  priority_color  text generated always as (
                    case priority when 'High' then '#dc2626'
                                  when 'Medium' then '#eab308'
                                  else '#16a34a' end) stored,
  status          text not null default 'Open'
                    check (status in ('Open','In Progress','Resolved')),
  title           text not null check (char_length(btrim(title)) between 1 and 200),
  description     text not null check (char_length(btrim(description)) between 1 and 5000),
  is_sale         boolean not null default false,
  customer_name   text,
  customer_phone  text,   -- 10 digits, no formatting
  sale_number     text,
  constraint sale_details_required check (
    not is_sale or (
      coalesce(btrim(customer_name), '') <> ''
      and customer_phone ~ '^[0-9]{10}$'
      and coalesce(btrim(sale_number), '') <> ''
    )
  )
);

create index if not exists tickets_status_idx     on public.tickets (status);
create index if not exists tickets_created_by_idx on public.tickets (created_by);

-- On insert: stamp the real requester, force status Open, clear unused sale fields.
create or replace function public.tickets_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  select * into p from public.profiles where id = new.created_by;
  new.requester_name  := p.full_name;
  new.requester_email := p.email;
  new.status          := 'Open';
  new.resolved_at     := null;
  new.created_at      := now();
  new.updated_at      := now();
  if not new.is_sale then
    new.customer_name := null; new.customer_phone := null; new.sale_number := null;
  end if;
  return new;
end $$;

drop trigger if exists tickets_before_insert on public.tickets;
create trigger tickets_before_insert before insert on public.tickets
  for each row execute function public.tickets_before_insert();

create or replace function public.tickets_before_update()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.status = 'Resolved' and old.status <> 'Resolved' then
    new.resolved_at := now();
  elsif new.status <> 'Resolved' then
    new.resolved_at := null;
  end if;
  return new;
end $$;

drop trigger if exists tickets_before_update on public.tickets;
create trigger tickets_before_update before update on public.tickets
  for each row execute function public.tickets_before_update();

create or replace function public.can_access_ticket(tid bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tickets t
    where t.id = tid and (t.created_by = auth.uid() or public.is_admin())
  )
$$;

-- ---------- Comments -------------------------------------------------
create table if not exists public.ticket_comments (
  id              bigint generated always as identity primary key,
  ticket_id       bigint not null references public.tickets(id) on delete cascade,
  author_id       uuid not null default auth.uid() references public.profiles(id),
  author_name     text,
  author_is_admin boolean not null default false,
  body            text not null check (char_length(btrim(body)) between 1 and 5000),
  created_at      timestamptz not null default now()
);
create index if not exists ticket_comments_ticket_idx on public.ticket_comments (ticket_id);

create or replace function public.comments_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  new.author_id := auth.uid();
  select * into p from public.profiles where id = new.author_id;
  new.author_name     := p.full_name;
  new.author_is_admin := coalesce(p.is_admin, false);
  new.created_at      := now();
  return new;
end $$;

drop trigger if exists comments_before_insert on public.ticket_comments;
create trigger comments_before_insert before insert on public.ticket_comments
  for each row execute function public.comments_before_insert();

-- ---------- Photos ---------------------------------------------------
create table if not exists public.ticket_photos (
  id          bigint generated always as identity primary key,
  ticket_id   bigint not null references public.tickets(id) on delete cascade,
  path        text not null unique,
  uploaded_by uuid not null default auth.uid() references public.profiles(id),
  created_at  timestamptz not null default now()
);
create index if not exists ticket_photos_ticket_idx on public.ticket_photos (ticket_id);

-- ---------- Row-level security ---------------------------------------
alter table public.admin_emails    enable row level security;  -- no policies: invisible to the app
alter table public.profiles        enable row level security;
alter table public.tickets         enable row level security;
alter table public.ticket_comments enable row level security;
alter table public.ticket_photos   enable row level security;

drop policy if exists "profiles: read own or admin" on public.profiles;
create policy "profiles: read own or admin" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());
drop policy if exists "profiles: update own" on public.profiles;
create policy "profiles: update own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
-- Employees may only change their home location (not is_admin, email, etc.)
revoke insert, update, delete on public.profiles from anon, authenticated;
grant update (home_location) on public.profiles to authenticated;

drop policy if exists "tickets: read own or admin" on public.tickets;
create policy "tickets: read own or admin" on public.tickets
  for select to authenticated using (created_by = auth.uid() or public.is_admin());
drop policy if exists "tickets: create own" on public.tickets;
create policy "tickets: create own" on public.tickets
  for insert to authenticated with check (created_by = auth.uid());
drop policy if exists "tickets: admin updates" on public.tickets;
create policy "tickets: admin updates" on public.tickets
  for update to authenticated using (public.is_admin()) with check (public.is_admin());
revoke update, delete on public.tickets from anon, authenticated;
grant update (status, priority, category, location) on public.tickets to authenticated;

drop policy if exists "comments: read" on public.ticket_comments;
create policy "comments: read" on public.ticket_comments
  for select to authenticated using (public.can_access_ticket(ticket_id));
drop policy if exists "comments: create" on public.ticket_comments;
create policy "comments: create" on public.ticket_comments
  for insert to authenticated with check (public.can_access_ticket(ticket_id));
revoke update, delete on public.ticket_comments from anon, authenticated;

drop policy if exists "photos: read" on public.ticket_photos;
create policy "photos: read" on public.ticket_photos
  for select to authenticated using (public.can_access_ticket(ticket_id));
drop policy if exists "photos: create" on public.ticket_photos;
create policy "photos: create" on public.ticket_photos
  for insert to authenticated
  with check (uploaded_by = auth.uid() and public.can_access_ticket(ticket_id));
revoke update, delete on public.ticket_photos from anon, authenticated;

-- ---------- Photo storage --------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ticket-photos', 'ticket-photos', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do nothing;

-- Files are stored as "<ticket id>/<random>.jpg"
create or replace function public.can_access_ticket_folder(object_name text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare folder text := split_part(object_name, '/', 1);
begin
  if folder !~ '^[0-9]+$' then return false; end if;
  return public.can_access_ticket(folder::bigint);
end $$;

drop policy if exists "ticket photos: read" on storage.objects;
create policy "ticket photos: read" on storage.objects
  for select to authenticated
  using (bucket_id = 'ticket-photos' and public.can_access_ticket_folder(name));
drop policy if exists "ticket photos: upload" on storage.objects;
create policy "ticket photos: upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'ticket-photos' and public.can_access_ticket_folder(name));

-- ---------- Real-time (live alerts) ----------------------------------
do $$
begin
  begin
    alter publication supabase_realtime add table public.tickets;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.ticket_comments;
  exception when duplicate_object then null;
  end;
end $$;
