// Re-export the host signalk-server admin UI's React instance so plugin
// components share the same React (single dispatcher, single hook
// state). The host (signalk-server's bootstrap.tsx) attaches React to
// window.__SK_REACT__ before rendering so this shim resolves
// synchronously when the plugin's configpanel module evaluates.
const host = /** @type {any} */ (globalThis).__SK_REACT__;
if (!host) {
  throw new Error(
    "signalk-container: window.__SK_REACT__ is not set. The host signalk-server admin UI must expose React on window for plugin federation. Update signalk-server to a version that ships the host-React contract (SignalK/signalk-server#2669).",
  );
}
export default host.default ?? host;
export const Activity = host.Activity;
export const Children = host.Children;
export const Component = host.Component;
export const Fragment = host.Fragment;
export const Profiler = host.Profiler;
export const PureComponent = host.PureComponent;
export const StrictMode = host.StrictMode;
export const Suspense = host.Suspense;
export const cache = host.cache;
export const cacheSignal = host.cacheSignal;
export const cloneElement = host.cloneElement;
export const createContext = host.createContext;
export const createElement = host.createElement;
export const createRef = host.createRef;
export const forwardRef = host.forwardRef;
export const isValidElement = host.isValidElement;
export const lazy = host.lazy;
export const memo = host.memo;
export const startTransition = host.startTransition;
export const use = host.use;
export const useActionState = host.useActionState;
export const useCallback = host.useCallback;
export const useContext = host.useContext;
export const useDebugValue = host.useDebugValue;
export const useDeferredValue = host.useDeferredValue;
export const useEffect = host.useEffect;
export const useEffectEvent = host.useEffectEvent;
export const useId = host.useId;
export const useImperativeHandle = host.useImperativeHandle;
export const useInsertionEffect = host.useInsertionEffect;
export const useLayoutEffect = host.useLayoutEffect;
export const useMemo = host.useMemo;
export const useOptimistic = host.useOptimistic;
export const useReducer = host.useReducer;
export const useRef = host.useRef;
export const useState = host.useState;
export const useSyncExternalStore = host.useSyncExternalStore;
export const useTransition = host.useTransition;
export const version = host.version;
