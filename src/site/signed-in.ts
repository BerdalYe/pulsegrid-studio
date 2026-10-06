/**
 * Where Discord sign-in sends the Windows app's users first. The page hands the
 * result to the app through its pulsegrid://auth link, then tells the person
 * they can close the tab: without it, the browser is left on Discord's spinner.
 */

const title = document.querySelector<HTMLElement>("#signed-title");
const lead = document.querySelector<HTMLElement>("#signed-lead");
const open = document.querySelector<HTMLElement>("#signed-open");
const link = document.querySelector<HTMLAnchorElement>("#signed-open-link");

const returned = window.location.search.length > 1 || window.location.hash.length > 1;
const appLink = `pulsegrid://auth${window.location.search}${window.location.hash}`;

if (!returned) {
  if (title) title.textContent = "Nothing to do here";
  if (lead) lead.textContent = "Open PulseGrid Studio and choose “Continue with Discord” to sign in.";
} else {
  // Keep the one-time code out of the address bar and history.
  history.replaceState(null, "", window.location.pathname);
  if (link) link.href = appLink;

  window.location.href = appLink;

  window.setTimeout(() => {
    if (title) title.textContent = "You can close this tab";
    if (lead) {
      lead.textContent =
        "Go back to PulseGrid Studio: you should be signed in. If nothing happened, press the button to open it.";
    }
    if (open) open.hidden = false;
  }, 1200);
}

export {};
