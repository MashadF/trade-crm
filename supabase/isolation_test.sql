-- =====================================================================
-- Cross-business isolation test for schema.sql
-- Safe to run in the Supabase SQL Editor AFTER schema.sql: everything runs
-- inside one transaction that is ROLLED BACK at the end, so no test data stays.
-- Success = the last message says "ALL ISOLATION TESTS PASSED".
-- Any failure raises an error starting with "FAIL".
-- =====================================================================
begin;

-- helpers: act as a signed-in user, as the public (anon) visitor, or as admin again
create or replace function pg_temp.login(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', uid::text, true);
  perform set_config('role', 'authenticated', true);
end $$;
create or replace function pg_temp.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('role', 'anon', true);
end $$;

-- two test accounts (A and B) + one with no business yet (C)
insert into auth.users (id, email) values
  ('aaaaaaaa-0000-0000-0000-00000000000a', 'iso-test-a@example.com'),
  ('bbbbbbbb-0000-0000-0000-00000000000b', 'iso-test-b@example.com'),
  ('cccccccc-0000-0000-0000-00000000000c', 'iso-test-c@example.com');

-- 1. Each user creates their own business and some data
select pg_temp.login('aaaaaaaa-0000-0000-0000-00000000000a');
insert into public.businesses (id, name) values ('a1a1a1a1-0000-0000-0000-000000000001', 'A Handyman');
insert into public.customers (id, name, phone) values ('a2a2a2a2-0000-0000-0000-000000000001', 'A Customer', '555-0001');
insert into public.documents (id, kind, number, status, customer_id, share_token)
  values ('a3a3a3a3-0000-0000-0000-000000000001', 'quote', 'Q-1', 'sent', 'a2a2a2a2-0000-0000-0000-000000000001', 'a4a4a4a4-0000-0000-0000-000000000001');
insert into public.documents (id, kind, number, status) values ('a3a3a3a3-0000-0000-0000-000000000002', 'quote', 'Q-2', 'draft');
reset role;

select pg_temp.login('bbbbbbbb-0000-0000-0000-00000000000b');
insert into public.businesses (id, name) values ('b1b1b1b1-0000-0000-0000-000000000001', 'B Lawn Care');
insert into public.customers (id, name) values ('b2b2b2b2-0000-0000-0000-000000000001', 'B Customer');
reset role;

-- 2. B cannot see, change or delete A's rows
do $$
declare n int; ok boolean;
begin
  perform pg_temp.login('bbbbbbbb-0000-0000-0000-00000000000b');
  select count(*) into n from public.customers where business_id = 'a1a1a1a1-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'FAIL 2a: B can read A customers'; end if;
  select count(*) into n from public.customers;
  if n <> 1 then raise exception 'FAIL 2b: B should see exactly its own 1 customer, saw %', n; end if;
  select count(*) into n from public.businesses;
  if n <> 1 then raise exception 'FAIL 2c: B sees % businesses', n; end if;
  select count(*) into n from public.documents;
  if n <> 0 then raise exception 'FAIL 2d: B can read A documents'; end if;
  update public.customers set name = 'hacked' where id = 'a2a2a2a2-0000-0000-0000-000000000001';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 2e: B updated A customer'; end if;
  delete from public.customers where id = 'a2a2a2a2-0000-0000-0000-000000000001';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 2f: B deleted A customer'; end if;
  update public.businesses set name = 'hacked' where id = 'a1a1a1a1-0000-0000-0000-000000000001';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 2g: B renamed A business'; end if;
  -- 3. B cannot write rows into A's business
  ok := false;
  begin insert into public.customers (business_id, name) values ('a1a1a1a1-0000-0000-0000-000000000001', 'planted');
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 3a: B inserted into A business'; end if;
  ok := false;
  begin update public.customers set business_id = 'a1a1a1a1-0000-0000-0000-000000000001' where id = 'b2b2b2b2-0000-0000-0000-000000000001';
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 3b: B moved a row into A business'; end if;
  -- 4. B cannot link its job to A's customer (composite foreign key)
  ok := false;
  begin insert into public.jobs (customer_id, title) values ('a2a2a2a2-0000-0000-0000-000000000001', 'x');
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 4: B referenced A customer'; end if;
  -- 5. B cannot create a second business or join A's
  ok := false;
  begin insert into public.businesses (name) values ('second biz'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 5a: second business allowed'; end if;
  ok := false;
  begin insert into public.members (business_id, user_id) values ('a1a1a1a1-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-00000000000b');
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 5b: B joined A business'; end if;
  -- 6. storage: B cannot upload into A's photo folder, can into its own
  ok := false;
  begin insert into storage.objects (bucket_id, name) values ('job-photos', 'a1a1a1a1-0000-0000-0000-000000000001/job/x.jpg');
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 6a: B uploaded into A photo folder'; end if;
  insert into storage.objects (bucket_id, name) values ('job-photos', 'b1b1b1b1-0000-0000-0000-000000000001/job/ok.jpg');
  perform set_config('role', 'none', true);
end $$;
reset role;

-- A's data is untouched; A cannot see B's photo
do $$
declare n int;
begin
  perform pg_temp.login('aaaaaaaa-0000-0000-0000-00000000000a');
  select count(*) into n from public.customers where name = 'A Customer';
  if n <> 1 then raise exception 'FAIL 7a: A customer changed or missing'; end if;
  select count(*) into n from storage.objects where bucket_id = 'job-photos';
  if n <> 0 then raise exception 'FAIL 7b: A can see B photos'; end if;
  perform set_config('role', 'none', true);
end $$;
reset role;

-- 8. Public (anon) visitor: can submit a lead, cannot read anything
do $$
declare n int; ok boolean; j jsonb;
begin
  perform pg_temp.as_anon();
  insert into public.leads (business_id, name, phone, message, sms_ok) values ('a1a1a1a1-0000-0000-0000-000000000001', 'Web Lead', '555-0100', 'Need a TV mounted', true);
  ok := false;
  begin perform 1 from public.leads limit 1; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 8a: anon can read leads'; end if;
  ok := false;
  begin perform 1 from public.customers limit 1; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 8b: anon can read customers'; end if;
  ok := false;
  begin insert into public.leads (business_id, name, status) values ('a1a1a1a1-0000-0000-0000-000000000001', 'x', 'won');
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 8c: anon could set lead status'; end if;
  ok := false;
  begin insert into public.leads (business_id, name) values ('99999999-0000-0000-0000-000000000000', 'x');
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 8d: anon lead into non-existent business'; end if;
  -- token links: a sent quote is viewable by token, a draft is not, a random token is not
  j := public.get_public_document('a4a4a4a4-0000-0000-0000-000000000001');
  if j is null or j->'doc'->>'number' <> 'Q-1' then raise exception 'FAIL 8e: share link did not load'; end if;
  if j ? 'business_id' or (j->'doc') ? 'business_id' then raise exception 'FAIL 8f: share link leaks ids'; end if;
  if public.get_public_document(gen_random_uuid()) is not null then raise exception 'FAIL 8g: random token returned data'; end if;
  ok := false;
  begin perform public.accept_quote('a4a4a4a4-0000-0000-0000-000000000001', ' '); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 8h: blank name accepted'; end if;
  j := public.accept_quote('a4a4a4a4-0000-0000-0000-000000000001', 'Pat Customer');
  if j->'doc'->>'status' <> 'accepted' or j->'doc'->>'accepted_name' <> 'Pat Customer' then raise exception 'FAIL 8i: accept failed'; end if;
  ok := false;
  begin perform public.accept_quote('a4a4a4a4-0000-0000-0000-000000000001', 'Again'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 8j: accepted twice'; end if;
  perform set_config('role', 'none', true);
end $$;
reset role;

-- 9. The lead landed in A's inbox only, and B cannot see it
do $$
declare n int;
begin
  perform pg_temp.login('aaaaaaaa-0000-0000-0000-00000000000a');
  select count(*) into n from public.leads where name = 'Web Lead';
  if n <> 1 then raise exception 'FAIL 9a: A does not see its web lead'; end if;
  perform set_config('role', 'none', true);
  perform pg_temp.login('bbbbbbbb-0000-0000-0000-00000000000b');
  select count(*) into n from public.leads;
  if n <> 0 then raise exception 'FAIL 9b: B sees A leads'; end if;
  perform set_config('role', 'none', true);
end $$;
reset role;

-- 9b. Email log: A's emails are private to A (drafts, sent log, replied mark)
do $$
declare n int; ok boolean; a_lead uuid; b_cust uuid := 'b2b2b2b2-0000-0000-0000-000000000001';
begin
  perform pg_temp.login('aaaaaaaa-0000-0000-0000-00000000000a');
  select id into a_lead from public.leads where name = 'Web Lead';
  insert into public.emails (id, lead_id, to_email, subject, body, status, sent_at)
    values ('a5a5a5a5-0000-0000-0000-000000000001', a_lead, 'web@example.com', 'Hi', 'Body', 'sent', now());
  insert into public.emails (lead_id, subject, status) values (a_lead, 'Draft', 'draft');
  update public.emails set replied_at = now() where id = 'a5a5a5a5-0000-0000-0000-000000000001';
  get diagnostics n = row_count; if n <> 1 then raise exception 'FAIL 11a: A could not mark own email replied'; end if;
  select count(*) into n from public.emails; if n <> 2 then raise exception 'FAIL 11b: A sees % emails', n; end if;
  ok := false;
  begin insert into public.emails (lead_id, status) values (a_lead, 'sent'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 11c: sent email without sent_at allowed'; end if;
  ok := false;
  begin insert into public.emails (status) values ('draft'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 11d: email with no lead or customer allowed'; end if;
  perform set_config('role', 'none', true);
  perform pg_temp.login('bbbbbbbb-0000-0000-0000-00000000000b');
  select count(*) into n from public.emails; if n <> 0 then raise exception 'FAIL 11e: B can read A emails'; end if;
  update public.emails set subject = 'hacked', replied_at = now() where id = 'a5a5a5a5-0000-0000-0000-000000000001';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 11f: B updated A email'; end if;
  delete from public.emails where id = 'a5a5a5a5-0000-0000-0000-000000000001';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 11g: B deleted A email'; end if;
  ok := false;
  begin insert into public.emails (business_id, customer_id, status) values ('a1a1a1a1-0000-0000-0000-000000000001', 'a2a2a2a2-0000-0000-0000-000000000001', 'draft');
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 11h: B inserted email into A business'; end if;
  ok := false;
  begin insert into public.emails (lead_id, status) values (a_lead, 'draft'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 11i: B linked an email to A lead'; end if;
  insert into public.emails (customer_id, subject, status) values (b_cust, 'B own draft', 'draft');
  perform set_config('role', 'none', true);
  perform pg_temp.as_anon();
  ok := false;
  begin perform 1 from public.emails limit 1; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 11j: anon can read emails'; end if;
  ok := false;
  begin insert into public.emails (business_id, lead_id, status) values ('a1a1a1a1-0000-0000-0000-000000000001', a_lead, 'draft'); exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 11k: anon inserted an email'; end if;
  perform set_config('role', 'none', true);
end $$;
reset role;

-- 10. Deleting a business (delete-my-data) removes all its rows and nobody else's
do $$
declare n int;
begin
  perform pg_temp.login('bbbbbbbb-0000-0000-0000-00000000000b');
  delete from public.businesses where id = 'a1a1a1a1-0000-0000-0000-000000000001';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 10a: B deleted A business'; end if;
  delete from public.businesses where id = 'b1b1b1b1-0000-0000-0000-000000000001';
  get diagnostics n = row_count; if n <> 1 then raise exception 'FAIL 10b: B could not delete own business'; end if;
  perform set_config('role', 'none', true);
end $$;
reset role;
do $$
declare n int;
begin
  select count(*) into n from public.customers where business_id = 'b1b1b1b1-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'FAIL 10c: B rows left after delete'; end if;
  select count(*) into n from public.customers where business_id = 'a1a1a1a1-0000-0000-0000-000000000001';
  if n <> 1 then raise exception 'FAIL 10d: A rows affected by B delete'; end if;
  select count(*) into n from public.emails where business_id = 'b1b1b1b1-0000-0000-0000-000000000001';
  if n <> 0 then raise exception 'FAIL 10e: B emails left after delete'; end if;
  select count(*) into n from public.emails where business_id = 'a1a1a1a1-0000-0000-0000-000000000001';
  if n <> 2 then raise exception 'FAIL 10f: A emails affected by B delete'; end if;
  raise notice 'ALL ISOLATION TESTS PASSED';
end $$;

rollback;
