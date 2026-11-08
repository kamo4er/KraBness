import { defineConfig } from "vite";

// Панель замечаний по вёрстке — отдельный скрипт без React: хаб вставляет его в страницы превью (apps/hub/src/preview.ts).
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: false,
    lib: { entry: "src/overlay/main.ts", formats: ["iife"], name: "KrabNotes", fileName: () => "krab-overlay.js" },
  },
});
