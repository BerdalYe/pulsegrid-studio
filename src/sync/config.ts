/** Set at build time from package.json → pulsegrid.supabase (see vite.config.ts). */
export const SUPABASE_URL: string = __SUPABASE_URL__;
export const SUPABASE_ANON_KEY: string = __SUPABASE_ANON_KEY__;
export const SITE_URL: string = __SITE_URL__;

/** Without an address and key the studio simply has no account feature. */
export const syncConfigured = /^https?:\/\//i.test(SUPABASE_URL) && SUPABASE_ANON_KEY.length > 20;

/** Where the sign-in session is kept, in this browser's own storage. */
export const AUTH_STORAGE_KEY = "pulsegrid:auth";

/**
 * The Discord sign-in uses its own small client (see client.ts). It keeps a
 * one-time proof here while the person is away at Discord, and the library
 * stores that proof under this name plus "-code-verifier".
 */
export const OAUTH_STORAGE_KEY = "pulsegrid:auth-discord";
