/**
 * `npm run native` — builds the VST3 plugin host (native/plugin-host) with Visual Studio's C++ tools and CMake,
 * and copies it to native/plugin-host/bin, where the app looks for it and the installer packs it from.
 * Windows only; elsewhere it says so and does nothing, so the other builds still run.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";

if (process.platform !== "win32") {
  console.log("The plugin host is Windows-only for now: skipped.");
  process.exit(0);
}

const root = path.resolve("native/plugin-host");
const build = path.join(root, "build");
const vswhere = String.raw`C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe`;

function findCmake() {
  if (existsSync(vswhere)) {
    const install = execFileSync(vswhere, ["-latest", "-products", "*", "-property", "installationPath"], { encoding: "utf8" }).trim();
    const bundled = path.join(install, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin", "cmake.exe");
    if (install && existsSync(bundled)) return bundled;
  }
  return "cmake";
}

const cmake = findCmake();
const run = (args) => execFileSync(cmake, args, { stdio: "inherit" });
run(["-S", root, "-B", build, "-G", "Visual Studio 17 2022", "-A", "x64"]);
run(["--build", build, "--config", "Release", "--parallel"]);

mkdirSync(path.join(root, "bin"), { recursive: true });
const target = path.join(root, "bin", "pulsegrid-plugin-host.exe");
// Copies left from earlier builds that were still running then.
for (const name of readdirSync(path.join(root, "bin"))) {
  if (/^pulsegrid-plugin-host\.old-\d+\.exe$/.test(name)) {
    try {
      rmSync(path.join(root, "bin", name), { force: true });
    } catch {
      /* still running: removed next time */
    }
  }
}
try {
  copyFileSync(path.join(build, "Release", "pulsegrid-plugin-host.exe"), target);
} catch (error) {
  if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
  // A studio running in development is using it. A running program can be renamed though, so it keeps going on
  // the old copy and the next start picks up the new one.
  renameSync(target, path.join(root, "bin", `pulsegrid-plugin-host.old-${Date.now()}.exe`));
  copyFileSync(path.join(build, "Release", "pulsegrid-plugin-host.exe"), target);
  console.log("The plugin host was running: the new one is used from its next start.");
}
// The test instrument is kept apart from what the installer packs.
mkdirSync(path.join(root, "bin", "test"), { recursive: true });
try {
  copyFileSync(path.join(build, "Release", "PulseGrid Test Synth.vst3"), path.join(root, "bin", "test", "PulseGrid Test Synth.vst3"));
} catch (error) {
  // Loaded in a running studio: the copy there is kept.
  if (error.code !== "EBUSY" && error.code !== "EPERM") throw error;
}
console.log("Built native/plugin-host/bin/pulsegrid-plugin-host.exe (and the test synth in bin/test)");
