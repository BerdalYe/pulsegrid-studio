/**
 * Runs after the app is packed, before the installer is made.
 *
 * On a Mac, an app that carries no signature at all is refused outright on
 * Apple Silicon ("is damaged and can't be opened"). Without an Apple Developer
 * certificate it can still carry an "ad-hoc" signature, which costs nothing and
 * is enough for people to open it the usual way (right-click, Open). It does
 * not replace real signing: macOS still says the developer can't be verified.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;

  // Real signing, when a certificate is configured, does this properly itself.
  if (process.env.CSC_LINK || process.env.CSC_NAME) return;

  if (process.platform !== "darwin") {
    console.warn("  • skipping the ad-hoc signature: it can only be applied on a Mac");
    return;
  }

  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing  file=${app}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
};
