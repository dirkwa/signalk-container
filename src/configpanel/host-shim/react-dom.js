const host = /** @type {any} */ (globalThis).__SK_REACT_DOM__;
if (!host) {
  throw new Error(
    "signalk-container: window.__SK_REACT_DOM__ is not set by the host.",
  );
}
export default host.default ?? host;
export const createPortal = host.createPortal;
export const flushSync = host.flushSync;
export const preconnect = host.preconnect;
export const prefetchDNS = host.prefetchDNS;
export const preinit = host.preinit;
export const preinitModule = host.preinitModule;
export const preload = host.preload;
export const preloadModule = host.preloadModule;
export const unstable_batchedUpdates = host.unstable_batchedUpdates;
export const version = host.version;
