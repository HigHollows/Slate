import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { PagesState, PagesStore } from './store';

const Ctx = createContext<PagesStore | null>(null);
export const PagesProvider = ({ store, children }: { store: PagesStore; children: ReactNode }) => (
  <Ctx.Provider value={store}>{children}</Ctx.Provider>
);
export function usePagesStore(): PagesStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('PagesProvider manquant');
  return s;
}
export function usePages<T>(selector: (s: PagesState) => T): T {
  return useStore(usePagesStore(), selector);
}
