import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: {
      entry: resolve(import.meta.dirname, "content/index.ts"),
      name: "BrowseVoiceContent",
      formats: ["iife"],
      fileName: () => "content/index.js",
    },
  },
});
