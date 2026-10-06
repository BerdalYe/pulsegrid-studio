/**
 * The page the emails link to: it confirms a new account, or lets someone who
 * followed a "forgot password" link choose a new one. Nothing here signs the
 * visitor in; the session is only used to change the password, then dropped.
 */

const title = document.querySelector<HTMLElement>("#account-title");
const lead = document.querySelector<HTMLElement>("#account-lead");
const form = document.querySelector<HTMLFormElement>("#reset-form");
const next = document.querySelector<HTMLElement>("#account-next");
const errorBox = document.querySelector<HTMLElement>("#reset-error");
const submit = document.querySelector<HTMLButtonElement>("#reset-submit");
const first = document.querySelector<HTMLInputElement>("#new-password");
const second = document.querySelector<HTMLInputElement>("#repeat-password");

function show(heading: string, text: string, options: { form?: boolean; next?: boolean } = {}): void {
  if (title) title.textContent = heading;
  if (lead) lead.textContent = text;
  if (form) form.hidden = !options.form;
  if (next) next.hidden = !options.next;
}

function fail(message: string): void {
  if (!errorBox) return;
  errorBox.textContent = message;
  errorBox.hidden = false;
}

const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
const query = new URLSearchParams(window.location.search);
const problem = hash.get("error_code") ?? hash.get("error") ?? query.get("error_code") ?? query.get("error");
const kind = hash.get("type");

// Don't leave the one-time tokens sitting in the address bar and history.
const hadTokens = window.location.hash.length > 1;

if (problem) {
  history.replaceState(null, "", window.location.pathname);
  show(
    "That link didn't work",
    "It may have expired or already been used. Open PulseGrid Studio and ask for a new one: “Forgot password?” for a reset, or create the account again for a new confirmation email.",
    { next: true }
  );
} else if (kind === "recovery") {
  void startReset();
} else if (hadTokens && hash.get("access_token")) {
  history.replaceState(null, "", window.location.pathname);
  show("Email confirmed", "Your PulseGrid account is ready.", { next: true });
} else {
  show("Your account", "Create an account or sign in from inside PulseGrid Studio, under Cloud in the left panel.", {
    next: true
  });
}

async function startReset(): Promise<void> {
  show("Choose a new password", "Pick something you haven't used for PulseGrid before.", { form: true });

  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(__SUPABASE_URL__, __SUPABASE_ANON_KEY__, {
    // Its own storage slot, so this page can never sign the web studio in or out.
    auth: { storageKey: "pulsegrid:account-page", persistSession: true, detectSessionInUrl: true }
  });

  // The library reads the tokens from the address bar on start-up.
  const { data } = await client.auth.getSession();
  history.replaceState(null, "", window.location.pathname);

  if (!data.session) {
    window.location.hash = "";
    show(
      "That link didn't work",
      "It may have expired or already been used. Open PulseGrid Studio and choose “Forgot password?” for a new one.",
      { next: true }
    );
    return;
  }

  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (errorBox) errorBox.hidden = true;

    const password = first?.value ?? "";
    if (password.length < 8) return fail("Use at least 8 characters.");
    if (password !== (second?.value ?? "")) return fail("The two passwords don't match.");

    if (submit) submit.disabled = true;
    void client.auth
      .updateUser({ password })
      .then(async ({ error }) => {
        if (error) {
          fail(
            /same|different/i.test(error.message)
              ? "Choose a password different from your old one."
              : error.message || "That didn't work. Try again."
          );
          if (submit) submit.disabled = false;
          return;
        }

        await client.auth.signOut({ scope: "local" });
        show("Password changed", "You can now sign in with your new password.", { next: true });
      })
      .catch(() => {
        fail("Couldn't reach the server. Check your connection and try again.");
        if (submit) submit.disabled = false;
      });
  });
}
