import type { SupabaseClient } from "@supabase/supabase-js";

import { AUTH_STORAGE_KEY, OAUTH_STORAGE_KEY, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

/**
 * The Supabase library is only loaded when someone has an account or opens the
 * sign-in form. Until then the studio makes no network request at all.
 */
let client: Promise<SupabaseClient> | null = null;

export function getClient(): Promise<SupabaseClient> {
  client ??= import("@supabase/supabase-js").then(({ createClient }) =>
    createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        storageKey: AUTH_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: true,
        // The website's account page turns this on for its own client.
        detectSessionInUrl: false
      }
    })
  );
  return client;
}

/**
 * Only for signing in with Discord. That needs the safer "PKCE" way of coming
 * back, while the email links (confirm, reset) must keep working when opened in
 * a different browser, which PKCE can't do. So Discord gets a client of its
 * own, and the finished session is handed to the main client (see auth.ts).
 */
let oauthClient: Promise<SupabaseClient> | null = null;

export function getOAuthClient(): Promise<SupabaseClient> {
  oauthClient ??= import("@supabase/supabase-js").then(({ createClient }) =>
    createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        flowType: "pkce",
        storageKey: OAUTH_STORAGE_KEY,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false
      }
    })
  );
  return oauthClient;
}
