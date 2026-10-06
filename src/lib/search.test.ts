import { describe, expect, it } from "vitest";

import { filterByName, matchesQuery } from "./search";

describe("matchesQuery", () => {
  it("matches everything for an empty search", () => {
    expect(matchesQuery("Neon Drive", "")).toBe(true);
    expect(matchesQuery("Neon Drive", "   ")).toBe(true);
  });

  it("ignores capitals", () => {
    expect(matchesQuery("Neon Drive", "neon")).toBe(true);
    expect(matchesQuery("neon drive", "DRIVE")).toBe(true);
  });

  it("finds part of a word", () => {
    expect(matchesQuery("Midnight Lo-Fi", "midn")).toBe(true);
    expect(matchesQuery("Midnight Lo-Fi", "night")).toBe(true);
  });

  it("needs every word, in any order", () => {
    expect(matchesQuery("Midnight Lo-Fi", "fi midnight")).toBe(true);
    expect(matchesQuery("Midnight Lo-Fi", "midnight house")).toBe(false);
  });

  it("sees through hyphens, spaces and punctuation", () => {
    expect(matchesQuery("Midnight Lo-Fi", "lofi")).toBe(true);
    expect(matchesQuery("Neon Drive", "neondrive")).toBe(true);
    expect(matchesQuery("Beat #4 (final)", "beat 4 final")).toBe(true);
  });

  it("ignores accents, and keeps Norwegian letters searchable", () => {
    expect(matchesQuery("Café del Mar", "cafe")).toBe(true);
    expect(matchesQuery("Blåbær", "blabaer")).toBe(false);
    expect(matchesQuery("Blåbær", "blåbær")).toBe(true);
    expect(matchesQuery("Blåbær", "bla")).toBe(true);
  });

  it("does not match something that isn't there", () => {
    expect(matchesQuery("Neon Drive", "xyz")).toBe(false);
  });
});

describe("filterByName", () => {
  const projects = [{ name: "Neon Drive" }, { name: "Midnight Lo-Fi" }, { name: "Basement House" }];

  it("keeps the order and returns everything for an empty search", () => {
    expect(filterByName(projects, "", (p) => p.name)).toEqual(projects);
  });

  it("returns only the matches", () => {
    expect(filterByName(projects, "house", (p) => p.name)).toEqual([{ name: "Basement House" }]);
    expect(filterByName(projects, "n", (p) => p.name)).toHaveLength(3);
    expect(filterByName(projects, "qq", (p) => p.name)).toEqual([]);
  });
});
