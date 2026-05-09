import path from "node:path";
import url from "node:url";
import { defineConfig } from "vite";
import { federation } from "@module-federation/vite";
import react from "@vitejs/plugin-react";
import packageJson from "./package.json" with { type: "json" };

const here = path.dirname(url.fileURLToPath(import.meta.url));
const containerName = packageJson.name.replace(/[-@/]/g, "_");

export default defineConfig({
  // resolve.alias makes the plugin's `import 'react'` resolve to a
  // tiny shim that re-exports window.__SK_REACT__ — the React instance
  // the host signalk-server admin UI already loaded. Without this, the
  // bundle ships its own React copy and hooks call into a dispatcher
  // that's never been activated, throwing
  // "Cannot read properties of null (reading 'useState')".
  resolve: {
    alias: [
      {
        find: /^react\/jsx-(dev-)?runtime$/,
        replacement: path.resolve(
          here,
          "src/configpanel/host-shim/react-jsx-runtime.js",
        ),
      },
      {
        find: "react-dom/client",
        replacement: path.resolve(
          here,
          "src/configpanel/host-shim/react-dom-client.js",
        ),
      },
      {
        find: /^react-dom$/,
        replacement: path.resolve(
          here,
          "src/configpanel/host-shim/react-dom.js",
        ),
      },
      {
        find: /^react$/,
        replacement: path.resolve(here, "src/configpanel/host-shim/react.js"),
      },
    ],
  },
  plugins: [
    react(),
    federation({
      name: containerName,
      filename: "remoteEntry.js",
      exposes: {
        "./PluginConfigurationPanel":
          "./src/configpanel/PluginConfigurationPanel.jsx",
      },
      // No `shared` declaration: React/ReactDOM come from the host via
      // resolve.alias above and aren't part of federation share scope.
      shared: {},
    }),
  ],
  build: {
    outDir: "public",
    emptyOutDir: true,
    target: "es2022",
    minify: true,
    modulePreload: false,
    cssCodeSplit: false,
    rollupOptions: {
      input: "./src/configpanel/PluginConfigurationPanel.jsx",
      preserveEntrySignatures: "exports-only",
      output: {
        format: "esm",
        entryFileNames: "configpanel-entry.js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(
      process.env.NODE_ENV || "production",
    ),
  },
});
