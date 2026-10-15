import { defineConfig } from "vite";
import os from "node:os";
import path from "node:path";

// Keep Vite's dependency cache outside the repo: a cloud-synced folder locks files in
// node_modules/.vite mid-rename during dep optimization, which fails with EBUSY.
const cacheDir = path.join(
  process.env.LOCALAPPDATA || os.tmpdir(),
  "GSEditor",
  "vite-cache",
);

export default defineConfig({
  cacheDir,
  // GitHub Pages serves the site under /<repo>/ — the Pages workflow sets GSEDITOR_BASE
  base: process.env.GSEDITOR_BASE || "/",
  // Local dev only: GS files put in 01_Assets (git-ignored) are served at "/" for ?gs=…
  publicDir: "../../01_Assets",
  server: { open: true, port: 5173 },
  build: { target: "esnext" },
});
