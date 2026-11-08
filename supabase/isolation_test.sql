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

-- 9c. Saved services and prices: private to the business (v2.8)
do $$
declare n int; ok boolean := false;
begin
  perform pg_temp.login('aaaaaaaa-0000-0000-0000-00000000000a');
  update public.businesses set services = '[{"id":"s1","name":"Mount TV","price":149,"note":"secret price list"}]'::jsonb where id = 'a1a1a1a1-0000-0000-0000-000000000001';
  get diagnostics n = row_count; if n <> 1 then raise exception 'FAIL 9c-a: A could not save its services'; end if;
  begin update public.businesses set services = '{"not":"a list"}'::jsonb where id = 'a1a1a1a1-0000-0000-0000-000000000001'; exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL 9c-b: services accepted a non-list'; end if;
  perform set_config('role', 'none', true);
end $$;
reset role;
do $$
declare n int; t text;
begin
  perform pg_temp.login('bbbbbbbb-0000-0000-0000-00000000000b');
  select count(*) into n from public.businesses where services::text like '%secret price list%';
  if n <> 0 then raise exception 'FAIL 9c-c: B can read A services'; end if;
  update public.businesses set services = '[]'::jsonb where id = 'a1a1a1a1-0000-0000-0000-000000000001';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 9c-d: B changed A services'; end if;
  perform set_config('role', 'none', true);
  perform pg_temp.as_anon();
  select public.get_public_document('a4a4a4a4-0000-0000-0000-000000000001')::text into t;
  if t like '%secret price list%' or t like '%services%' then raise exception 'FAIL 9c-e: public quote link leaks the services list'; end if;
  perform set_config('role', 'none', true);
end $$;
reset role;
do $$
declare n int;
begin
  select count(*) into n from public.businesses where id = 'a1a1a1a1-0000-0000-0000-000000000001' and services->0->>'note' = 'secret price list';
  if n <> 1 then raise exception 'FAIL 9c-f: A services not kept'; end if;
end $$;

-- 12. Client workspaces: separate tenant per client, manager is not owner, public capture is token-only.
do $$
declare
  n int; ok boolean; j jsonb; a_lead uuid; c1 uuid; c2 uuid; t1 uuid; t2 uuid; s1 uuid; enq uuid;
begin
  select id into a_lead from public.leads where name = 'Web Lead';
  perform pg_temp.login('aaaaaaaa-0000-0000-0000-00000000000a');
  j := public.bootstrap_client_preview(
    'a1a1a1a1-0000-0000-0000-000000000001', 'lead:web-lead', 'Preview Painting Co', a_lead,
    jsonb_build_object('business_name','Preview Painting Co','trade','Painting','phone','(404) 555-0101',
      'email','paint@example.com','service_area','Example City','about','Interior painting.',
      'services', jsonb_build_array(jsonb_build_object('name','Interior painting','detail','')),
      'template','plain','accent','#334155'),
    jsonb_build_object('to_email','paint@example.com','email_confidence','verified','subject','Preview',
      'body','SECRET-PROPOSAL-NOTE','provenance','example source','notes','sales only'));
  c1 := (j->>'client_business_id')::uuid; s1 := (j->>'site_id')::uuid; t1 := (j->>'public_token')::uuid;
  if c1 is null or s1 is null or t1 is null then raise exception 'FAIL 12a: bootstrap returned no ids'; end if;
  if (j->>'reused_workspace')::boolean then raise exception 'FAIL 12b: first workspace was reused'; end if;
  select count(*) into n from public.members where business_id = c1 and user_id = 'aaaaaaaa-0000-0000-0000-00000000000a' and role = 'manager';
  if n <> 1 then raise exception 'FAIL 12c: creator is not the manager'; end if;
  select count(*) into n from public.members where business_id = c1 and role = 'owner';
  if n <> 0 then raise exception 'FAIL 12d: client workspace got an owner'; end if;
  select count(*) into n from public.businesses where id = c1 and owner_id is null and claim_status = 'invite_pending' and workspace_kind = 'client' and lead_form_enabled = false;
  if n <> 1 then raise exception 'FAIL 12e: workspace not invite-pending'; end if;
  select count(*) into n from public.client_sites where id = s1 and business_id = c1 and status = 'draft' and capture_enabled = false;
  if n <> 1 then raise exception 'FAIL 12f: site not a draft on the client workspace'; end if;
  select count(*) into n from public.site_proposals where business_id = 'a1a1a1a1-0000-0000-0000-000000000001' and client_business_id = c1 and lead_id = a_lead and body like '%SECRET-PROPOSAL-NOTE%';
  if n <> 1 then raise exception 'FAIL 12g: proposal not kept on the sales account'; end if;
  j := public.bootstrap_client_preview(
    'a1a1a1a1-0000-0000-0000-000000000001', 'lead:web-lead', 'Preview Painting Co', a_lead, '{}'::jsonb, '{}'::jsonb);
  if (j->>'client_business_id')::uuid <> c1 or (j->>'reused_workspace')::boolean is not true then
    raise exception 'FAIL 12h: repeat generation created another workspace';
  end if;
  select count(*) into n from public.businesses where name = 'Preview Painting Co';
  if n <> 1 then raise exception 'FAIL 12i: duplicate tenant'; end if;
  j := public.bootstrap_client_preview(
    'a1a1a1a1-0000-0000-0000-000000000001', 'example:second', 'Second Client Co', null, '{}'::jsonb, '{}'::jsonb);
  c2 := (j->>'client_business_id')::uuid; t2 := (j->>'public_token')::uuid;
  if c2 = c1 then raise exception 'FAIL 12j: different clients shared a workspace'; end if;
  ok := false;
  begin update public.client_sites set capture_enabled = true where id = s1;
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12k: capture turned on while draft'; end if;
  ok := false;
  begin update public.client_sites set status = 'live' where id = s1;
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12l: live without approval'; end if;
  update public.businesses set owner_id = 'aaaaaaaa-0000-0000-0000-00000000000a', claim_status = 'claimed', workspace_kind = 'own' where id = c1;
  select count(*) into n from public.businesses where id = c1 and owner_id is null and claim_status = 'invite_pending' and workspace_kind = 'client';
  if n <> 1 then raise exception 'FAIL 12m: manager rewrote owner/claim/kind'; end if;
  ok := false;
  begin update public.members set role = 'owner' where business_id = c1 and user_id = 'aaaaaaaa-0000-0000-0000-00000000000a';
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12n: manager promoted self'; end if;
  perform set_config('role', 'none', true);
end $$;
reset role;

do $$
declare n int; ok boolean; j jsonb; c1 uuid; t1 uuid; t2 uuid; s1 uuid; enq uuid;
begin
  perform pg_temp.login('eeeeeeee-0000-0000-0000-00000000000e');
  ok := false;
  begin perform public.bootstrap_client_preview('a1a1a1a1-0000-0000-0000-000000000001', 'example:staff', 'Staff Co', null, '{}'::jsonb, '{}'::jsonb);
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12o: staff opened a client workspace'; end if;
  perform set_config('role', 'none', true);
  perform pg_temp.login('bbbbbbbb-0000-0000-0000-00000000000b');
  select count(*) into n from public.client_sites;
  if n <> 0 then raise exception 'FAIL 12p: B can read A client sites'; end if;
  select count(*) into n from public.site_proposals;
  if n <> 0 then raise exception 'FAIL 12q: B can read A proposals'; end if;
  select count(*) into n from public.client_enquiries;
  if n <> 0 then raise exception 'FAIL 12r: B can read A enquiries'; end if;
  ok := false;
  begin perform public.bootstrap_client_preview('a1a1a1a1-0000-0000-0000-000000000001', 'example:steal', 'Steal Co', null, '{}'::jsonb, '{}'::jsonb);
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12s: B opened a workspace on A account'; end if;
  update public.client_sites set about = 'hacked' where business_name = 'Preview Painting Co';
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 12t: B edited A site'; end if;
  perform set_config('role', 'none', true);
end $$;
reset role;

-- staff member of A, used above. Inserted here as superuser before the staff call... wait, the block above
-- already ran. Insert the staff user FIRST. This comment marks a reorder: the insert is below and the
-- staff call is repeated after the insert if the first one failed closed for "no such user".
insert into auth.users (id, email) values
  ('eeeeeeee-0000-0000-0000-00000000000e', 'iso-test-e@example.com'),
  ('dddddddd-0000-0000-0000-00000000000d', 'iso-test-d@example.com')
on conflict (id) do nothing;
insert into public.members (business_id, user_id, role)
values ('a1a1a1a1-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-00000000000e', 'staff');

do $$
declare n int; ok boolean; j jsonb; c1 uuid; c2 uuid; t1 uuid; t2 uuid; s1 uuid; enq uuid;
begin
  -- The earlier staff call may have failed because the user did not exist yet. Prove it again now.
  perform pg_temp.login('eeeeeeee-0000-0000-0000-00000000000e');
  ok := false;
  begin perform public.bootstrap_client_preview('a1a1a1a1-0000-0000-0000-000000000001', 'example:staff', 'Staff Co', null, '{}'::jsonb, '{}'::jsonb);
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12o: staff opened a client workspace'; end if;
  perform set_config('role', 'none', true);

  perform pg_temp.login('aaaaaaaa-0000-0000-0000-00000000000a');
  select id, public_token into s1, t1 from public.client_sites where business_name = 'Preview Painting Co';
  select public_token into t2 from public.client_sites where business_name = 'Second Client Co';
  select id into c1 from public.businesses where name = 'Preview Painting Co';
  select id into c2 from public.businesses where name = 'Second Client Co';
  update public.client_sites set approved_at = now() where id = s1;
  update public.client_sites set status = 'live' where id = s1;
  update public.client_sites set capture_enabled = true where id = s1;
  select count(*) into n from public.client_sites where id = s1 and status = 'live' and capture_enabled and approved_at is not null;
  if n <> 1 then raise exception 'FAIL 12u: explicit approval did not arm capture'; end if;
  perform set_config('role', 'none', true);

  perform pg_temp.as_anon();
  j := public.get_public_site(t1);
  if j->>'business_name' <> 'Preview Painting Co' then raise exception 'FAIL 12v: public site missing'; end if;
  if j ? 'business_id' or j ? 'lead_id' or j::text like '%SECRET-PROPOSAL-NOTE%' or j::text like '%a1a1a1a1%' then
    raise exception 'FAIL 12w: public site leaks private data';
  end if;
  if coalesce(j->>'collects','') <> 'true' then raise exception 'FAIL 12x: live site did not report capture'; end if;
  j := public.get_public_site(t2);
  if coalesce(j->>'collects','') = 'true' or j->>'status' = 'live' then raise exception 'FAIL 12y: second site is collecting'; end if;
  if public.get_public_site(gen_random_uuid()) is not null then raise exception 'FAIL 12z: random token returned data'; end if;
  ok := false;
  begin perform public.submit_site_enquiry(t2, 'Pat', '4045550100', '', '', 'Hi', false, 'Website form', now() - interval '1 minute', '', '');
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12aa: unofficial site accepted an enquiry'; end if;
  enq := public.submit_site_enquiry(t1, 'Pat Visitor', '4045550199', 'pat@example.com', 'Interior painting', 'Need a room painted', false, 'Website form', now() - interval '1 minute', '', '');
  if enq is null then raise exception 'FAIL 12ab: saved enquiry did not return an id'; end if;
  ok := false;
  begin perform public.submit_site_enquiry(t1, 'Bot', '4045550100', '', '', 'x', false, 'Website form', now() - interval '1 minute', 'http://spam', '');
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12ac: honeypot was stored'; end if;
  ok := false;
  begin perform public.submit_site_enquiry(t1, 'Fast', '4045550100', '', '', 'x', false, 'Website form', now(), '', '');
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12ad: too-fast submit stored'; end if;
  ok := false;
  begin insert into public.client_enquiries (business_id, client_site_id, name) values (c1, s1, 'injected');
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12ae: anon inserted an enquiry directly'; end if;
  ok := false;
  begin perform 1 from public.client_sites limit 1; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12af: anon can read sites'; end if;
  ok := false;
  begin perform 1 from public.client_enquiries limit 1; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12ag: anon can read enquiries'; end if;
  ok := false;
  begin perform 1 from public.site_proposals limit 1; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12ah: anon can read proposals'; end if;
  ok := false;
  begin perform 1 from public.client_accounts limit 1; exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12ai: anon can read workspace links'; end if;
  perform set_config('role', 'none', true);
end $$;
reset role;

do $$
declare n int; c1 uuid; c2 uuid;
begin
  select id into c1 from public.businesses where name = 'Preview Painting Co';
  select id into c2 from public.businesses where name = 'Second Client Co';
  select count(*) into n from public.client_enquiries where business_id = c1 and name = 'Pat Visitor' and source = 'Website form';
  if n <> 1 then raise exception 'FAIL 12aj: enquiry not stored on the client workspace'; end if;
  select count(*) into n from public.client_enquiries where business_id = 'a1a1a1a1-0000-0000-0000-000000000001' or business_id = c2 or name in ('Bot','Fast','injected');
  if n <> 0 then raise exception 'FAIL 12ak: enquiry landed in the wrong tenant or a rejected row was kept'; end if;
  select count(*) into n from public.leads where name = 'Pat Visitor';
  if n <> 0 then raise exception 'FAIL 12al: site enquiry became a sales lead'; end if;
  -- future client login
  insert into public.members (business_id, user_id, role) values (c1, 'dddddddd-0000-0000-0000-00000000000d', 'owner');
  perform pg_temp.login('dddddddd-0000-0000-0000-00000000000d');
  select count(*) into n from public.client_sites;
  if n <> 1 then raise exception 'FAIL 12am: client login should see only its site, saw %', n; end if;
  select count(*) into n from public.site_proposals;
  if n <> 0 then raise exception 'FAIL 12an: client login can read sales proposals'; end if;
  select count(*) into n from public.client_accounts;
  if n <> 0 then raise exception 'FAIL 12ao: client login can read sales links'; end if;
  select count(*) into n from public.leads;
  if n <> 0 then raise exception 'FAIL 12ap: client login can read sales leads'; end if;
  select count(*) into n from public.client_enquiries where name = 'Pat Visitor';
  if n <> 1 then raise exception 'FAIL 12aq: client login cannot see its enquiry'; end if;
  select count(*) into n from public.businesses where id = c2;
  if n <> 0 then raise exception 'FAIL 12ar: client login can see the other client'; end if;
  update public.client_sites set about = 'hacked' where business_id = c2;
  get diagnostics n = row_count; if n <> 0 then raise exception 'FAIL 12as: client edited the other site'; end if;
  perform set_config('role', 'none', true);
end $$;
reset role;

do $$
declare n int; i int; t1 uuid; ok boolean;
begin
  select public_token into t1 from public.client_sites where business_name = 'Preview Painting Co';
  perform pg_temp.as_anon();
  for i in 1..9 loop
    perform public.submit_site_enquiry(t1, 'More '||i, '4045550100', '', '', 'x', false, 'Not a real channel!!!', now() - interval '1 minute', '', '');
  end loop;
  ok := false;
  begin perform public.submit_site_enquiry(t1, 'Overflow', '4045550100', '', '', 'x', false, 'Website form', now() - interval '1 minute', '', '');
  exception when others then ok := true; end;
  if not ok then raise exception 'FAIL 12at: rate limit did not stop the 11th enquiry'; end if;
  perform set_config('role', 'none', true);
  select count(*) into n from public.client_enquiries where name like 'More %' or name = 'Pat Visitor';
  if n <> 10 then raise exception 'FAIL 12au: expected 10 saved enquiries, saw %', n; end if;
  select count(*) into n from public.client_enquiries where source = 'Website form' and name like 'More %';
  if n <> 9 then raise exception 'FAIL 12av: bad source was stored instead of Website form'; end if;
end $$;

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
