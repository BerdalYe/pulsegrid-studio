# PulseGrid Studio (source)

The source code of PulseGrid Studio. This repository is private; the public one,
[pulsegrid-studio](https://github.com/BerdalYe/pulsegrid-studio), holds the releases.

## Building the Mac app

A `.dmg` can only be built on a Mac, so GitHub builds it:

1. Open the **Actions** tab, choose **Build the Mac app**, and press **Run workflow**.
2. When it finishes (about 10 minutes), open the run and download **PulseGrid-Studio-mac** at the bottom.
   Unzip it to get `PulseGrid-Studio-<version>-mac.dmg`.
3. Attach that file to the matching release in the public repository.

The Mac app is not signed with an Apple Developer certificate. It carries a free "ad-hoc"
signature (`build/afterPack.cjs`), so people open it with right-click → Open the first time.

## Building the Windows installer

On Windows: `npm run release` (needs Node 22 or newer). It writes `release/PulseGrid-Studio-Setup-<version>.msi`
and the website with its update feed into `dist/`.

## Development

```
npm install
npm run dev          # the web studio
npm run app          # the desktop app
npm test
```
