import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          math: ["katex", "rehype-katex", "remark-math"],
          markdown: ["react-markdown", "remark-gfm"],
        },
      },
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:8000" } },
  test: { environment: "jsdom", globals: true },
});
