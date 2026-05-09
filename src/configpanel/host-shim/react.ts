// Re-export the host signalk-server admin UI's React instance so plugin
// components share the same React (single dispatcher, single hook
// state). The host (signalk-server's bootstrap.tsx) attaches React to
// window.__SK_REACT__ before rendering so this shim resolves
// synchronously when the plugin's configpanel module evaluates.
/// <reference path="./types.d.ts" />
import type ReactNS from "react";

const host = globalThis.__SK_REACT__;
if (!host) {
  throw new Error(
    "signalk-container: window.__SK_REACT__ is not set. The host signalk-server admin UI must expose React on window for plugin federation. Update signalk-server to a version that ships the host-React contract (SignalK/signalk-server#2669).",
  );
}

const r: typeof ReactNS = host;

export default r;
export const {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  cache,
  cacheSignal,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} = r;
