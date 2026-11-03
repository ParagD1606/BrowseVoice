import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { copyFileSync, existsSync, mkdirSync, cpSync } from "fs";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "copy-extension-static-assets",
      closeBundle() {
        if (!existsSync("dist")) {
          mkdirSync("dist", { recursive: true });
        }

        // Copy manifest
        copyFileSync("manifest.json", "dist/manifest.json");

        // Copy content overlay CSS
        if (!existsSync("dist/content")) {
          mkdirSync("dist/content", { recursive: true });
        }
        if (existsSync("content/overlay.css")) {
          copyFileSync("content/overlay.css", "dist/content/overlay.css");
        }

        // Copy mock-portal
        if (existsSync("mock-portal")) {
          cpSync("mock-portal", "dist/mock-portal", { recursive: true });
        }
      },
    },
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(import.meta.dirname, "sidepanel/index.html"),
        micPermission: resolve(import.meta.dirname, "sidepanel/mic-permission.html"),
        background: resolve(import.meta.dirname, "background/service-worker.ts"),
      },
      output: {
        entryFileNames: (chunk) => {
          if (chunk.name === "background") return "background/service-worker.js";
          return "assets/[name]-[hash].js";
        },
      },
    },
  },
});
