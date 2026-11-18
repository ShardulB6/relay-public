import { existsSync, readdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { crx } from "@crxjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite-plus";
import { defineConfig } from "vite-plus";

import manifest from "./manifest.config.ts";

/**
 * pdf.js's character maps, at `pdfjs/cmaps/` in the build. PDFs whose fonts use predefined
 * encodings, common in Chinese, Japanese and Korean documents, need them for their text.
 */
function pdfCMaps(): Plugin {
  const require = createRequire(import.meta.url);
  const directory = join(dirname(require.resolve("pdfjs-dist/package.json")), "cmaps");
  return {
    name: "relay:pdf-cmaps",
    async generateBundle() {
      for (const name of await readdir(directory)) {
        this.emitFile({
          type: "asset",
          fileName: `pdfjs/cmaps/${name}`,
          source: await readFile(join(directory, name)),
        });
      }
    },
  };
}

/**
 * Where the build goes. `RELAY_OUT_DIR` points every worktree at one folder, so the extension
 * Chrome has loaded from it stays the same one (same ID, storage and sign-ins) across worktrees.
 * Vite empties the folder before each build, so it must be missing, empty, or a previous build.
 */
function outDir(): string {
  const configured = process.env.RELAY_OUT_DIR?.trim();
  if (!configured) return "dist";
  const directory = resolve(configured.replace(/^~(?=$|\/)/, homedir()));
  if (
    existsSync(directory) &&
    readdirSync(directory).length > 0 &&
    !existsSync(join(directory, "manifest.json"))
  ) {
    throw new Error(`RELAY_OUT_DIR (${directory}) is not empty and holds no extension build`);
  }
  return directory;
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), crx({ manifest }), pdfCMaps()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: outDir(),
    // Vite only empties an output folder outside the project when told to.
    emptyOutDir: true,
    // Functions passed to `page.evaluate` are serialized as source, so they must not be
    // down-leveled into code that depends on bundler helpers.
    target: "esnext",
    // `pnpm dev` is a watch build (see package.json): readable output and source maps.
    minify: mode !== "development",
    sourcemap: mode === "development",
    // The side panel bundles model catalogs and provider SDKs; it is loaded from disk.
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test-setup.ts"],
  },
}));
