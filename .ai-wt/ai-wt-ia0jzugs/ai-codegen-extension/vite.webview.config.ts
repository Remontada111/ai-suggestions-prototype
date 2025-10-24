// ai-codegen-extension/vite.webview.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  /* 1️⃣  Projektets root = där index.html & main.tsx ligger */
  root: fileURLToPath(new URL("./src/webview", import.meta.url)),

  /* 2️⃣  Viktigt för VS Code‑webview: relativa länkar */
  base: "./",

  plugins: [react()],

  resolve: {
    /* Alias så "@/…" pekar på src/ */
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  build: {
    /* Var bundle‑filerna hamnar */
    outDir: fileURLToPath(new URL("./dist-webview", import.meta.url)),
    emptyOutDir: true,   // rensa vid varje build
    assetsDir: ".",      // lägg allt direkt i dist‑roten

    cssCodeSplit: true,  // extrahera Tailwind till egen fil

    rollupOptions: {
      /* HTML‑entry som refererar ./main.tsx */
      input: fileURLToPath(
        new URL("./src/webview/index.html", import.meta.url)
      ),

      /* 🔑  Skriv ut EXAKT main.js / tailwind.css (inga hash) */
      output: {
        entryFileNames: "main.js",
        assetFileNames: (assetInfo) =>
          assetInfo.name?.endsWith(".css") ? "tailwind.css" : assetInfo.name!,
      },
    },
  },
});
