import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { SecurityState, SecurityStore } from './store';

const Ctx = createContext<SecurityStore | null>(null);
export const SecurityProvider = ({
  store,
  children,
}: {
  store: SecurityStore;
  children: ReactNode;
}) => <Ctx.Provider value={store}>{children}</Ctx.Provider>;
export function useSecurityStore(): SecurityStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('SecurityProvider manquant');
  return s;
}
export function useSecurity<T>(selector: (s: SecurityState) => T): T {
  return useStore(useSecurityStore(), selector);
}
