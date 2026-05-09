/// <reference path="./types.d.ts" />
import type ReactDOMNS from "react-dom";

const host = globalThis.__SK_REACT_DOM__;
if (!host) {
  throw new Error(
    "signalk-container: window.__SK_REACT_DOM__ is not set by the host.",
  );
}

const d: typeof ReactDOMNS = host;

export default d;
export const {
  createPortal,
  flushSync,
  preconnect,
  prefetchDNS,
  preinit,
  preinitModule,
  preload,
  preloadModule,
  unstable_batchedUpdates,
  version,
} = d;
