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

-- ---------- v2.8: saved services and prices (additive, safe to re-run) ----------
-- A short list the owner picks from when building a quote or invoice: [{id, name, price, note}].
-- Lives on the business row, so the existing strict business policies (members only) cover it.
-- Not returned by get_public_document, so customers never see the price list.
alter table public.businesses add column if not exists services jsonb not null default '[]'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'businesses_services_shape' and conrelid = 'public.businesses'::regclass) then
    alter table public.businesses add constraint businesses_services_shape check (
      case when jsonb_typeof(services) = 'array' then jsonb_array_length(services) <= 200 and octet_length(services::text) <= 60000 else false end);
  end if;
end $$;

-- ---------- v2.9: client workspaces + site previews (additive, safe to re-run) ----------
-- One login can belong to more than one business. The account that creates a client
-- workspace is a manager of that workspace, not its owner. owner_id stays empty and
-- claim_status stays invite_pending until a later invite (not included here). No email
-- is sent. Membership rows are written only inside the bootstrap function from auth.uid().
-- Sales notes and proposal drafts live on site_proposals under the creator's own
-- business_id. The public site payload never includes them.
-- Claim / recovery: authenticated updates cannot change owner_id, workspace_kind or
-- claim_status (trigger). A database owner running SQL as postgres can repair those
-- columns. This release has no invite, no password, and no self-serve claim function.
-- Rollback-to-disable: supabase/client_workspaces_rollback.sql

-- A user may be owner of their own account and manager of client workspaces.
alter table public.members drop constraint if exists members_user_id_key;
alter table public.members drop constraint if exists members_role_check;
alter table public.members add constraint members_role_check check (role in ('owner','staff','manager'));
create index if not exists members_user on public.members (user_id);

alter table public.businesses add column if not exists workspace_kind text not null default 'own';
alter table public.businesses add column if not exists claim_status text not null default 'claimed';
alter table public.businesses alter column owner_id drop not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'businesses_workspace_kind_check' and conrelid = 'public.businesses'::regclass) then
    alter table public.businesses add constraint businesses_workspace_kind_check check (workspace_kind in ('own','client'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'businesses_claim_status_check' and conrelid = 'public.businesses'::regclass) then
    alter table public.businesses add constraint businesses_claim_status_check check (claim_status in ('claimed','invite_pending'));
  end if;
end $$;

-- Home workspace when this login has exactly one membership; otherwise the owned account.
-- Inserts from the app always send business_id. This default must not pick a client workspace.
create or replace function public.my_business_id() returns uuid
language sql stable security definer set search_path = public as $$
  select business_id from public.members
   where user_id = auth.uid()
   order by case role when 'owner' then 0 when 'manager' then 1 else 2 end, created_at
   limit 1
$$;

-- Existing sign-up still adds an owner membership. A client workspace has no owner_id, so it adds none.
create or replace function public.on_business_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.owner_id is not null then
    insert into public.members (business_id, user_id, role) values (new.id, new.owner_id, 'owner');
  end if;
  return new;
end $$;

-- Direct inserts from a signed-in user are always their own claimed account.
-- The bootstrap function runs as its owner, so it can insert a client workspace.
create or replace function public.normalize_business_insert() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.workspace_kind := 'own';
    new.claim_status := 'claimed';
    if new.owner_id is null then new.owner_id := auth.uid(); end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_normalize_business_insert on public.businesses;
create trigger trg_normalize_business_insert before insert on public.businesses
  for each row execute function public.normalize_business_insert();

create or replace function public.keep_business_owner() returns trigger
language plpgsql set search_path = public as $$
begin
  new.id := old.id;
  new.created_at := old.created_at;
  if current_user in ('authenticated', 'anon') then
    new.owner_id := old.owner_id;
    new.workspace_kind := old.workspace_kind;
    new.claim_status := old.claim_status;
  end if;
  return new;
end $$;

-- Bookkeeping in the SALES account. Future client logins are not members here, so they cannot read it.
create table if not exists public.client_accounts (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null default public.my_business_id() references public.businesses(id) on delete cascade,
  client_business_id  uuid not null references public.businesses(id) on delete cascade,
  client_key          text not null check (client_key ~ '^[A-Za-z0-9:_-]{2,80}$'),
  name_key            text not null check (char_length(name_key) between 1 and 120),
  lead_id             uuid,
  setup_status        text not null default 'invite_pending' check (setup_status in ('invite_pending','active')),
  created_at          timestamptz not null default now(),
  unique (business_id, client_key),
  unique (business_id, name_key),
  unique (business_id, client_business_id),
  foreign key (business_id, lead_id) references public.leads (business_id, id) on delete set null
);

-- The site itself belongs to the CLIENT workspace. No sales notes, no proposal, no lead id.
create table if not exists public.client_sites (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null default public.my_business_id() references public.businesses(id) on delete cascade,
  public_token     uuid not null default gen_random_uuid() unique,
  origin_key       text not null default 'primary' check (origin_key ~ '^[a-z0-9:_-]{1,40}$'),
  status           text not null default 'draft' check (status in ('draft','ready','shared','live','paused')),
  capture_enabled  boolean not null default false,
  approved_at      timestamptz,
  template         text not null default 'plain' check (template in ('plain','bold')),
  accent           text not null default '#334155' check (accent ~ '^#[0-9a-fA-F]{6}$'),
  business_name    text not null check (char_length(business_name) between 1 and 120),
  trade            text not null default '' check (char_length(trade) <= 160),
  phone            text not null default '' check (char_length(phone) <= 40),
  email            text not null default '' check (char_length(email) <= 200),
  service_area     text not null default '' check (char_length(service_area) <= 120),
  about            text not null default '' check (char_length(about) <= 2000),
  services         jsonb not null default '[]'::jsonb,
  workspace_note   text not null default '' check (char_length(workspace_note) <= 5000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (business_id, id),
  unique (business_id, origin_key)
);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_sites_services_shape' and conrelid = 'public.client_sites'::regclass) then
    alter table public.client_sites add constraint client_sites_services_shape check (
      jsonb_typeof(services) = 'array' and jsonb_array_length(services) <= 12 and octet_length(services::text) <= 8000);
  end if;
end $$;

-- People who wrote through a client site. Not Mashad's sales leads.
create table if not exists public.client_enquiries (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  client_site_id uuid not null,
  name           text not null check (char_length(name) between 1 and 200),
  phone          text not null default '' check (char_length(phone) <= 40),
  email          text not null default '' check (char_length(email) <= 200),
  service        text not null default '' check (char_length(service) <= 200),
  message        text not null default '' check (char_length(message) <= 2000),
  sms_ok         boolean not null default false,
  source         text not null default 'Website form' check (char_length(source) <= 80),
  status         text not null default 'new' check (status in ('new','contacted','closed')),
  created_at     timestamptz not null default now(),
  foreign key (business_id, client_site_id) references public.client_sites (business_id, id) on delete cascade
);

-- Private to the sales account: proposal text, provenance, link back to the sales lead.
create table if not exists public.site_proposals (
  id                  uuid primary key default gen_random_uuid(),
  business_id         uuid not null default public.my_business_id() references public.businesses(id) on delete cascade,
  client_business_id  uuid not null,
  client_site_id      uuid,
  lead_id             uuid,
  client_key          text not null check (client_key ~ '^[A-Za-z0-9:_-]{2,80}$'),
  to_email            text not null default '' check (char_length(to_email) <= 320),
  email_confidence    text not null default 'unknown' check (email_confidence in ('verified','medium','unknown')),
  email_note          text not null default '' check (char_length(email_note) <= 500),
  subject             text not null default '' check (char_length(subject) <= 500),
  body                text not null default '' check (char_length(body) <= 20000),
  provenance          text not null default '' check (char_length(provenance) <= 4000),
  notes               text not null default '' check (char_length(notes) <= 5000),
  status              text not null default 'draft' check (status in ('draft','sent')),
  sent_at             timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (status = 'draft' or sent_at is not null),
  unique (business_id, client_key),
  foreign key (business_id, lead_id) references public.leads (business_id, id) on delete set null
);

create index if not exists client_accounts_biz on public.client_accounts (business_id);
create index if not exists client_sites_biz on public.client_sites (business_id);
create index if not exists client_enquiries_biz on public.client_enquiries (business_id, created_at desc);
create index if not exists client_enquiries_site on public.client_enquiries (client_site_id, created_at desc);
create index if not exists site_proposals_biz on public.site_proposals (business_id, created_at desc);

alter table public.client_accounts enable row level security;
alter table public.client_sites enable row level security;
alter table public.client_enquiries enable row level security;
alter table public.site_proposals enable row level security;

revoke all on public.client_accounts, public.client_sites, public.client_enquiries, public.site_proposals from anon, authenticated;
grant select, insert, update, delete on public.client_accounts, public.client_sites, public.site_proposals to authenticated;
grant select, update, delete on public.client_enquiries to authenticated;
-- anon has no table grant. Enquiries are inserted only by the security definer function.

drop policy if exists client_accounts_member_all on public.client_accounts;
create policy client_accounts_member_all on public.client_accounts for all to authenticated
  using (public.is_member(business_id))
  with check (public.is_member(business_id) and public.is_member(client_business_id));
drop policy if exists client_sites_member_all on public.client_sites;
create policy client_sites_member_all on public.client_sites for all to authenticated
  using (public.is_member(business_id))
  with check (public.is_member(business_id));
drop policy if exists client_enquiries_select on public.client_enquiries;
create policy client_enquiries_select on public.client_enquiries for select to authenticated
  using (public.is_member(business_id));
drop policy if exists client_enquiries_update on public.client_enquiries;
create policy client_enquiries_update on public.client_enquiries for update to authenticated
  using (public.is_member(business_id)) with check (public.is_member(business_id));
drop policy if exists client_enquiries_delete on public.client_enquiries;
create policy client_enquiries_delete on public.client_enquiries for delete to authenticated
  using (public.is_member(business_id));
drop policy if exists site_proposals_member_all on public.site_proposals;
create policy site_proposals_member_all on public.site_proposals for all to authenticated
  using (public.is_member(business_id))
  with check (public.is_member(business_id) and public.is_member(client_business_id));

create or replace function public.keep_client_account() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.business_id := old.business_id;
    new.client_business_id := old.client_business_id;
    new.client_key := old.client_key;
    new.name_key := old.name_key;
    new.created_at := old.created_at;
    if old.lead_id is not null then new.lead_id := old.lead_id; end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_keep_client_account on public.client_accounts;
create trigger trg_keep_client_account before update on public.client_accounts
  for each row execute function public.keep_client_account();

create or replace function public.guard_client_site() returns trigger
language plpgsql set search_path = public as $$
declare kind text;
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.business_id := old.business_id;
    new.public_token := old.public_token;
    new.origin_key := old.origin_key;
    new.created_at := old.created_at;
  end if;
  select workspace_kind into kind from public.businesses where id = new.business_id;
  if kind is distinct from 'client' then
    raise exception 'Sites belong to a client workspace.';
  end if;
  if tg_op = 'INSERT' and new.capture_enabled then
    raise exception 'Turn enquiries on only after the site is live and the business has approved it.';
  end if;
  if tg_op = 'UPDATE' and new.capture_enabled and not old.capture_enabled
     and (new.status <> 'live' or new.approved_at is null) then
    raise exception 'Turn enquiries on only after the site is live and the business has approved it.';
  end if;
  if new.status <> 'live' then
    new.capture_enabled := false;
  end if;
  if new.status = 'live' and new.approved_at is null then
    raise exception 'Mark the business as approved before making the site live.';
  end if;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists trg_guard_client_site on public.client_sites;
create trigger trg_guard_client_site before insert or update on public.client_sites
  for each row execute function public.guard_client_site();

create or replace function public.guard_client_enquiry() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.business_id := old.business_id;
    new.client_site_id := old.client_site_id;
    new.name := old.name;
    new.phone := old.phone;
    new.email := old.email;
    new.service := old.service;
    new.message := old.message;
    new.sms_ok := old.sms_ok;
    new.source := old.source;
    new.created_at := old.created_at;
  end if;
  return new;
end $$;
drop trigger if exists trg_guard_client_enquiry on public.client_enquiries;
create trigger trg_guard_client_enquiry before update on public.client_enquiries
  for each row execute function public.guard_client_enquiry();

create or replace function public.keep_site_proposal() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.id := old.id;
    new.business_id := old.business_id;
    new.client_business_id := old.client_business_id;
    new.client_key := old.client_key;
    new.created_at := old.created_at;
    if old.lead_id is not null then new.lead_id := old.lead_id; end if;
    if old.client_site_id is not null then new.client_site_id := old.client_site_id; end if;
    if new.status = 'sent' and new.sent_at is null then
      raise exception 'Sent is only for an email you already sent yourself.';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_keep_site_proposal on public.site_proposals;
create trigger trg_keep_site_proposal before update on public.site_proposals
  for each row execute function public.keep_site_proposal();

-- Photos: members can use any workspace they belong to, not only the home account.
create or replace function public.is_member_text(folder text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when folder ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then public.is_member(folder::uuid) else false end
$$;

drop policy if exists job_photos_select_member on storage.objects;
create policy job_photos_select_member on storage.objects for select to authenticated
  using (bucket_id = 'job-photos' and public.is_member_text((storage.foldername(name))[1]));
drop policy if exists job_photos_insert_member on storage.objects;
create policy job_photos_insert_member on storage.objects for insert to authenticated
  with check (bucket_id = 'job-photos' and public.is_member_text((storage.foldername(name))[1]));
drop policy if exists job_photos_update_member on storage.objects;
create policy job_photos_update_member on storage.objects for update to authenticated
  using (bucket_id = 'job-photos' and public.is_member_text((storage.foldername(name))[1]))
  with check (bucket_id = 'job-photos' and public.is_member_text((storage.foldername(name))[1]));
drop policy if exists job_photos_delete_member on storage.objects;
create policy job_photos_delete_member on storage.objects for delete to authenticated
  using (bucket_id = 'job-photos' and public.is_member_text((storage.foldername(name))[1]));

-- Private schema: not part of the Data API. Bodies of privileged functions live here.
create schema if not exists crm_private;
revoke all on schema crm_private from public;
grant usage on schema crm_private to anon, authenticated;

create table if not exists crm_private.site_submit_log (
  id bigserial primary key,
  client_site_id uuid not null,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists site_submit_log_site on crm_private.site_submit_log (client_site_id, created_at desc);
create index if not exists site_submit_log_ip on crm_private.site_submit_log (ip, created_at desc);
alter table crm_private.site_submit_log enable row level security;
revoke all on crm_private.site_submit_log from public, anon, authenticated;

create or replace function crm_private.bootstrap_client_preview(
  p_sales_business_id uuid,
  p_client_key text,
  p_name text,
  p_lead_id uuid,
  p_site jsonb,
  p_proposal jsonb
) returns jsonb
language plpgsql security definer set search_path = public, crm_private as $$
declare
  v_uid uuid := auth.uid();
  v_key text := btrim(coalesce(p_client_key, ''));
  v_name text := btrim(coalesce(p_name, ''));
  v_name_key text;
  v_client uuid;
  v_site uuid;
  v_token uuid;
  v_reused_ws boolean := false;
  v_reused_site boolean := false;
  v_reused_pr boolean := false;
  v_services jsonb := '[]'::jsonb;
  v_email text;
  v_accent text;
  v_template text;
  v_conf text;
  v_to text;
begin
  if v_uid is null then raise exception 'Sign in required.'; end if;
  if not exists (
    select 1 from public.members
     where business_id = p_sales_business_id and user_id = v_uid and role = 'owner'
  ) then
    raise exception 'Only the owner of that account can open a client workspace.';
  end if;
  if not exists (
    select 1 from public.businesses
     where id = p_sales_business_id and workspace_kind = 'own'
  ) then
    raise exception 'Open a client workspace from your own account.';
  end if;
  if v_key !~ '^[A-Za-z0-9:_-]{2,80}$' then raise exception 'Missing a stable client key.'; end if;
  if char_length(v_name) < 1 or char_length(v_name) > 120 then raise exception 'Enter the business name.'; end if;
  if p_lead_id is not null and not exists (
    select 1 from public.leads where id = p_lead_id and business_id = p_sales_business_id
  ) then
    raise exception 'That sales lead is not in this account.';
  end if;
  v_name_key := lower(regexp_replace(v_name, '\s+', ' ', 'g'));
  select client_business_id into v_client from public.client_accounts
   where business_id = p_sales_business_id and (client_key = v_key or name_key = v_name_key)
   limit 1;
  if v_client is null then
    insert into public.businesses (name, owner_id, workspace_kind, claim_status, lead_form_enabled)
    values (v_name, null, 'client', 'invite_pending', false)
    returning id into v_client;
    insert into public.members (business_id, user_id, role) values (v_client, v_uid, 'manager');
    insert into public.client_accounts (business_id, client_business_id, client_key, name_key, lead_id, setup_status)
    values (p_sales_business_id, v_client, v_key, v_name_key, p_lead_id, 'invite_pending');
  else
    v_reused_ws := true;
    if p_lead_id is not null then
      update public.client_accounts set lead_id = p_lead_id
       where business_id = p_sales_business_id and client_business_id = v_client and lead_id is null;
    end if;
  end if;

  if jsonb_typeof(coalesce(p_site, '{}'::jsonb)->'services') = 'array' then
    select coalesce(jsonb_agg(jsonb_build_object('name', left(name, 80), 'detail', left(detail, 300))), '[]'::jsonb)
      into v_services
    from (
      select btrim(e->>'name') as name, btrim(coalesce(e->>'detail', '')) as detail
      from jsonb_array_elements(p_site->'services') e
      where btrim(coalesce(e->>'name', '')) <> ''
      limit 12
    ) s;
  end if;
  v_email := left(btrim(coalesce(p_site->>'email', '')), 200);
  if v_email <> '' and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then v_email := ''; end if;
  v_accent := coalesce(p_site->>'accent', '#334155');
  if v_accent !~ '^#[0-9a-fA-F]{6}$' then v_accent := '#334155'; end if;
  v_template := case when p_site->>'template' = 'bold' then 'bold' else 'plain' end;

  select id, public_token into v_site, v_token from public.client_sites
   where business_id = v_client and origin_key = 'primary';
  if v_site is null then
    insert into public.client_sites (
      business_id, origin_key, status, capture_enabled, template, accent, business_name,
      trade, phone, email, service_area, about, services
    ) values (
      v_client, 'primary', 'draft', false, v_template, v_accent,
      left(coalesce(nullif(btrim(p_site->>'business_name'), ''), v_name), 120),
      left(btrim(coalesce(p_site->>'trade', '')), 160),
      left(btrim(coalesce(p_site->>'phone', '')), 40),
      v_email,
      left(btrim(coalesce(p_site->>'service_area', '')), 120),
      left(btrim(coalesce(p_site->>'about', '')), 2000),
      coalesce(v_services, '[]'::jsonb)
    ) returning id, public_token into v_site, v_token;
  else
    v_reused_site := true;
  end if;

  v_conf := case coalesce(p_proposal->>'email_confidence', '')
    when 'verified' then 'verified' when 'medium' then 'medium' else 'unknown' end;
  v_to := left(btrim(coalesce(p_proposal->>'to_email', '')), 320);
  if v_to <> '' and v_to !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then v_to := ''; end if;
  if exists (select 1 from public.site_proposals where business_id = p_sales_business_id and client_key = v_key) then
    v_reused_pr := true;
    update public.site_proposals set client_site_id = v_site
     where business_id = p_sales_business_id and client_key = v_key and client_site_id is null;
  else
    insert into public.site_proposals (
      business_id, client_business_id, client_site_id, lead_id, client_key,
      to_email, email_confidence, email_note, subject, body, provenance, notes, status
    ) values (
      p_sales_business_id, v_client, v_site, p_lead_id, v_key,
      v_to, v_conf,
      left(btrim(coalesce(p_proposal->>'email_note', '')), 500),
      left(btrim(coalesce(p_proposal->>'subject', '')), 500),
      left(coalesce(p_proposal->>'body', ''), 20000),
      left(coalesce(p_proposal->>'provenance', ''), 4000),
      left(coalesce(p_proposal->>'notes', ''), 5000),
      'draft'
    );
  end if;

  return jsonb_build_object(
    'client_business_id', v_client,
    'site_id', v_site,
    'public_token', v_token,
    'reused_workspace', v_reused_ws,
    'reused_site', v_reused_site,
    'reused_proposal', v_reused_pr
  );
end $$;

create or replace function crm_private.get_public_site(p_token uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'business_name', s.business_name,
    'trade', s.trade,
    'phone', s.phone,
    'email', s.email,
    'service_area', s.service_area,
    'about', s.about,
    'services', s.services,
    'template', s.template,
    'accent', s.accent,
    'status', s.status,
    'capture_enabled', (s.capture_enabled and s.status = 'live' and s.approved_at is not null),
    'collects', (s.capture_enabled and s.status = 'live' and s.approved_at is not null),
    'public_token', s.public_token
  )
  from public.client_sites s
  where s.public_token = p_token
$$;

create or replace function crm_private.submit_site_enquiry(
  p_token uuid,
  p_name text,
  p_phone text,
  p_email text,
  p_service text,
  p_message text,
  p_sms_ok boolean,
  p_source text,
  p_started_at timestamptz,
  p_website text,
  p_company_fax text
) returns uuid
language plpgsql security definer set search_path = public, crm_private as $$
declare
  v_site public.client_sites%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_phone text := left(btrim(coalesce(p_phone, '')), 40);
  v_email text := left(btrim(coalesce(p_email, '')), 200);
  v_service text := left(btrim(coalesce(p_service, '')), 200);
  v_message text := left(btrim(coalesce(p_message, '')), 2000);
  v_source text := btrim(coalesce(p_source, ''));
  v_ip text;
  v_id uuid;
  v_count int;
begin
  if btrim(coalesce(p_website, '')) <> '' or btrim(coalesce(p_company_fax, '')) <> '' then
    raise exception 'That did not go through.';
  end if;
  if p_started_at is null
     or p_started_at > now() + interval '2 minutes'
     or p_started_at < now() - interval '1 day'
     or p_started_at > now() - interval '3 seconds' then
    raise exception 'That did not go through.';
  end if;
  select * into v_site from public.client_sites where public_token = p_token;
  if not found then raise exception 'This preview link is not active.'; end if;
  if not (v_site.capture_enabled and v_site.status = 'live' and v_site.approved_at is not null) then
    raise exception 'This page is not collecting enquiries.';
  end if;
  if char_length(v_name) < 1 or char_length(v_name) > 200 then raise exception 'Please enter your name.'; end if;
  if v_phone = '' and v_email = '' then raise exception 'Please enter a phone number or email so the business can reply.'; end if;
  if v_email <> '' and v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'That email address looks incomplete.';
  end if;
  if v_source !~ '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,40}$' then v_source := 'Website form'; end if;
  select count(*) into v_count from public.client_enquiries
   where client_site_id = v_site.id and created_at > now() - interval '1 hour';
  if v_count >= 10 then raise exception 'Too many requests. Please try again later.'; end if;
  begin
    v_ip := nullif(split_part(coalesce(current_setting('request.headers', true)::json->>'x-forwarded-for', ''), ',', 1), '');
  exception when others then v_ip := null;
  end;
  if v_ip is not null then
    select count(*) into v_count from crm_private.site_submit_log
     where ip = v_ip and created_at > now() - interval '1 hour';
    if v_count >= 5 then raise exception 'Too many requests. Please try again later.'; end if;
  end if;
  insert into public.client_enquiries (business_id, client_site_id, name, phone, email, service, message, sms_ok, source, status)
  values (v_site.business_id, v_site.id, v_name, v_phone, v_email, v_service, v_message,
          coalesce(p_sms_ok, false) and v_phone <> '', v_source, 'new')
  returning id into v_id;
  insert into crm_private.site_submit_log (client_site_id, ip) values (v_site.id, v_ip);
  if v_id is null then raise exception 'That did not go through.'; end if;
  return v_id;
end $$;

create or replace function public.bootstrap_client_preview(p_sales_business_id uuid, p_client_key text, p_name text, p_lead_id uuid, p_site jsonb, p_proposal jsonb)
returns jsonb language plpgsql security invoker set search_path = public, crm_private as $$
begin
  return crm_private.bootstrap_client_preview(p_sales_business_id, p_client_key, p_name, p_lead_id, p_site, p_proposal);
end $$;

create or replace function public.get_public_site(p_token uuid)
returns jsonb language plpgsql security invoker set search_path = public, crm_private as $$
begin
  return crm_private.get_public_site(p_token);
end $$;

create or replace function public.submit_site_enquiry(
  p_token uuid, p_name text, p_phone text, p_email text, p_service text, p_message text,
  p_sms_ok boolean, p_source text, p_started_at timestamptz, p_website text, p_company_fax text
) returns uuid language plpgsql security invoker set search_path = public, crm_private as $$
begin
  return crm_private.submit_site_enquiry(p_token, p_name, p_phone, p_email, p_service, p_message, p_sms_ok, p_source, p_started_at, p_website, p_company_fax);
end $$;

revoke all on function
  public.normalize_business_insert(), public.keep_client_account(), public.guard_client_site(),
  public.guard_client_enquiry(), public.keep_site_proposal(), public.is_member_text(text),
  public.bootstrap_client_preview(uuid, text, text, uuid, jsonb, jsonb),
  public.get_public_site(uuid),
  public.submit_site_enquiry(uuid, text, text, text, text, text, boolean, text, timestamptz, text, text),
  crm_private.bootstrap_client_preview(uuid, text, text, uuid, jsonb, jsonb),
  crm_private.get_public_site(uuid),
  crm_private.submit_site_enquiry(uuid, text, text, text, text, text, boolean, text, timestamptz, text, text)
from public;

grant execute on function public.bootstrap_client_preview(uuid, text, text, uuid, jsonb, jsonb) to authenticated;
grant execute on function crm_private.bootstrap_client_preview(uuid, text, text, uuid, jsonb, jsonb) to authenticated;
grant execute on function public.get_public_site(uuid), public.submit_site_enquiry(uuid, text, text, text, text, text, boolean, text, timestamptz, text, text) to anon, authenticated;
grant execute on function crm_private.get_public_site(uuid), crm_private.submit_site_enquiry(uuid, text, text, text, text, text, boolean, text, timestamptz, text, text) to anon, authenticated;
grant execute on function public.is_member_text(text) to authenticated;
