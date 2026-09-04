import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

const dir = import.meta.dirname;

// login + setup are standalone auth entries (not the Landing SPA). Landing's index
// entry is added by T2. Output lands in dist/web (served by web.ts at cutover, T9).
export default defineConfig({
  root: dir,
  plugins: [vue()],
  build: {
    outDir: resolve(dir, "../dist/web"),
    emptyOutDir: false,
    rollupOptions: {
      input: {
        login: resolve(dir, "login.html"),
        setup: resolve(dir, "setup.html"),
      },
    },
  },
});
