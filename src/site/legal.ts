/**
 * Renders the user agreement on the legal page from the same source the
 * studio uses, so the website can never show different terms from the app.
 */
import {
  AGREEMENT_VERSION,
  agreementCopy,
  defaultAgreementLanguage,
  type AgreementLanguage
} from "../agreement";

const container = document.querySelector<HTMLElement>("[data-agreement]");
const buttons = [...document.querySelectorAll<HTMLButtonElement>("[data-lang]")];

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function render(language: AgreementLanguage): void {
  if (!container) return;
  const copy = agreementCopy[language];

  container.replaceChildren();
  container.lang = language === "no" ? "nb" : "en";

  container.append(
    element("p", `${copy.title} · ${copy.parties} · ${copy.version(AGREEMENT_VERSION)}`, "legal-meta"),
    element("p", copy.intro, "legal-intro")
  );

  const list = element("ol", undefined, "agreement-clauses");
  for (const section of copy.sections) {
    const item = element("li");
    item.append(element("h3", section.heading), element("p", section.text));
    list.append(item);
  }
  container.append(list);

  for (const button of buttons) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === language));
  }
}

for (const button of buttons) {
  button.addEventListener("click", () => render(button.dataset.lang === "no" ? "no" : "en"));
}

render(defaultAgreementLanguage(navigator.languages ?? [navigator.language]));
