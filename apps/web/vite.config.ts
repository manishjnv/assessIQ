import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import type { Plugin } from "vite";
import { assertTryHead, renderTryHtml } from "./src/lib/tryHead";

// Z-32: emit dist/try/index.html with a real head. The frontend nginx `try_files $uri $uri/ /index.html`
// serves it for /try; no edge change. Fails the build if the head check fails.
const prerenderTryHead = (): Plugin => ({
  name: "assessiq-prerender-try-head",
  apply: "build",
  generateBundle: {
    order: "post", // after vite:build-html has emitted index.html
    handler(_o, bundle) {
      const idx = bundle["index.html"];
      if (!idx || idx.type !== "asset") throw new Error("prerender /try: index.html missing from bundle");
      const html = renderTryHtml(String(idx.source));
      assertTryHead(html);
      this.emitFile({ type: "asset", fileName: "try/index.html", source: html });
    },
  },
});

// E2E only (apps/web/e2e/local-stack.sh): proxy /api to a local API so the SPA is same-origin.
// The magic-link POST /take/start is mounted at the bare root (Caddy forwards it too), so proxy it as well.
const apiTarget = process.env["E2E_API_PROXY"];
const apiProxy = apiTarget ? { proxy: { "/api": apiTarget, "^/take/start$": apiTarget } } : {};

export default defineConfig({
  plugins: [react(), prerenderTryHead()],
  server: {
    port: 5173,
    host: true,
    ...apiProxy,
  },
  preview: { ...apiProxy },
  build: {
    // Keep Vite 5's browser floor: Vite 7+ raised the default target, and campus
    // lab PCs often run older Chrome/Edge. Candidates must not get a blank page.
    target: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
    rolldownOptions: {
      output: {
        // Separate React/router into a cacheable vendor chunk so it doesn't
        // re-download when admin-dashboard or candidate-ui chunks change.
        codeSplitting: {
          groups: [
            { name: "vendor-react", test: /node_modules[\\/](react|react-dom|react-router-dom|react-router|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
});
