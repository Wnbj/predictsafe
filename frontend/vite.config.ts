import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Every Vercel build names its files after the commit as well as their content.
 *
 * Found 2026-10-13: during a deploy the new index.html reached a browser before
 * the new script did, the catch-all rewrite answered the missing script with
 * index.html, and a one-year `immutable` header pinned that HTML in the browser
 * cache under the script's name — a blank site until the cache was cleared. The
 * rewrite and the header are fixed in vercel.json; this makes sure a bad entry
 * a browser already holds can never outlive the deploy it came from, even when
 * a commit leaves the bundle's content (and so its hash) unchanged.
 */
const build = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7);
const suffix = build ? `-${build}` : "";

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-[hash]${suffix}.js`,
        chunkFileNames: `assets/[name]-[hash]${suffix}.js`,
        assetFileNames: `assets/[name]-[hash]${suffix}[extname]`,
        // Libraries in their own files: they change far less often than the
        // app, so a deploy does not make every visitor download them again.
        manualChunks: (id) =>
          id.includes("node_modules/viem") || id.includes("node_modules/@noble") || id.includes("node_modules/abitype")
            ? "viem"
            : id.includes("node_modules/react")
              ? "react"
              : undefined,
      },
    },
  },
});
