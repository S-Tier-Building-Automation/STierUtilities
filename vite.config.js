import { defineConfig } from "vite";
import { svelte, vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Frontend build for the Tauri webview. The web root is src/ (where index.html,
// main.js and styles.css already live), bundled to ../dist which tauri.conf.json
// points `frontendDist` at. UI components are Svelte 5 (.svelte); the testable
// core (store/router) stays plain ESM so `node --test` needs no compiler.
//
// `TAURI_DEV_HOST` is set by `tauri dev` when developing against a physical
// device on the LAN; locally it is unset and the server stays on localhost.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // Config inlined here (configFile:false) because the project's web root is
  // src/ and vite-plugin-svelte would otherwise search there for svelte.config.js.
  plugins: [svelte({ configFile: false, preprocess: vitePreprocess() })],
  root: "src",
  // Tauri pins the dev server to a fixed port; don't let Vite wipe Tauri's logs
  // or silently fall back to a different port.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Bind IPv4 loopback explicitly. The Tauri webview resolves the devUrl
    // `localhost` to 127.0.0.1, but `localhost` on this machine binds Node to
    // IPv6 ::1 only, so the webview would get ERR_CONNECTION_REFUSED. Pin to
    // 127.0.0.1 (a LAN host from TAURI_DEV_HOST still wins for device testing).
    host: host || "127.0.0.1",
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: true,
  },
});
