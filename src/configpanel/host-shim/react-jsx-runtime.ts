/// <reference path="./types.d.ts" />
import type * as JSXRuntimeNS from "react/jsx-runtime";

const host = globalThis.__SK_REACT_JSX_RUNTIME__;
if (!host) {
  throw new Error(
    "signalk-container: window.__SK_REACT_JSX_RUNTIME__ is not set by the host.",
  );
}

const j: typeof JSXRuntimeNS = host;

export const { Fragment, jsx, jsxs } = j;
// jsxDEV is part of the dev runtime; absent in the production runtime
// type but vite/rollup may resolve react/jsx-dev-runtime to this same
// shim, so re-export when present.
export const jsxDEV = (j as { jsxDEV?: unknown }).jsxDEV;
