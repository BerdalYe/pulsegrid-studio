/**
 * Help → Report a problem: opens a new GitHub issue with a short template
 * filled in. Only the app's version and where it runs go into the report —
 * nothing about the project — and the user sees and edits all of it before
 * anything is sent.
 */
/** Where the source code lives: PulseGrid Studio is open source (GPL-3.0). */
export const REPO_URL = "https://github.com/BerdalYe/pulsegrid-studio";
export const ISSUES_URL = `${REPO_URL}/issues/new`;

/** A plain browser name from a user-agent string, or null when unsure. */
export function browserName(userAgent: string): string | null {
  if (/Edg\//.test(userAgent)) return "Edge";
  if (/OPR\//.test(userAgent)) return "Opera";
  if (/Firefox\//.test(userAgent)) return "Firefox";
  if (/Chrome\//.test(userAgent)) return "Chrome";
  if (/Safari\//.test(userAgent)) return "Safari";
  return null;
}

export function reportProblemUrl(options: {
  version: string;
  desktop: boolean;
  /** "darwin" for the Mac app; anything else is the Windows app. */
  platform?: string;
  userAgent?: string;
}): string {
  const where = options.desktop
    ? `${options.platform === "darwin" ? "Mac" : "Windows"} desktop app`
    : `web studio${browserName(options.userAgent ?? "") ? ` in ${browserName(options.userAgent ?? "")}` : ""}`;

  const body = [
    "**What happened?**",
    "",
    "",
    "**What did you expect to happen?**",
    "",
    "",
    "**Steps to make it happen again**",
    "1. ",
    "",
    "---",
    `PulseGrid Studio ${options.version} · ${where}`
  ].join("\n");

  return `${ISSUES_URL}?${new URLSearchParams({ body }).toString()}`;
}
