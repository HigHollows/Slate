import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { DatabasesState, DatabasesStore, Loaded } from './store';

const Ctx = createContext<DatabasesStore | null>(null);
export const DatabasesProvider = ({
  store,
  children,
}: {
  store: DatabasesStore;
  children: ReactNode;
}) => <Ctx.Provider value={store}>{children}</Ctx.Provider>;
export function useDatabasesStore(): DatabasesStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('DatabasesProvider manquant');
  return s;
}
export function useDatabases<T>(selector: (s: DatabasesState) => T): T {
  return useStore(useDatabasesStore(), selector);
}
export function useDatabase(id: string): Loaded | undefined {
  return useDatabases((s) => s.dbs[id]);
}
