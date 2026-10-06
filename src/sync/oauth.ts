/**
 * Reading the address Discord's sign-in sends a person back to. Kept apart from
 * the sign-in itself so it can be tested without a browser.
 */

export type OAuthReturn =
  | { kind: "code"; code: string }
  | { kind: "error"; message: string }
  | { kind: "none" };

/** Words a person can act on, in place of the provider's. */
export function friendlyOAuthError(reason: string, description: string): string {
  const text = `${reason} ${description}`;
  if (/access_denied|cancel/i.test(text) && !/email/i.test(description)) {
    return "Discord sign-in was cancelled.";
  }
  if (/email/i.test(text)) {
    return "Your Discord account has no verified email address. Verify it in Discord, then try again.";
  }
  if (/signups? (are )?(not allowed|disabled)|signup_disabled/i.test(text)) {
    return "New accounts aren't being accepted right now.";
  }
  return "Discord sign-in didn't work. Try again.";
}

/** The code (or the problem) in a return address, from its query or its #fragment. */
export function readOAuthReturn(address: string): OAuthReturn {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return { kind: "none" };
  }

  const params = new URLSearchParams(url.search);
  if (url.hash.length > 1) {
    for (const [key, value] of new URLSearchParams(url.hash.slice(1))) {
      if (!params.has(key)) params.set(key, value);
    }
  }

  const reason = params.get("error") ?? params.get("error_code");
  if (reason) {
    return { kind: "error", message: friendlyOAuthError(reason, params.get("error_description") ?? "") };
  }

  const code = params.get("code");
  return code ? { kind: "code", code } : { kind: "none" };
}

/** The same address without the code or error, for the browser's address bar. */
export function withoutOAuthParams(address: string): string {
  try {
    const url = new URL(address);
    for (const key of ["code", "error", "error_code", "error_description"]) url.searchParams.delete(key);
    url.hash = "";
    return url.toString();
  } catch {
    return address;
  }
}
