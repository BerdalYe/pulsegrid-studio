import { describe, expect, it } from "vitest";

import { friendlyOAuthError, readOAuthReturn, withoutOAuthParams } from "./oauth";

describe("readOAuthReturn", () => {
  it("finds the code in the windows app's link", () => {
    expect(readOAuthReturn("pulsegrid://auth?code=abc123")).toEqual({ kind: "code", code: "abc123" });
    // Windows may add a slash after the name.
    expect(readOAuthReturn("pulsegrid://auth/?code=abc123")).toEqual({ kind: "code", code: "abc123" });
  });

  it("finds the code in the web studio's address", () => {
    expect(readOAuthReturn("https://pulsegridstudio.netlify.app/studio.html?code=xyz")).toEqual({
      kind: "code",
      code: "xyz"
    });
  });

  it("reads a problem sent in the query or in the #fragment", () => {
    const query = readOAuthReturn("pulsegrid://auth?error=access_denied&error_description=User+denied");
    expect(query).toEqual({ kind: "error", message: "Discord sign-in was cancelled." });

    const hash = readOAuthReturn("https://example.test/studio.html#error=access_denied&error_code=bad");
    expect(hash.kind).toBe("error");
  });

  it("is quiet when the address has nothing to do with signing in", () => {
    expect(readOAuthReturn("https://pulsegridstudio.netlify.app/studio.html")).toEqual({ kind: "none" });
    expect(readOAuthReturn("not an address")).toEqual({ kind: "none" });
  });
});

describe("friendlyOAuthError", () => {
  it("explains a missing email", () => {
    expect(friendlyOAuthError("server_error", "Error getting user email from external provider")).toMatch(/verified email/i);
  });

  it("says when sign-in was cancelled", () => {
    expect(friendlyOAuthError("access_denied", "The resource owner denied the request")).toBe("Discord sign-in was cancelled.");
  });

  it("has a plain fallback", () => {
    expect(friendlyOAuthError("weird", "")).toBe("Discord sign-in didn't work. Try again.");
  });
});

describe("withoutOAuthParams", () => {
  it("removes the code and keeps the rest", () => {
    expect(withoutOAuthParams("https://x.test/studio.html?code=abc&keep=1#frag")).toBe("https://x.test/studio.html?keep=1");
  });
});
