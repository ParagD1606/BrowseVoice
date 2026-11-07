import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { copyFileSync, existsSync, mkdirSync, cpSync } from "fs";

export default defineConfig({
  // Chrome extension pages are loaded from chrome-extension:// URLs. Relative
  // asset paths keep the generated side panel portable when unpacked.
  base: "./",
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

        // Tesseract runs in a local extension worker; MV3 disallows its default
        // remotely hosted worker script. Bundle the worker/core beside the UI.
        mkdirSync("dist/ocr", { recursive: true });
        mkdirSync("dist/ocr/lang", { recursive: true });
        copyFileSync("node_modules/tesseract.js/dist/worker.min.js", "dist/ocr/worker.min.js");
        for (const file of [
          "tesseract-core.wasm.js", "tesseract-core.wasm",
          "tesseract-core-simd.wasm.js", "tesseract-core-simd.wasm",
          "tesseract-core-lstm.wasm.js", "tesseract-core-lstm.wasm",
          "tesseract-core-simd-lstm.wasm.js", "tesseract-core-simd-lstm.wasm",
          "tesseract-core-relaxedsimd.wasm.js", "tesseract-core-relaxedsimd.wasm",
          "tesseract-core-relaxedsimd-lstm.wasm.js", "tesseract-core-relaxedsimd-lstm.wasm",
        ]) {
          copyFileSync(`node_modules/tesseract.js-core/${file}`, `dist/ocr/${file}`);
        }
        for (const language of ["eng", "hin", "mar"]) {
          copyFileSync(`ocr-data/${language}.traineddata.gz`, `dist/ocr/lang/${language}.traineddata.gz`);
        }

        // Copy mock-portal
        if (existsSync("mock-portal")) {
          cpSync("mock-portal", "dist/mock-portal", { recursive: true });
        }
      },
    },
  ],
  build: {
    modulePreload: { polyfill: false },
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
