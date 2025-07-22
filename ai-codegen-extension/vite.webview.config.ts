// ai-codegen-extension/vite.webview.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  // 1️⃣ Roten för Vite – här ligger index.html och main.tsx
  root: fileURLToPath(new URL("./src/webview", import.meta.url)),

  // 2️⃣ Viktigt för webviews – relativa URLs
  base: "./",

  plugins: [
    react(),
  ],

  resolve: {
    // Alias '@' → projektets 'src'-mapp
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  build: {
    // Ut-mappen för din webview-bundle
    outDir: fileURLToPath(new URL("./dist-webview", import.meta.url)),
    emptyOutDir: true,         // rensa vid varje build
    assetsDir: "assets",       // JS/CSS hamnar under dist-webview/assets

    rollupOptions: {
      // Input är din HTML-mall som pekar på main.tsx
      input: fileURLToPath(new URL("./src/webview/index.html", import.meta.url)),
    },
  },
});
