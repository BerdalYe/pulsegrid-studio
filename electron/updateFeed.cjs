/**
 * The small, pure parts of the updater: reading the update feed and comparing
 * versions. Kept apart from updates.cjs so they can be tested without Electron.
 */

/** "1.2.10" -> [1, 2, 10]. Anything after a "-" or "+" (a pre-release tag) is ignored. */
function versionParts(version) {
  const core = String(version).trim().replace(/^v/i, "").split(/[-+]/)[0];
  const parts = core.split(".").map((part) => Number.parseInt(part, 10));
  return parts.length >= 1 && parts.every(Number.isFinite) ? parts : null;
}

/** 1 if `a` is newer than `b`, -1 if older, 0 if equal or if either isn't a version. */
function compareVersions(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  if (!left || !right) return 0;

  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0;
    const y = right[i] ?? 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

const unquote = (value) => value.replace(/^['"]|['"]$/g, "");

/**
 * Reads the feed the website serves at /downloads/latest.yml: the newest
 * version, where its installer is, how big it is and its SHA-512 (base64).
 * Returns null for anything that doesn't look like a feed.
 */
function parseFeed(text) {
  if (typeof text !== "string" || text.length > 20_000) return null;

  const find = (pattern) => {
    const match = pattern.exec(text);
    return match ? unquote(match[1].trim()) : null;
  };

  const version = find(/^version:\s*(\S+)/m);
  const url = find(/^\s*-\s*url:\s*(\S+)/m) ?? find(/^path:\s*(\S+)/m);
  const sha512 = find(/^\s+sha512:\s*(\S+)/m) ?? find(/^sha512:\s*(\S+)/m);
  const size = Number.parseInt(find(/^\s+size:\s*(\d+)/m) ?? "", 10);

  if (!version || !versionParts(version) || !url || !sha512) return null;
  return { version, url, sha512, size: Number.isFinite(size) ? size : null };
}

/**
 * The installer must come over a secure connection and be an .msi. The one
 * exception is a local stand-in server, and only when testing.
 */
function isAcceptableInstallerUrl(url, testing = false) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const secure = parsed.protocol === "https:";
  const local = testing && parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
  return (secure || local) && /\.msi$/i.test(parsed.pathname);
}

module.exports = { compareVersions, parseFeed, isAcceptableInstallerUrl, versionParts };
