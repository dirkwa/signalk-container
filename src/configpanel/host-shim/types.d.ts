// The host signalk-server admin UI attaches its React/ReactDOM
// modules to these window globals before rendering. The shim modules
// in this directory read them and re-export so the plugin's `import
// 'react'` (aliased via vite.config.ts) resolves to the host's React
// instance instead of bundling a second copy. Contract is owned by
// SignalK/signalk-server (PR #2669).
declare global {
  interface Window {
    __SK_REACT__?: typeof import("react");
    __SK_REACT_DOM__?: typeof import("react-dom");
    __SK_REACT_DOM_CLIENT__?: typeof import("react-dom/client");
    __SK_REACT_JSX_RUNTIME__?: typeof import("react/jsx-runtime");
  }
}

export {};
