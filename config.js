/* Trade CRM settings for THIS client install.
 * Leave SUPABASE_URL and SUPABASE_ANON_KEY empty = Demo mode (data stays in this browser only).
 * Fill them in (Supabase > Project Settings > API) = login + cloud sync.
 *
 * ONLY the public "anon" / "publishable" key goes here. It is safe in a browser because the
 * database rules (supabase/schema.sql, Row Level Security) decide what it can do.
 * NEVER paste the "service_role" or "secret" key here or anywhere in this folder; the app refuses it.
 */
window.CRM_CONFIG = {
  SUPABASE_URL: 'https://bamwzxbowijasxggyjca.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhbXd6eGJvd2lqYXN4Z2d5amNhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTMxODM4OTAsImV4cCI6MjEwODc1OTg5MH0.U7HRg7HYnC6MyoroGa6wi6irMmS8ZwsBQ9WENVNIz9g',   // public anon key (safe in the browser; RLS protects data)
  SUPPORT_EMAIL: '',       // where the in-app "Contact support" link goes, e.g. 'support@youragency.com'
  SUPPORT_NAME: 'Support'  // shown next to the link
};
