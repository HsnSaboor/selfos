import { resolve } from "node:path";
import { copyFileSync, cpSync, mkdirSync, readdirSync } from "node:fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

/**
 * SQL migrations are read from disk at runtime (`__dirname/migrations`), so they
 * must be copied next to the main bundle instead of being bundled.
 */
function copyMigrations() {
  return {
    name: "copy-migrations",
    closeBundle() {
      const from = resolve(__dirname, "src/main/db/migrations");
      const to = resolve(__dirname, "out/main/migrations");
      mkdirSync(to, { recursive: true });
      for (const f of readdirSync(from)) copyFileSync(resolve(from, f), resolve(to, f));
    },
  };
}

/**
 * pdf.js is loaded by URL at runtime (worker + main module), so both files must
 * sit next to the renderer output. Bundling them through Vite breaks the worker
 * wiring, which is why they are copied as static assets.
 */
function copyPdfJs() {
  const root = resolve(__dirname, "node_modules/pdfjs-dist");
  const to = resolve(__dirname, "out/renderer/pdfjs");
  const copy = () => {
    // Same origin as the page: a Worker cannot be constructed from another
    // origin, and pdf.js needs its worker (STACK §6.6). The wasm and cMap
    // assets must be present too — pdf.js 5 blocks on them.
    mkdirSync(to, { recursive: true });
    for (const f of ["pdf.mjs", "pdf.worker.mjs"]) {
      copyFileSync(resolve(root, "build", f), resolve(to, f));
    }
    for (const dir of ["wasm", "cmaps", "standard_fonts", "iccs"]) {
      cpSync(resolve(root, dir), resolve(to, dir), { recursive: true });
    }
  };
  return {
    name: "copy-pdfjs",
    // `electron-vite dev` never runs closeBundle, so the reader had no pdf.js
    // at all on a clean tree, and the production `selfos-app://` base is a
    // different origin from the dev page — the exact cross-origin worker
    // deadlock RESULTS.md measured. Copy before the dev server starts and serve
    // the directory as the page origin's public root.
    config(_config: unknown, { command }: { command: string }) {
      if (command === "serve") {
        copy();
        return { publicDir: to };
      }
      return undefined;
    },
    closeBundle() {
      copy();
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), copyMigrations()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          // The history ingest runs in a worker thread (STACK §4.1): it does
          // synchronous file copies and `DatabaseSync` reads, which would block
          // every IPC call if they ran on the main process. It is a separate
          // entry so `new Worker(join(__dirname, "ingest-worker.cjs"))` finds a
          // real file next to the main bundle.
          "ingest-worker": resolve(__dirname, "src/main/integrations/browser-history/ingest-worker.ts"),
        },
        // Electron's `electron` module is CommonJS; ESM named imports fail at
        // runtime. Emit CJS for the main process.
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
        // A sandboxed preload must be CommonJS (Electron 45, STACK C-11).
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react(), copyPdfJs()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, "src/renderer/index.html") } },
    },
  },
});
