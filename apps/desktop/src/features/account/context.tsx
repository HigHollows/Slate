import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { AccountState, AccountStore } from './store';

const Ctx = createContext<AccountStore | null>(null);
export const AccountProvider = ({
  store,
  children,
}: {
  store: AccountStore;
  children: ReactNode;
}) => <Ctx.Provider value={store}>{children}</Ctx.Provider>;
export function useAccountStore(): AccountStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('AccountProvider manquant');
  return s;
}
export function useAccount<T>(selector: (s: AccountState) => T): T {
  return useStore(useAccountStore(), selector);
}
