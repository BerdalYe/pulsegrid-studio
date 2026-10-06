/**
 * The website's behaviour: the mobile menu, the header on scroll, fade-in on
 * scroll, copying the installer checksum, and the footer year.
 */

for (const element of document.querySelectorAll<HTMLElement>("[data-year]")) {
  element.textContent = String(new Date().getFullYear());
}

/* ── the 1.0 announcement ── */

const announce = document.querySelector<HTMLElement>("#announce");
const ANNOUNCE_KEY = "pulsegrid:announce-1.0";

function announcementDismissed(): boolean {
  try {
    return localStorage.getItem(ANNOUNCE_KEY) === "dismissed";
  } catch {
    return false;
  }
}

if (announce && announcementDismissed()) announce.hidden = true;

document.querySelector("#announce-close")?.addEventListener("click", () => {
  if (announce) announce.hidden = true;
  try {
    localStorage.setItem(ANNOUNCE_KEY, "dismissed");
  } catch {
    /* it just comes back next visit */
  }
});

/* ── header ── */

const header = document.querySelector<HTMLElement>(".site-header");
const onScroll = () => header?.classList.toggle("scrolled", window.scrollY > 12);
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

const toggle = document.querySelector<HTMLButtonElement>(".menu-toggle");

function setMenu(open: boolean): void {
  header?.classList.toggle("menu-open", open);
  toggle?.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("no-scroll", open);
}

toggle?.addEventListener("click", () => setMenu(!header?.classList.contains("menu-open")));

// Following a link, pressing Escape or widening the window closes the menu.
for (const link of document.querySelectorAll<HTMLAnchorElement>("#site-nav a")) {
  link.addEventListener("click", () => setMenu(false));
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") setMenu(false);
});
window.matchMedia("(min-width: 901px)").addEventListener("change", (query) => {
  if (query.matches) setMenu(false);
});

/* ── fade-in ── */

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const revealed = document.querySelectorAll<HTMLElement>(".reveal");

if (reduceMotion || !("IntersectionObserver" in window)) {
  for (const element of revealed) element.classList.add("visible");
} else {
  document.documentElement.classList.add("js-reveal");
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -6% 0px" }
  );

  for (const element of revealed) observer.observe(element);
}

/* ── download details ── */

// A build made before the installer exists has no date or checksum; leave
// those out rather than showing empty labels.
for (const time of document.querySelectorAll<HTMLTimeElement>(".release time")) {
  if (!time.textContent?.trim()) time.remove();
}

const checksum = document.querySelector<HTMLElement>(".checksum");
if (checksum && !checksum.dataset.sha?.trim()) checksum.remove();

const copyButton = document.querySelector<HTMLButtonElement>(".copy-button");
copyButton?.addEventListener("click", async () => {
  const value = checksum?.dataset.sha ?? "";
  try {
    await navigator.clipboard.writeText(value);
    copyButton.textContent = "Copied";
  } catch {
    // No clipboard access: select the text so it can be copied by hand.
    const code = checksum?.querySelector("code");
    if (code) window.getSelection()?.selectAllChildren(code);
    copyButton.textContent = "Selected";
  }
  window.setTimeout(() => (copyButton.textContent = "Copy"), 1800);
});
