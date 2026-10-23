/// <reference types="vitest" />
import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Connect, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const root = path.dirname(fileURLToPath(import.meta.url));

const { version, pulsegrid } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  version: string;
  pulsegrid?: {
    releaseUrl?: string;
    siteUrl?: string;
    supabase?: { url?: string; anonKey?: string };
  };
};

const INSTALLER = `PulseGrid-Studio-Setup-${version}.msi`;
const MAC_INSTALLER = `PulseGrid-Studio-${version}-mac.dmg`;

// Shown on the website and used to name the installer download.
process.env.VITE_APP_VERSION = version;

// Where the installer is downloaded from. package.json → pulsegrid.releaseUrl
// names a folder of release files, such as a GitHub release
// (".../releases/download/v{version}/"); the website's host then serves only
// the small pages and the update feed, never the 100 MB installer. Without it
// the installer is served next to the site from /downloads/.
const RELEASE_URL = (pulsegrid?.releaseUrl ?? "").split("{version}").join(version);
const hostedElsewhere = /^https?:\/\//i.test(RELEASE_URL);

process.env.VITE_DOWNLOAD_URL ??= hostedElsewhere
  ? `${RELEASE_URL.replace(/\/?$/, "/")}${INSTALLER}`
  : `/downloads/${INSTALLER}`;

// The Mac download lives next to the Windows one. It is built separately (on a
// Mac, by GitHub), so the site links to where it will be rather than checking.
process.env.VITE_MAC_DOWNLOAD_URL ??= hostedElsewhere
  ? `${RELEASE_URL.replace(/\/?$/, "/")}${MAC_INSTALLER}`
  : `/downloads/${MAC_INSTALLER}`;

/**
 * Facts about the installer for the website's download box — size, release
 * date and SHA-256 — read from the actual file, so they can never drift from
 * what people download. Placeholders until `npm run dist:win` has run.
 */
function describeInstaller(): { size: string; date: string; sha256: string } {
  const file = path.join(root, "release", INSTALLER);
  if (!existsSync(file)) return { size: "about 110 MB", date: "", sha256: "" };

  const stat = statSync(file);
  return {
    size: `${(stat.size / 1024 / 1024).toFixed(1)} MB`,
    date: stat.mtime.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
    sha256: createHash("sha256").update(readFileSync(file)).digest("hex").toUpperCase()
  };
}

const installer = describeInstaller();
process.env.VITE_INSTALLER_SIZE = installer.size;
process.env.VITE_RELEASE_DATE = installer.date;
process.env.VITE_INSTALLER_SHA256 = installer.sha256;

/**
 * The update feed the desktop app reads (electron/updates.cjs): the newest
 * version and the installer's SHA-512, in the `latest.yml` format
 * the app's updater (electron/updates.cjs) reads. It sits next to the installer in /downloads/, and
 * points at VITE_DOWNLOAD_URL instead when the installer is hosted elsewhere.
 */
function updateFeed(): string | null {
  const file = path.join(root, "release", INSTALLER);
  if (!existsSync(file)) return null;

  const sha512 = createHash("sha512").update(readFileSync(file)).digest("base64");
  const downloadUrl = process.env.VITE_DOWNLOAD_URL ?? "";
  const url = /^https?:\/\//i.test(downloadUrl) ? downloadUrl : INSTALLER;
  const stat = statSync(file);

  return [
    `version: ${version}`,
    "files:",
    `  - url: ${url}`,
    `    sha512: ${sha512}`,
    `    size: ${stat.size}`,
    `path: ${url}`,
    `sha512: ${sha512}`,
    `releaseDate: '${stat.mtime.toISOString()}'`,
    ""
  ].join("\n");
}

/**
 * Makes the website's Download button work however the site is run: the dev
 * server and `vite preview` serve /downloads/ straight from release/, and
 * every build copies the installer into dist/downloads/. It is built by
 * `npm run dist:win`; until then the button reports it missing rather than
 * the site silently linking to nothing.
 */
function installerDownloads(): Plugin {
  const releaseDir = path.join(root, "release");
  let outDir = path.join(root, "dist");
  let building = false;

  const serve: Connect.NextHandleFunction = (req, res, next) => {
    const url = decodeURIComponent((req.url ?? "").split("?")[0]);
    if (!url.startsWith("/downloads/")) return next();

    const name = path.basename(url);
    const file = path.join(releaseDir, name);

    if (name === "latest.yml") {
      const feed = updateFeed();
      res.statusCode = feed ? 200 : 404;
      res.setHeader("content-type", "text/yaml; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.end(feed ?? "No installer built yet.");
      return;
    }

    if (!/\.msi$/.test(name) || !existsSync(file)) {
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(`${name} hasn't been built yet. Run: npm run dist:win`);
      return;
    }

    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-length", String(statSync(file).size));
    res.setHeader("content-disposition", `attachment; filename="${name}"`);
    createReadStream(file).pipe(res);
  };

  return {
    name: "pulsegrid-installer-downloads",
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
      building = config.command === "build";
    },
    configureServer(server) {
      server.middlewares.use(serve);
    },
    configurePreviewServer(server) {
      server.middlewares.use(serve);
    },
    closeBundle() {
      if (!building) return;

      const source = path.join(releaseDir, INSTALLER);
      if (!existsSync(source)) {
        this.warn(`No installer at release/${INSTALLER} — build it with npm run dist:win.`);
        return;
      }

      const downloads = path.join(outDir, "downloads");
      mkdirSync(downloads, { recursive: true });

      if (hostedElsewhere) {
        // Old links to /downloads/…msi (and anything else there but the feed,
        // which is a real file and wins) go to the current installer. Netlify
        // reads this file; other hosts ignore it.
        writeFileSync(
          path.join(outDir, "_redirects"),
          `/downloads/*  ${process.env.VITE_DOWNLOAD_URL}  302\n`
        );
      } else {
        copyFileSync(source, path.join(downloads, INSTALLER));
      }

      const feed = updateFeed();
      if (feed) writeFileSync(path.join(downloads, "latest.yml"), feed);
    }
  };
}

export default defineConfig({
  plugins: [react(), installerDownloads()],
  define: {
    // The studio shows its own version in the top bar and window title.
    __APP_VERSION__: JSON.stringify(version),
    // Cloud sync. The anon key is public by design: what a signed-in user may
    // touch is decided by the row-level rules in supabase/schema.sql, not by
    // keeping this key secret. Never put a service_role key anywhere near here.
    // PULSEGRID_TEST_SUPABASE_URL points a throwaway build at a local stand-in for testing.
    __SUPABASE_URL__: JSON.stringify(process.env.PULSEGRID_TEST_SUPABASE_URL ?? pulsegrid?.supabase?.url ?? ""),
    __SUPABASE_ANON_KEY__: JSON.stringify(
      process.env.PULSEGRID_TEST_SUPABASE_URL ? "test-anon-key-for-local-mock-only" : (pulsegrid?.supabase?.anonKey ?? "")
    ),
    __SITE_URL__: JSON.stringify(pulsegrid?.siteUrl ?? "")
  },
  build: {
    target: "es2020",
    // The site and the app ship minified code only, no readable source.
    sourcemap: false,
    rollupOptions: {
      // index.html is the website; studio.html is the studio itself (and what
      // the desktop app loads).
      input: {
        site: "index.html",
        studio: "studio.html",
        legal: "legal.html",
        account: "account.html",
        signedIn: "signed-in.html"
      }
    }
  },
  worker: {
    format: "es"
  },
  server: {
    // The plugin host's C++ build (native/) changes thousands of files Vite has no use for, and locks some.
    watch: { ignored: ["**/native/**", "**/release/**"] }
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
