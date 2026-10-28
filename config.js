/* Trade CRM settings for THIS client install.
 * Leave SUPABASE_URL and SUPABASE_ANON_KEY empty = Demo mode (data stays in this browser only).
 * Fill them in (Supabase > Project Settings > API) = login + cloud sync.
 *
 * ONLY the public "anon" / "publishable" key goes here. It is safe in a browser because the
 * database rules (supabase/schema.sql, Row Level Security) decide what it can do.
 * NEVER paste the "service_role" or "secret" key here or anywhere in this folder; the app refuses it.
 */
window.CRM_CONFIG = {
  SUPABASE_URL: '',        // e.g. 'https://abcdxyz.supabase.co'
  SUPABASE_ANON_KEY: '',   // starts with 'eyJ' (anon) or 'sb_publishable_'
  SUPPORT_EMAIL: '',       // where the in-app "Contact support" link goes, e.g. 'support@youragency.com'
  SUPPORT_NAME: 'Support'  // shown next to the link
};
