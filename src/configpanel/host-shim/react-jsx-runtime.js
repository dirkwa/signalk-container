const host = /** @type {any} */ (globalThis).__SK_REACT_JSX_RUNTIME__;
if (!host) {
  throw new Error(
    "signalk-container: window.__SK_REACT_JSX_RUNTIME__ is not set by the host.",
  );
}
export const Fragment = host.Fragment;
export const jsx = host.jsx;
export const jsxs = host.jsxs;
export const jsxDEV = host.jsxDEV;
