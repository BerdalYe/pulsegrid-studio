/**
 * `npm run app:dev` — the desktop app against the Vite dev server, with hot
 * reload. Starts Vite, waits for it, then opens Electron pointed at it.
 */
import { spawn } from "node:child_process";
import { createServer } from "vite";

const server = await createServer();
await server.listen();

const url = server.resolvedUrls?.local[0] ?? "http://localhost:5173/";
console.log(`Vite ready at ${url} — starting Electron`);

const electron = spawn("npx", ["electron", "."], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, PULSEGRID_DEV_URL: url }
});

electron.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
