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
          "src/configpanel/host-shim/react-jsx-runtime.ts",
        ),
      },
      {
        find: "react-dom/client",
        replacement: path.resolve(
          here,
          "src/configpanel/host-shim/react-dom-client.ts",
        ),
      },
      {
        find: /^react-dom$/,
        replacement: path.resolve(
          here,
          "src/configpanel/host-shim/react-dom.ts",
        ),
      },
      {
        find: /^react$/,
        replacement: path.resolve(here, "src/configpanel/host-shim/react.ts"),
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
          "./src/configpanel/PluginConfigurationPanel.tsx",
      },
      // No `shared` declaration — react/react-dom are aliased above
      // to host-shim modules, so they never enter the bundle's share
      // scope. This avoids the vite-MF + React 19 host-mismatch
      // hook-dispatcher problem.
      shared: {},
      // Disable @module-federation/dts-plugin: it tries to compile
      // exposed modules with a generated tsconfig that conflicts with
      // ours (src/configpanel is excluded from tsc emit on purpose).
      // The host doesn't consume our types — it reads the global at
      // runtime — so skipping DTS keeps the build quiet.
      dts: false,
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
      input: "./src/configpanel/PluginConfigurationPanel.tsx",
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
