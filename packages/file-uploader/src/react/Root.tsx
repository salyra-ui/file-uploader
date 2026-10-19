import { useEffect, useMemo, type ReactNode } from "react";
import {
  createUploader,
  type UploaderOptions,
  type UploaderStore,
} from "../core";
import { UploaderContext } from "./context";
export interface RootProps {
  store?: UploaderStore;
  options?: UploaderOptions;
  children?: ReactNode;
  restore?: boolean;
}
export function Root({ store, options, children, restore = true }: RootProps) {
  const owned = useMemo(() => {
    if (store) return store;
    if (!options)
      throw new Error("FileUploader.Root requires a store or options");
    return createUploader(options);
  }, [store]);
  const value = useMemo(
    () => ({ store: owned, inputs: new Set<HTMLInputElement>() }),
    [owned],
  );
  const lifecycle = useMemo(() => ({ generation: 0 }), [owned]);
  useEffect(() => {
    lifecycle.generation++;
    if (restore) void owned.restore();
    return () => {
      const ticket = ++lifecycle.generation;
      if (!store)
        queueMicrotask(() => {
          if (lifecycle.generation === ticket) owned.destroy();
        });
    };
  }, [owned, store, restore, lifecycle]);
  return (
    <UploaderContext.Provider value={value}>
      {children}
    </UploaderContext.Provider>
  );
}
