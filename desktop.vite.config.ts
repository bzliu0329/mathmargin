import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname, "desktop"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "desktop-dist"),
    emptyOutDir: true,
  },
});
