/// <reference path="./types.d.ts" />
import type * as ReactDOMClientNS from "react-dom/client";

const host = globalThis.__SK_REACT_DOM_CLIENT__;
if (!host) {
  throw new Error(
    "signalk-container: window.__SK_REACT_DOM_CLIENT__ is not set by the host.",
  );
}

const c: typeof ReactDOMClientNS = host;

export default c;
export const { createRoot, hydrateRoot } = c;
