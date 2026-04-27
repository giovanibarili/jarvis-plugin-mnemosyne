// Ambient declarations for the JARVIS renderer runtime.
//
// React + HUD hooks are injected at runtime by the esbuild banner in
// app/src/server.ts (servePluginRenderer). They land as bare globals,
// so the TypeScript compiler needs to be told they exist.
//
// We don't pull in `@types/react` because it would force the renderer
// to bundle React itself; the banner already provides every hook used
// by the panel. JSX uses `jsx: react` mode (factory: createElement,
// fragment: Fragment), so a permissive `JSX` namespace is also declared.

declare namespace JSX {
  interface IntrinsicElements {
    [elemName: string]: any;
  }
  interface Element {}
  interface ElementClass { render: any; }
  interface ElementAttributesProperty { props: any; }
  interface ElementChildrenAttribute { children: any; }
  interface IntrinsicAttributes { key?: any; }
}

// React factory + fragment are injected as both `__jarvis_jsx`/`__jarvis_Fragment`
// and the more familiar names. The latter are what the source code uses.
declare const React: any;
declare const createElement: any;
declare const Fragment: any;

// React hooks — typed permissively so generic calls like `useState<X>` parse.
declare function useState<S = any>(initial?: S | (() => S)): [S, (v: S | ((prev: S) => S)) => void];
declare function useEffect(effect: () => void | (() => void), deps?: ReadonlyArray<any>): void;
declare function useRef<T = any>(initial?: T): { current: T };
declare function useCallback<T extends (...args: any[]) => any>(fn: T, deps: ReadonlyArray<any>): T;
declare function useMemo<T = any>(factory: () => T, deps: ReadonlyArray<any>): T;
declare function useSyncExternalStore<T = any>(subscribe: (cb: () => void) => () => void, getSnapshot: () => T): T;

// HUD hooks — provided by window.__JARVIS_HUD_HOOKS via the banner.
declare const useHudState: ((() => any) | undefined);
declare const useHudPiece: (((id: string) => any) | undefined);
declare const useHudReactor: ((() => any) | undefined);

interface Window {
  __JARVIS_REACT: {
    createElement: any;
    Fragment: any;
    useEffect: any;
    useRef: any;
    useState: any;
    useCallback: any;
    useMemo: any;
    useSyncExternalStore: any;
  };
  __JARVIS_HUD_HOOKS?: {
    useHudState: () => any;
    useHudPiece: (id: string) => any;
    useHudReactor: () => any;
  };
}
