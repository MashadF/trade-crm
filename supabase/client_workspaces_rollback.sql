-- Trade CRM v2.9 rollback-to-disable for client workspaces.
-- Run this in the Supabase SQL editor AFTER a backup if public site capture or
-- workspace creation must be turned off. It does not remove rows and it does not
-- change customers, leads, jobs, quotes, invoices, tasks, emails, or members of
-- accounts that already existed before v2.9.
--
-- What this does:
--   1. Turns enquiry capture off on every client site.
--   2. Revokes the browser roles from the new functions so previews, enquiry
--      posts, and new workspace creation stop working through the Data API.
-- Existing saved rows stay in place. To turn the feature back on, re-run the
-- v2.9 section of schema.sql (it is written so it can be run again).

update public.client_sites set capture_enabled = false, updated_at = now()
 where capture_enabled;

revoke all on function public.bootstrap_client_preview(uuid, text, text, uuid, jsonb, jsonb) from anon, authenticated, public;
revoke all on function public.get_public_site(uuid) from anon, authenticated, public;
revoke all on function public.submit_site_enquiry(uuid, text, text, text, text, text, boolean, text, timestamptz, text, text) from anon, authenticated, public;
revoke all on function crm_private.bootstrap_client_preview(uuid, text, text, uuid, jsonb, jsonb) from anon, authenticated, public;
revoke all on function crm_private.get_public_site(uuid) from anon, authenticated, public;
revoke all on function crm_private.submit_site_enquiry(uuid, text, text, text, text, text, boolean, text, timestamptz, text, text) from anon, authenticated, public;

-- Check: both of these should return 0.
-- select count(*) from public.client_sites where capture_enabled;
-- select has_function_privilege('anon', 'public.submit_site_enquiry(uuid, text, text, text, text, text, boolean, text, timestamptz, text, text)', 'execute');
