const host = /** @type {any} */ (globalThis).__SK_REACT_DOM_CLIENT__;
if (!host) {
  throw new Error(
    "signalk-container: window.__SK_REACT_DOM_CLIENT__ is not set by the host.",
  );
}
export default host.default ?? host;
export const createRoot = host.createRoot;
export const hydrateRoot = host.hydrateRoot;
