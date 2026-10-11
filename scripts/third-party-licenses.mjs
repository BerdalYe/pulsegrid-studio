/**
 * `npm run licenses` — writes public/THIRD_PARTY_LICENSES.txt: the licence of every package that ends up inside
 * the app and the website, found by building them and noting which packages the build reads. The file ships with
 * the app (and is served by the website), as the MIT, Apache, OFL and LGPL licences of those packages ask.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "vite";

const root = process.cwd();
const used = new Set();

const collect = {
  name: "collect-packages",
  enforce: "pre",
  load(id) {
    const clean = id.replace(/\\/g, "/").split("?")[0];
    const at = clean.lastIndexOf("/node_modules/");
    if (at < 0) return null;
    const parts = clean.slice(at + "/node_modules/".length).split("/");
    used.add(parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0]);
    return null;
  }
};

await build({ root, logLevel: "warn", plugins: [collect], build: { write: false } });

// Read where the scan above can't see: the export worker is built on its own (the MP3 encoder), and the website's
// font comes in through a CSS @import.
for (const name of ["lamejs", "@fontsource-variable/inter"]) used.add(name);

const licenceText = (dir) => {
  const file = readdirSync(dir).find((name) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(name));
  return file ? readFileSync(path.join(dir, file), "utf8").trim() : null;
};

const sections = [...used]
  .sort()
  .map((name) => {
    const dir = path.join(root, "node_modules", name);
    if (!existsSync(path.join(dir, "package.json"))) return null;
    const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
    const text = licenceText(dir) ?? `${pkg.license ?? "See the package"} licence. ${pkg.author ? `Copyright ${typeof pkg.author === "string" ? pkg.author : pkg.author.name}.` : ""}`;
    return `${"=".repeat(78)}\n${pkg.name} ${pkg.version} (${pkg.license ?? "unknown"})\n${pkg.homepage ?? ""}\n${"=".repeat(78)}\n\n${text}\n`;
  })
  .filter(Boolean);

const header = `PulseGrid Studio is free software under the GNU General Public License, version 3 or later (see LICENSE).

It includes the following packages, each under its own licence, reproduced below. The desktop apps are built on
Electron, whose licence and Chromium's are in the app's own folder (LICENSE and LICENSES.chromium.html). The
recorded instruments are GeneralUser GS by S. Christian Collins, under the licence in
assets/soundfonts/LICENSE-GeneralUser-GS.txt.

`;
writeFileSync(path.join(root, "public", "THIRD_PARTY_LICENSES.txt"), header + sections.join("\n"), "utf8");
console.log(`THIRD_PARTY_LICENSES.txt: ${sections.length} packages (${[...used].sort().join(", ")})`);
