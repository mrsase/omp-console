import { createContext, createElement, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { MessageRecord } from "../protocol/types";
import { ConsoleStore, createStore } from "./store";

const defaultStore = createStore();
const StoreContext = createContext<ConsoleStore>(defaultStore);

export function StoreProvider({ store, children }: { store: ConsoleStore; children: ReactNode }) {
  return createElement(StoreContext.Provider, { value: store }, children);
}

export function useStore(): ConsoleStore {
  return useContext(StoreContext);
}

export function useAppState() {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

/** Subscribe to one normalized message; a token wakes only this row. */
export function useRow(threadId: string, key: string): MessageRecord | undefined {
  const store = useStore();
  return useSyncExternalStore(
    (listener) => store.subscribeRow(threadId, key, listener),
    () => store.row(threadId, key),
    () => store.row(threadId, key),
  );
}

export { defaultStore };
