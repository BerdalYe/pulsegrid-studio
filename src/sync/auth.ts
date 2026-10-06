import { create } from "zustand";

import { getDesktop } from "../files/desktop";
import { getClient, getOAuthClient } from "./client";
import { AUTH_STORAGE_KEY, OAUTH_STORAGE_KEY, SITE_URL, syncConfigured } from "./config";
import { readOAuthReturn, withoutOAuthParams } from "./oauth";

export type AuthStatus = "unknown" | "signedOut" | "signedIn";

interface AuthState {
  status: AuthStatus;
  userId: string | null;
  email: string | null;
  /** Something that went wrong while coming back from Discord, to show in the panel. */
  notice: string | null;
}

export const useAuthStore = create<AuthState>()(() => ({
  status: "unknown",
  userId: null,
  email: null,
  notice: null
}));

export function clearAuthNotice(): void {
  if (useAuthStore.getState().notice !== null) useAuthStore.setState({ notice: null });
}

/** Words a person can act on, in place of the library's. */
export function friendlyAuthError(error: unknown): string {
  const failure = (error ?? {}) as { message?: string; status?: number; code?: string; name?: string };
  const message = failure.message ?? "";
  const code = failure.code ?? "";

  if (/invalid login credentials/i.test(message) || code === "invalid_credentials") {
    return "Wrong email or password.";
  }
  if (/email not confirmed/i.test(message) || code === "email_not_confirmed") {
    return "Confirm your email first: open the link we sent you, then sign in.";
  }
  if (/already registered|already been registered/i.test(message) || code === "user_already_exists") {
    return "There's already an account with that email. Sign in instead, or use “Forgot password?”.";
  }
  if (/rate limit|too many|over_email_send_rate_limit|over_request_rate_limit/i.test(`${message} ${code}`)) {
    return "Too many attempts. Wait a few minutes and try again.";
  }
  if (/password/i.test(message) && /(least|short|weak|characters)/i.test(message)) {
    return "Choose a longer password: at least 8 characters.";
  }
  if (/valid email|invalid email|email address.*invalid/i.test(message) || code === "email_address_invalid") {
    return "That doesn't look like a valid email address.";
  }
  if (/signups? (are )?(not allowed|disabled)/i.test(message) || code === "signup_disabled") {
    return "New accounts aren't being accepted right now.";
  }
  if (
    failure.status === 0 ||
    /fetch|network|failed to|timeout|retryable/i.test(`${failure.name ?? ""} ${message}`) ||
    (typeof navigator !== "undefined" && navigator.onLine === false)
  ) {
    return "Can't reach the cloud. Check your internet connection.";
  }
  return message || "Something went wrong. Try again.";
}

let listening = false;

/**
 * Start mirroring the sign-in state. Does nothing at all, not even loading the
 * library, unless this browser already holds a session.
 */
export async function initAuth(): Promise<void> {
  if (!syncConfigured) {
    useAuthStore.setState({ status: "signedOut", userId: null, email: null });
    return;
  }

  await watchForDiscordReturn();

  let hasSession = false;
  try {
    hasSession = localStorage.getItem(AUTH_STORAGE_KEY) !== null;
  } catch {
    /* blocked storage: there can be no session */
  }

  if (!hasSession) {
    useAuthStore.setState({ status: "signedOut", userId: null, email: null });
    return;
  }

  await attach();
}

/** Load the library and follow the session, once. */
async function attach(): Promise<void> {
  const client = await getClient();

  if (!listening) {
    listening = true;
    // Only record the state here: calling the library from inside this callback can deadlock it.
    client.auth.onAuthStateChange((_event, session) => {
      useAuthStore.setState(
        session
          ? { status: "signedIn", userId: session.user.id, email: session.user.email ?? null }
          : { status: "signedOut", userId: null, email: null }
      );
    });
  }

  const { data } = await client.auth.getSession();
  useAuthStore.setState(
    data.session
      ? { status: "signedIn", userId: data.session.user.id, email: data.session.user.email ?? null }
      : { status: "signedOut", userId: null, email: null }
  );
}

export async function signIn(email: string, password: string): Promise<void> {
  await attach();
  const client = await getClient();
  const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
  if (error) throw new Error(friendlyAuthError(error));
}

/** Resolves "signedIn" if the account works straight away, "confirm" if an email has to be confirmed first. */
export async function signUp(email: string, password: string): Promise<"signedIn" | "confirm"> {
  await attach();
  const client = await getClient();
  const { data, error } = await client.auth.signUp({
    email: email.trim(),
    password,
    options: { emailRedirectTo: `${SITE_URL}/account.html` }
  });
  if (error) throw new Error(friendlyAuthError(error));

  // With confirmation on, an address that already has an account gets an
  // obfuscated response (no identities) instead of an error.
  if (data.user && data.user.identities?.length === 0) {
    throw new Error(friendlyAuthError({ code: "user_already_exists" }));
  }
  return data.session ? "signedIn" : "confirm";
}

export async function signOut(): Promise<void> {
  const client = await getClient();
  await client.auth.signOut();
  useAuthStore.setState({ status: "signedOut", userId: null, email: null });
}

export async function sendPasswordReset(email: string): Promise<void> {
  await attach();
  const client = await getClient();
  const { error } = await client.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${SITE_URL}/account.html`
  });
  if (error) throw new Error(friendlyAuthError(error));
}

/* ─────────────────────────────── Discord ─────────────────────────────── */

function hasPendingDiscordSignIn(): boolean {
  try {
    return localStorage.getItem(`${OAUTH_STORAGE_KEY}-code-verifier`) !== null;
  } catch {
    return false;
  }
}

/** Send the person to Discord. In the Windows app that opens their own browser. */
export async function signInWithDiscord(): Promise<void> {
  clearAuthNotice();
  const desktop = getDesktop();
  const oauth = await getOAuthClient();
  const { data, error } = await oauth.auth.signInWithOAuth({
    provider: "discord",
    options: {
      // The Windows app is reached through a small website page, so the browser isn't left on Discord's spinner.
      redirectTo: desktop ? `${SITE_URL}/signed-in.html` : `${location.origin}${location.pathname}`,
      skipBrowserRedirect: true
    }
  });
  if (error || !data.url) throw new Error(friendlyAuthError(error ?? { message: "No sign-in address." }));

  if (desktop) await desktop.openExternal(data.url);
  else location.assign(data.url);
}

/** Finish a Discord sign-in from the address the person came back to. */
async function finishDiscordSignIn(address: string): Promise<void> {
  const result = readOAuthReturn(address);
  if (result.kind === "none") return;

  if (result.kind === "error") {
    try {
      localStorage.removeItem(`${OAUTH_STORAGE_KEY}-code-verifier`);
    } catch {
      /* nothing to clean up */
    }
    useAuthStore.setState({ notice: result.message });
    return;
  }

  try {
    const oauth = await getOAuthClient();
    const { data, error } = await oauth.auth.exchangeCodeForSession(result.code);
    if (error || !data.session) throw error ?? new Error("No session.");

    // Hand the session to the main client, then forget the Discord client's copy.
    await attach();
    const client = await getClient();
    const { error: handOver } = await client.auth.setSession({
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token
    });
    await oauth.auth.signOut({ scope: "local" });
    if (handOver) throw handOver;
  } catch (failure) {
    useAuthStore.setState({ notice: friendlyAuthError(failure) });
  }
}

let watching = false;

/**
 * Notice a person coming back from Discord: through the address in the web
 * studio, or through the pulsegrid://auth link in the Windows app.
 */
async function watchForDiscordReturn(): Promise<void> {
  if (watching) return;
  watching = true;

  const desktop = getDesktop();
  if (desktop) {
    desktop.onAuthCallback((address) => void finishDiscordSignIn(address));
    const waiting = await desktop.takeAuthUrl();
    if (waiting) await finishDiscordSignIn(waiting);
    return;
  }

  // Only act on an address we sent the person away with; a stray ?code= is none of our business.
  if (!hasPendingDiscordSignIn()) return;
  const address = location.href;
  if (readOAuthReturn(address).kind === "none") return;
  try {
    history.replaceState(null, "", withoutOAuthParams(address));
  } catch {
    /* the address bar keeps the code, which is harmless */
  }
  await finishDiscordSignIn(address);
}
