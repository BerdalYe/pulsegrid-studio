import { describe, expect, it } from "vitest";

import {
  AGREEMENT_VERSION,
  agreementCopy,
  defaultAgreementLanguage,
  readAcceptance,
  saveAcceptance
} from "./agreement";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    }
  };
}

describe("user agreement", () => {
  it("asks again until it has been accepted", () => {
    expect(readAcceptance(memoryStorage())).toBeNull();
    expect(readAcceptance(null)).toBeNull();
  });

  it("remembers an acceptance, and the language it was read in", () => {
    const storage = memoryStorage();
    saveAcceptance("no", storage, 1_700_000_000_000);

    expect(readAcceptance(storage)).toEqual({
      version: AGREEMENT_VERSION,
      acceptedAt: 1_700_000_000_000,
      language: "no"
    });
  });

  it("asks again once the wording has changed", () => {
    const storage = memoryStorage({
      "pulsegrid:agreement": JSON.stringify({
        version: AGREEMENT_VERSION - 1,
        acceptedAt: 1,
        language: "en"
      })
    });

    expect(readAcceptance(storage)).toBeNull();
  });

  it("treats a damaged record as not accepted", () => {
    for (const raw of ["{", "null", '{"version":1}', '{"version":1,"acceptedAt":"yesterday"}']) {
      expect(readAcceptance(memoryStorage({ "pulsegrid:agreement": raw }))).toBeNull();
    }
  });

  it("still accepts for the session when storage is blocked", () => {
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      }
    };

    expect(saveAcceptance("en", blocked).version).toBe(AGREEMENT_VERSION);
    expect(readAcceptance(blocked)).toBeNull();
  });

  it("opens in whichever of Norwegian or English the browser prefers", () => {
    expect(defaultAgreementLanguage(["nb-NO", "en"])).toBe("no");
    expect(defaultAgreementLanguage(["nn"])).toBe("no");
    expect(defaultAgreementLanguage(["no"])).toBe("no");
    // The browser's preference order wins.
    expect(defaultAgreementLanguage(["en-GB", "nb"])).toBe("en");
    expect(defaultAgreementLanguage(["de", "nb", "en"])).toBe("no");
    expect(defaultAgreementLanguage(["en-US"])).toBe("en");
    expect(defaultAgreementLanguage([])).toBe("en");
  });

  it("leaves the music with the people who make it", () => {
    // Free to use, owned by the user: no company or third party in the terms.
    for (const copy of Object.values(agreementCopy)) {
      const text = JSON.stringify(copy);
      expect(text).not.toMatch(/TCG|YFF|Discord/);
    }
    expect(agreementCopy.en.sections.map((section) => section.heading)).toContain("Your music is yours");
  });

  it("says the same thing in both languages", () => {
    // Same clauses in both — a translation that drops a clause would be a
    // different agreement.
    expect(agreementCopy.en.sections).toHaveLength(agreementCopy.no.sections.length);
    expect(agreementCopy.en.parties).toBe(agreementCopy.no.parties);
    for (const copy of Object.values(agreementCopy)) {
      for (const section of copy.sections) {
        expect(section.heading.trim()).not.toBe("");
        expect(section.text.trim()).not.toBe("");
      }
    }
  });
});
