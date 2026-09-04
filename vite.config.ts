import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Node backend (proxy.ts) default listen — see DEFAULT_PROXY_LISTEN in src/config.ts.
const BACKEND = "http://127.0.0.1:8687";

// Multi-page: Landing SPA + standalone login/setup entries. Final asset wiring is T9;
// build lands in a staging dir (dist/web-vue), leaving the vanilla dist/web untouched.
export default defineConfig({
  root: "src/web-vue",
  plugins: [vue()],
  build: {
    outDir: r("./dist/web-vue"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: r("./src/web-vue/index.html"),
        login: r("./src/web-vue/login.html"),
        setup: r("./src/web-vue/setup.html"),
      },
    },
  },
  server: {
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      // Control WS connects to root ("/") — proxy only the upgrade to the backend and
      // let ordinary HTTP fall through to Vite. HMR is untouched: Vite claims its own
      // upgrades by the `vite-hmr` subprotocol before the proxy sees them.
      "/": {
        target: BACKEND.replace("http", "ws"),
        ws: true,
        bypass(req) {
          if (req.headers.upgrade !== "websocket") return req.url;
        },
      },
    },
  },
});
