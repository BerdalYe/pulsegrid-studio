/**
 * The user agreement shown before the studio can be used, in Norwegian (the
 * original) and English.
 *
 * Bump AGREEMENT_VERSION whenever the wording changes: everyone who accepted
 * an older version is asked again.
 */
export const AGREEMENT_VERSION = 2;

export type AgreementLanguage = "en" | "no";

export interface AgreementSection {
  heading: string;
  text: string;
}

export interface AgreementCopy {
  /** Name of the language, in that language, for the switcher. */
  languageName: string;
  title: string;
  /** Who the agreement is between, under the title. */
  parties: string;
  intro: string;
  sections: AgreementSection[];
  version: (version: number) => string;
  checkbox: string;
  accept: string;
  close: string;
  acceptedOn: (date: string) => string;
}

export const agreementCopy: Record<AgreementLanguage, AgreementCopy> = {
  no: {
    languageName: "Norsk",
    title: "Brukeravtale",
    parties: "PulseGrid Studio",
    intro: "PulseGrid Studio er gratis å bruke. Disse korte vilkårene forklarer hva det betyr. Les dem før du begynner.",
    sections: [
      {
        heading: "Gratis å bruke",
        text: "PulseGrid Studio er gratis. Du kan bruke det til private og kommersielle prosjekter, uten konto, abonnement eller betaling."
      },
      {
        heading: "Musikken din er din",
        text: "Du eier alt du lager med PulseGrid Studio: låter, beats, opptak og eksporterte filer. PulseGrid gjør ikke krav på noen rettigheter til musikken din, og du trenger verken å kreditere PulseGrid eller sende den noe sted."
      },
      {
        heading: "Innebygde lyder",
        text: "De innebygde instrumentene, trommelydene og samplene er laget av PulseGrid Studio selv og kan brukes fritt i musikken din, også kommersielt. Samples du importerer selv, følger sine egne lisenser."
      },
      {
        heading: "Selve programmet",
        text: "PulseGrid Studio tilhører skaperen sin. Del gjerne lenken til den offisielle nedlastingen, men ikke selg programmet eller del endrede kopier av det."
      },
      {
        heading: "Ingen garanti",
        text: "PulseGrid Studio leveres som det er, uten garantier. Ta sikkerhetskopi av arbeid som er viktig for deg. Så langt loven tillater det, er PulseGrid ikke ansvarlig for tapt arbeid eller andre skader."
      }
    ],
    version: (version) => `Versjon ${version}`,
    checkbox: "Jeg har lest og godtar vilkårene i denne avtalen",
    accept: "Godta",
    close: "Lukk",
    acceptedOn: (date) => `Godtatt ${date}`
  },
  en: {
    languageName: "English",
    title: "User Agreement",
    parties: "PulseGrid Studio",
    intro: "PulseGrid Studio is free to use. These short terms explain what that means. Please read them before you start.",
    sections: [
      {
        heading: "Free to use",
        text: "PulseGrid Studio is free. You can use it for personal and commercial projects, with no account, subscription or payment."
      },
      {
        heading: "Your music is yours",
        text: "You own everything you make with PulseGrid Studio: songs, beats, recordings and exported files. PulseGrid claims no rights to your music, and you don't have to credit PulseGrid or send your music anywhere."
      },
      {
        heading: "Built-in sounds",
        text: "The built-in instruments, drum sounds and samples are made by PulseGrid Studio itself and are free to use in your music, commercially too. Samples you import yourself stay under their own licences."
      },
      {
        heading: "The app itself",
        text: "PulseGrid Studio belongs to its creator. You're welcome to share the link to the official download, but please don't sell the app or share modified copies of it."
      },
      {
        heading: "No warranty",
        text: "PulseGrid Studio is provided as is, without warranty of any kind. Keep backups of work that matters to you. As far as the law allows, PulseGrid isn't liable for lost work or other damage."
      }
    ],
    version: (version) => `Version ${version}`,
    checkbox: "I have read and accept the terms of this agreement",
    accept: "Accept",
    close: "Close",
    acceptedOn: (date) => `Accepted on ${date}`
  }
};

/**
 * The browser's own preference order decides: Norwegian (Bokmål or Nynorsk)
 * if it comes before English, English otherwise.
 */
export function defaultAgreementLanguage(languages: readonly string[] = []): AgreementLanguage {
  for (const tag of languages) {
    if (/^(nb|nn|no)\b/i.test(tag)) return "no";
    if (/^en\b/i.test(tag)) return "en";
  }
  return "en";
}

export interface AgreementAcceptance {
  version: number;
  /** Epoch milliseconds. */
  acceptedAt: number;
  language: AgreementLanguage;
}

const STORAGE_KEY = "pulsegrid:agreement";

type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Storage can throw outright when the browser blocks site data.
    return null;
  }
}

/** The stored acceptance, if it is for the current wording. */
export function readAcceptance(
  storage: KeyValueStore | null = browserStorage()
): AgreementAcceptance | null {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as Partial<AgreementAcceptance>;
    if (parsed.version !== AGREEMENT_VERSION) return null;
    if (typeof parsed.acceptedAt !== "number" || !Number.isFinite(parsed.acceptedAt)) return null;

    return {
      version: parsed.version,
      acceptedAt: parsed.acceptedAt,
      language: parsed.language === "no" ? "no" : "en"
    };
  } catch {
    return null;
  }
}

/**
 * Record an acceptance. Returns it even when it could not be stored — the
 * user has still accepted for this session; they'll just be asked again next
 * time.
 */
export function saveAcceptance(
  language: AgreementLanguage,
  storage: KeyValueStore | null = browserStorage(),
  now = Date.now()
): AgreementAcceptance {
  const acceptance: AgreementAcceptance = { version: AGREEMENT_VERSION, acceptedAt: now, language };

  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(acceptance));
  } catch {
    /* quota or blocked storage — acceptance still holds for this session */
  }

  return acceptance;
}
