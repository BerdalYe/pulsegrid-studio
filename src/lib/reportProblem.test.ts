import { describe, expect, it } from "vitest";

import { ISSUES_URL, browserName, reportProblemUrl } from "./reportProblem";

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const EDGE = `${CHROME} Edg/140.0.0.0`;
const FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:142.0) Gecko/20100101 Firefox/142.0";

describe("browserName", () => {
  it("tells the common browsers apart, even though Edge also says Chrome", () => {
    expect(browserName(EDGE)).toBe("Edge");
    expect(browserName(CHROME)).toBe("Chrome");
    expect(browserName(FIREFOX)).toBe("Firefox");
    expect(browserName("curl/8.0")).toBeNull();
  });
});

describe("reportProblemUrl", () => {
  const bodyOf = (url: string) => new URL(url).searchParams.get("body") ?? "";

  it("opens a new issue on the PulseGrid repository", () => {
    const url = reportProblemUrl({ version: "1.2.3", desktop: true });
    expect(url.startsWith(`${ISSUES_URL}?`)).toBe(true);
  });

  it("says which version and where it runs, and nothing else about the user", () => {
    const desktop = bodyOf(reportProblemUrl({ version: "1.2.3", desktop: true, userAgent: CHROME }));
    expect(desktop).toContain("PulseGrid Studio 1.2.3 · Windows desktop app");
    expect(desktop).not.toContain("Chrome");

    const web = bodyOf(reportProblemUrl({ version: "1.2.3", desktop: false, userAgent: FIREFOX }));
    expect(web).toContain("PulseGrid Studio 1.2.3 · web studio in Firefox");
  });

  it("leaves room for the user to describe the problem", () => {
    const body = bodyOf(reportProblemUrl({ version: "1.2.3", desktop: false }));
    expect(body).toContain("**What happened?**");
    expect(body).toContain("**Steps to make it happen again**");
    expect(body).toContain("PulseGrid Studio 1.2.3 · web studio");
  });
});
