-- =====================================================================
-- Trade CRM v2: Supabase schema
-- Run once in a NEW Supabase project: Dashboard > SQL Editor > paste > Run.
-- Every business-owned row carries business_id and is protected by
-- Row Level Security (RLS) so a signed-in user can only touch rows of
-- the one business they belong to. The browser only ever uses the
-- public "anon"/publishable key. NEVER put the service_role/secret key
-- in any file that ships to a browser.
-- =====================================================================

-- ---------- Businesses (one per account) ----------
create table if not exists public.businesses (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name               text not null check (char_length(name) between 1 and 120),
  accent             text not null default '#2563eb' check (accent ~ '^#[0-9a-fA-F]{6}$'),
  phone              text check (char_length(phone) <= 40),
  email              text check (char_length(email) <= 200),
  postal_address     text check (char_length(postal_address) <= 300),
  google_review_link text check (char_length(google_review_link) <= 500),
  review_sms         text check (char_length(review_sms) <= 1000),
  review_email       text check (char_length(review_email) <= 3000),
  review_followup    text check (char_length(review_followup) <= 1000),
  support_email      text check (char_length(support_email) <= 200),
  tax_rate           numeric(6,3) not null default 0 check (tax_rate >= 0 and tax_rate <= 30),
  lead_form_enabled  boolean not null default true,
  created_at         timestamptz not null default now()
);

-- Membership: who can use which business. unique(user_id) = one business per account.
-- (Up to ~5 staff logins per business can be added later by the owner; no per-user fees.)
create table if not exists public.members (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  role        text not null default 'owner' check (role in ('owner','staff')),
  created_at  timestamptz not null default now(),
  primary key (business_id, user_id),
  unique (user_id)
);

-- ---------- Helper functions (SECURITY DEFINER so they can read members under RLS) ----------
create or replace function public.my_business_id() returns uuid
language sql stable security definer set search_path = public as $$
  select business_id from public.members where user_id = auth.uid()
$$;

create or replace function public.is_member(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where business_id = b and user_id = auth.uid())
$$;

create or replace function public.has_business() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where user_id = auth.uid())
$$;

-- Creating a business automatically makes the creator its owner-member.
create or replace function public.on_business_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.members (business_id, user_id, role) values (new.id, new.owner_id, 'owner');
  return new;
end $$;
drop trigger if exists trg_business_created on public.businesses;
create trigger trg_business_created after insert on public.businesses
  for each row execute function public.on_business_created();

-- ---------- Customers ----------
create table if not exists public.customers (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null default public.my_business_id() references public.businesses(id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 200),
  phone            text check (char_length(phone) <= 40),
  email            text check (char_length(email) <= 200),
  address          text check (char_length(address) <= 300),
  source           text check (char_length(source) <= 80),        -- how they found us
  tags             text[] not null default '{}',
  notes            text check (char_length(notes) <= 5000),
  sms_ok           boolean not null default false,                  -- consent to service/review texts
  email_ok         boolean not null default false,
  consent_log      text check (char_length(consent_log) <= 5000),  -- when/how consent was given
  opted_out        boolean not null default false,                  -- replied STOP / asked not to be contacted
  opted_out_at     timestamptz,
  next_service_due date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (business_id, id)
);

-- ---------- Leads (website form inbox) ----------
create table if not exists public.leads (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null default public.my_business_id() references public.businesses(id) on delete cascade,
  name         text not null check (char_length(name) between 1 and 200),
  phone        text check (char_length(phone) <= 40),
  email        text check (char_length(email) <= 200),
  address      text check (char_length(address) <= 300),
  service      text check (char_length(service) <= 200),
  message      text check (char_length(message) <= 2000),
  sms_ok       boolean not null default false,    -- visitor ticked "OK to text me" on the form
  source       text not null default 'Website form' check (char_length(source) <= 80),
  status       text not null default 'new' check (status in ('new','contacted','quote','won','lost')),
  customer_id  uuid,
  contacted_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete set null (customer_id)
);

-- ---------- Jobs (job history, photos) ----------
create table if not exists public.jobs (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.my_business_id() references public.businesses(id) on delete cascade,
  customer_id uuid not null,
  title       text not null check (char_length(title) between 1 and 200),
  date        date not null default current_date,
  price       numeric(12,2) not null default 0 check (price >= 0),
  status      text not null default 'scheduled' check (status in ('scheduled','done','canceled')),
  notes       text check (char_length(notes) <= 5000),
  photos      jsonb not null default '[]'::jsonb,   -- [{path, caption, added_at}] paths inside the job-photos bucket
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete cascade
);

-- ---------- Quotes and invoices ----------
create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null default public.my_business_id() references public.businesses(id) on delete cascade,
  customer_id   uuid,
  kind          text not null check (kind in ('quote','invoice')),
  number        text not null check (char_length(number) <= 40),
  status        text not null default 'draft' check (status in ('draft','sent','accepted','paid','void')),
  items         jsonb not null default '[]'::jsonb,   -- [{desc, qty, price}]
  tax_rate      numeric(6,3) not null default 0 check (tax_rate >= 0 and tax_rate <= 30),
  deposit       numeric(12,2) not null default 0 check (deposit >= 0),
  pay_link      text check (pay_link is null or pay_link = '' or pay_link ~* '^https://'),
  notes         text check (char_length(notes) <= 3000),
  due_date      date,
  sent_at       timestamptz,
  paid_at       timestamptz,
  accepted_name text check (char_length(accepted_name) <= 120),
  accepted_at   timestamptz,
  accepted_via  text check (char_length(accepted_via) <= 300),   -- e.g. 'in person on owner device' / 'share link'
  from_quote_id uuid,
  share_token   uuid not null default gen_random_uuid() unique,  -- unguessable id for the customer's view link
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (business_id, number, kind),
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete set null (customer_id)
);

-- ---------- Tasks (manual + automatic follow-ups) ----------
create table if not exists public.tasks (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.my_business_id() references public.businesses(id) on delete cascade,
  title       text not null check (char_length(title) between 1 and 300),
  due         date,
  done        boolean not null default false,
  done_at     timestamptz,
  customer_id uuid,
  auto_key    text check (char_length(auto_key) <= 120),   -- set for automatic reminders, prevents duplicates
  created_at  timestamptz not null default now(),
  unique (business_id, auto_key),
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete cascade
);

-- ---------- Review request log ----------
create table if not exists public.review_requests (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.my_business_id() references public.businesses(id) on delete cascade,
  customer_id uuid not null,
  channel     text not null check (channel in ('sms','email')),
  kind        text not null check (kind in ('first','followup')),
  created_at  timestamptz not null default now(),
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete cascade
);

create index if not exists customers_biz on public.customers(business_id);
create index if not exists leads_biz on public.leads(business_id, created_at desc);
create index if not exists jobs_biz on public.jobs(business_id, customer_id);
create index if not exists documents_biz on public.documents(business_id);
create index if not exists tasks_biz on public.tasks(business_id, done, due);
create index if not exists review_biz on public.review_requests(business_id, customer_id);

-- ---------- Row Level Security ----------
alter table public.businesses      enable row level security;
alter table public.members         enable row level security;
alter table public.customers       enable row level security;
alter table public.leads           enable row level security;
alter table public.jobs            enable row level security;
alter table public.documents       enable row level security;
alter table public.tasks           enable row level security;
alter table public.review_requests enable row level security;

-- Privileges: anon gets nothing except inserting a few lead columns; authenticated gets CRUD (RLS decides rows).
revoke all on public.businesses, public.members, public.customers, public.leads, public.jobs,
              public.documents, public.tasks, public.review_requests from anon, authenticated;
grant select, insert, update, delete on public.businesses, public.customers, public.leads, public.jobs,
              public.documents, public.tasks, public.review_requests to authenticated;
grant select on public.members to authenticated;
grant insert (business_id, name, phone, email, address, service, message, sms_ok) on public.leads to anon;

-- businesses
drop policy if exists biz_select on public.businesses;
create policy biz_select on public.businesses for select to authenticated using (owner_id = auth.uid() or public.is_member(id));
drop policy if exists biz_insert on public.businesses;
create policy biz_insert on public.businesses for insert to authenticated
  with check (owner_id = auth.uid() and not public.has_business());
drop policy if exists biz_update on public.businesses;
create policy biz_update on public.businesses for update to authenticated
  using (public.is_member(id)) with check (public.is_member(id));
-- owner_id and id can never be changed by an update
create or replace function public.keep_business_owner() returns trigger language plpgsql as $$
begin new.id := old.id; new.owner_id := old.owner_id; new.created_at := old.created_at; return new; end $$;
drop trigger if exists trg_keep_business_owner on public.businesses;
create trigger trg_keep_business_owner before update on public.businesses
  for each row execute function public.keep_business_owner();
drop policy if exists biz_delete on public.businesses;
create policy biz_delete on public.businesses for delete to authenticated using (owner_id = auth.uid());

-- members: read-only to members of the same business (no self-joining other businesses)
drop policy if exists members_select on public.members;
create policy members_select on public.members for select to authenticated using (public.is_member(business_id));

-- all business-owned tables: same rule for read and write
do $$
declare t text;
begin
  foreach t in array array['customers','leads','jobs','documents','tasks','review_requests'] loop
    execute format('drop policy if exists %I_member_all on public.%I', t, t);
    execute format('create policy %I_member_all on public.%I for all to authenticated
                    using (public.is_member(business_id)) with check (public.is_member(business_id))', t, t);
  end loop;
end $$;

-- ---------- Email log (drafts + emails the owner says they sent) ----------
-- The CRM never sends email itself: it opens the owner's own email app / Gmail, then logs it when
-- the owner taps "Yes, I sent it". Same strict per-business RLS as every other table.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'leads_business_id_id_key' and conrelid = 'public.leads'::regclass) then
    alter table public.leads add constraint leads_business_id_id_key unique (business_id, id);
  end if;
end $$;
create table if not exists public.emails (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null default public.my_business_id() references public.businesses(id) on delete cascade,
  lead_id     uuid,
  customer_id uuid,
  to_email    text check (char_length(to_email) <= 320),
  subject     text check (char_length(subject) <= 500),
  body        text check (char_length(body) <= 20000),
  template    text check (char_length(template) <= 40),
  source      text check (char_length(source) <= 80),      -- e.g. 'CRM', 'Rex draft'
  status      text not null default 'draft' check (status in ('draft','sent')),
  sent_at     timestamptz,
  replied_at  timestamptz,                                   -- owner tapped "They replied"
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (lead_id is not null or customer_id is not null),
  check (status = 'draft' or sent_at is not null),
  foreign key (business_id, lead_id) references public.leads (business_id, id) on delete cascade,
  foreign key (business_id, customer_id) references public.customers (business_id, id) on delete cascade
);
create index if not exists emails_biz on public.emails(business_id, created_at desc);
create index if not exists emails_lead on public.emails(business_id, lead_id);
create index if not exists emails_customer on public.emails(business_id, customer_id);
alter table public.emails enable row level security;
revoke all on public.emails from anon, authenticated;
grant select, insert, update, delete on public.emails to authenticated;
drop policy if exists emails_member_all on public.emails;
create policy emails_member_all on public.emails for all to authenticated
  using (public.is_member(business_id)) with check (public.is_member(business_id));

-- ---------- Public lead form (anon, insert only) ----------
create or replace function public.lead_form_open(b uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.businesses where id = b and lead_form_enabled)
$$;
create or replace function public.public_leads_last_hour(b uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.leads where business_id = b and created_at > now() - interval '1 hour'
$$;

drop policy if exists leads_public_insert on public.leads;
create policy leads_public_insert on public.leads for insert to anon
  with check (public.lead_form_open(business_id) and status = 'new' and customer_id is null and contacted_at is null);

-- Basic flood protection: max 30 form submissions per business per hour.
create or replace function public.leads_rate_limit() returns trigger language plpgsql as $$
begin
  if current_user = 'anon' and public.public_leads_last_hour(new.business_id) >= 30 then
    raise exception 'Too many requests, please call us instead.';
  end if;
  return new;
end $$;
drop trigger if exists trg_leads_rate_limit on public.leads;
create trigger trg_leads_rate_limit before insert on public.leads
  for each row execute function public.leads_rate_limit();

-- ---------- Customer-facing quote/invoice link (token based, no login) ----------
create or replace function public.get_public_document(p_token uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'doc', jsonb_build_object('kind', d.kind, 'number', d.number, 'status', d.status, 'items', d.items,
           'tax_rate', d.tax_rate, 'deposit', d.deposit, 'pay_link', d.pay_link, 'notes', d.notes,
           'due_date', d.due_date, 'sent_at', d.sent_at, 'created_at', d.created_at,
           'accepted_name', d.accepted_name, 'accepted_at', d.accepted_at, 'accepted_via', d.accepted_via),
    'business', jsonb_build_object('name', b.name, 'phone', b.phone, 'email', b.email,
           'postal_address', b.postal_address, 'accent', b.accent),
    'customer', jsonb_build_object('name', c.name, 'address', c.address))
  from public.documents d
  join public.businesses b on b.id = d.business_id
  left join public.customers c on c.id = d.customer_id and c.business_id = d.business_id
  where d.share_token = p_token and d.status <> 'draft' and d.status <> 'void'
$$;

create or replace function public.accept_quote(p_token uuid, p_name text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n text := btrim(coalesce(p_name, ''));
begin
  if char_length(n) < 2 or char_length(n) > 120 then raise exception 'Please type your full name.'; end if;
  update public.documents
     set status = 'accepted', accepted_name = n, accepted_at = now(),
         accepted_via = 'Customer typed name on share link', updated_at = now()
   where share_token = p_token and kind = 'quote' and status = 'sent';
  if not found then raise exception 'This quote is not open for acceptance.'; end if;
  return public.get_public_document(p_token);
end $$;

revoke execute on function public.get_public_document(uuid), public.accept_quote(uuid, text),
  public.lead_form_open(uuid), public.public_leads_last_hour(uuid), public.my_business_id(),
  public.is_member(uuid), public.has_business(), public.on_business_created(), public.leads_rate_limit(),
  public.keep_business_owner() from public;
grant execute on function public.get_public_document(uuid), public.accept_quote(uuid, text) to anon, authenticated;
grant execute on function public.lead_form_open(uuid), public.public_leads_last_hour(uuid) to anon, authenticated;
grant execute on function public.my_business_id(), public.is_member(uuid), public.has_business() to authenticated;

-- ---------- Storage: private bucket for job photos ----------
-- Object path must be  <business_id>/<job_id>/<file>.  Only members of that business can read/write.
insert into storage.buckets (id, name, public) values ('job-photos', 'job-photos', false)
  on conflict (id) do nothing;

drop policy if exists job_photos_select on storage.objects;
create policy job_photos_select on storage.objects for select to authenticated
  using (bucket_id = 'job-photos' and (storage.foldername(name))[1] = public.my_business_id()::text);
drop policy if exists job_photos_insert on storage.objects;
create policy job_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'job-photos' and (storage.foldername(name))[1] = public.my_business_id()::text);
drop policy if exists job_photos_update on storage.objects;
create policy job_photos_update on storage.objects for update to authenticated
  using (bucket_id = 'job-photos' and (storage.foldername(name))[1] = public.my_business_id()::text)
  with check (bucket_id = 'job-photos' and (storage.foldername(name))[1] = public.my_business_id()::text);
drop policy if exists job_photos_delete on storage.objects;
create policy job_photos_delete on storage.objects for delete to authenticated
  using (bucket_id = 'job-photos' and (storage.foldername(name))[1] = public.my_business_id()::text);
