import { storage, type WxtStorageItem } from "@wxt-dev/storage";
import { atom, type SetStateAction } from "jotai";

/** Async key-value storage. Values must be JSON-serializable. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Keys in this store (without the store's own prefix). */
  keys(): Promise<string[]>;
  /** Call `callback` when the value changes in any Relay page or the service worker. */
  watch<T>(key: string, callback: (value: T | undefined) => void): () => void;
}

/** A namespaced view of the extension's local storage. */
export function chromeStore(namespace: string): KeyValueStore {
  const prefix = `${namespace}:`;
  const key = (name: string) => `local:${prefix}${name}` as const;
  return {
    get: async <T>(name: string) => (await storage.getItem<T>(key(name))) ?? undefined,
    set: (name, value) => storage.setItem(key(name), value),
    delete: (name) => storage.removeItem(key(name)),
    async keys() {
      return Object.keys(await storage.snapshot("local"))
        .filter((name) => name.startsWith(prefix))
        .map((name) => name.slice(prefix.length));
    },
    watch: <T>(name: string, callback: (value: T | undefined) => void) =>
      storage.watch<T>(key(name), (value) => callback(value ?? undefined)),
  };
}

/**
 * A Jotai atom over a storage item. A write updates the atom at once and then storage. Write
 * `sync` once per store to load the stored value and follow writes from other Relay pages and
 * the service worker; it resolves to a function that stops following them.
 */
export function storageAtom<T, M extends Record<string, unknown>>(item: WxtStorageItem<T, M>) {
  const value = atom(item.fallback);
  const sync = atom(null, async (_get, set) => {
    const unwatch = item.watch((next) => set(value, next));
    set(value, await item.getValue());
    return unwatch;
  });
  const stored = atom(
    (get) => get(value),
    (get, set, update: SetStateAction<T>) => {
      const next = typeof update === "function" ? (update as (prev: T) => T)(get(value)) : update;
      set(value, next);
      return item.setValue(next);
    },
  );
  return Object.assign(stored, { sync });
}
