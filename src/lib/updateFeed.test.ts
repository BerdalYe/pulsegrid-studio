import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { compareVersions, isAcceptableInstallerUrl, parseFeed } = require("../../electron/updateFeed.cjs") as {
  compareVersions: (a: string, b: string) => number;
  isAcceptableInstallerUrl: (url: string, testing?: boolean) => boolean;
  parseFeed: (text: string) => { version: string; url: string; sha512: string; size: number | null } | null;
};

const FEED = [
  "version: 1.3.0",
  "files:",
  "  - url: https://github.com/BerdalYe/pulsegrid-studio/releases/download/v1.3.0/PulseGrid-Studio-Setup-1.3.0.msi",
  "    sha512: abc123+/def==",
  "    size: 112430000",
  "path: https://github.com/BerdalYe/pulsegrid-studio/releases/download/v1.3.0/PulseGrid-Studio-Setup-1.3.0.msi",
  "sha512: abc123+/def==",
  "releaseDate: '2026-10-06T10:00:00.000Z'",
  ""
].join("\n");

describe("compareVersions", () => {
  it("orders versions by number, not as text", () => {
    expect(compareVersions("1.3.0", "1.2.0")).toBe(1);
    expect(compareVersions("1.2.0", "1.3.0")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
  });

  it("treats equal and missing parts as equal", () => {
    expect(compareVersions("1.2.0", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("v1.2.0", "1.2.0")).toBe(0);
  });

  it("ignores a pre-release tag", () => {
    expect(compareVersions("1.3.0-beta.1", "1.2.0")).toBe(1);
  });

  it("never calls something newer when it isn't a version", () => {
    expect(compareVersions("nonsense", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.0", "")).toBe(0);
  });
});

describe("parseFeed", () => {
  it("reads the version, installer, checksum and size", () => {
    expect(parseFeed(FEED)).toEqual({
      version: "1.3.0",
      url: "https://github.com/BerdalYe/pulsegrid-studio/releases/download/v1.3.0/PulseGrid-Studio-Setup-1.3.0.msi",
      sha512: "abc123+/def==",
      size: 112430000
    });
  });

  it("reads a feed that only has the top-level fields", () => {
    const feed = parseFeed("version: 2.0.0\npath: https://x.test/a.msi\nsha512: zzz==\n");
    expect(feed?.url).toBe("https://x.test/a.msi");
    expect(feed?.size).toBeNull();
  });

  it("rejects anything that isn't a feed", () => {
    expect(parseFeed("")).toBeNull();
    expect(parseFeed("<html>404 Not Found</html>")).toBeNull();
    expect(parseFeed("version: banana\npath: https://x.test/a.msi\nsha512: zzz==")).toBeNull();
    expect(parseFeed("version: 1.0.0\npath: https://x.test/a.msi")).toBeNull();
    expect(parseFeed("version: 1.0.0\nsha512: zzz==")).toBeNull();
    expect(parseFeed("x".repeat(30_000))).toBeNull();
  });
});

describe("isAcceptableInstallerUrl", () => {
  it("accepts a secure .msi address", () => {
    expect(isAcceptableInstallerUrl("https://github.com/x/y/releases/download/v1/Setup.msi")).toBe(true);
    expect(isAcceptableInstallerUrl("https://x.test/Setup.MSI?token=1")).toBe(true);
  });

  it("refuses anything else", () => {
    expect(isAcceptableInstallerUrl("http://x.test/Setup.msi")).toBe(false);
    expect(isAcceptableInstallerUrl("https://x.test/Setup.exe")).toBe(false);
    expect(isAcceptableInstallerUrl("file:///C:/Setup.msi")).toBe(false);
    expect(isAcceptableInstallerUrl("ftp://x.test/Setup.msi")).toBe(false);
    expect(isAcceptableInstallerUrl("not a url")).toBe(false);
  });

  it("allows a local stand-in only while testing", () => {
    expect(isAcceptableInstallerUrl("http://127.0.0.1:8000/Setup.msi")).toBe(false);
    expect(isAcceptableInstallerUrl("http://127.0.0.1:8000/Setup.msi", true)).toBe(true);
    expect(isAcceptableInstallerUrl("http://evil.test/Setup.msi", true)).toBe(false);
  });
});
