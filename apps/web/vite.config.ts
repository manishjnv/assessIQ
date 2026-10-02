import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
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
