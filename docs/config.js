// Fill these in from Supabase → Project Settings → Data API / API Keys (see SETUP.md step 2).
//   SUPABASE_URL      = your Project URL, e.g. https://abcdefghijklmnop.supabase.co
//   SUPABASE_ANON_KEY = your publishable key, starts with sb_publishable_  (or the older "anon" key)
// NEVER put a key starting with sb_secret_ (or the "service_role" key) here — this file is public.
// The anon/publishable key is safe to put here — security is enforced by
// the database rules in 01_schema.sql.
export const CONFIG = {
  SUPABASE_URL: "https://kleyukqaacslivfqozbs.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_ewAfFiDg0mcnyfDf13cw2Q_7WnS8Flo",
  COMPANY_DOMAIN: "1915south.com",
  // The web-address name of the Employees function in Supabase (Edge Functions → its URL ends in /functions/v1/<this>)
  ADMIN_FUNCTION: "super-function",
};
