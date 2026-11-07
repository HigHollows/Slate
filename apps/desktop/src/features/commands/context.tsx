import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { CommandsState, CommandsStore } from './store';

const Ctx = createContext<CommandsStore | null>(null);
export const CommandsProvider = ({
  store,
  children,
}: {
  store: CommandsStore;
  children: ReactNode;
}) => <Ctx.Provider value={store}>{children}</Ctx.Provider>;
export function useCommandsStore(): CommandsStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('CommandsProvider manquant');
  return s;
}
export function useCommandsState<T>(selector: (s: CommandsState) => T): T {
  return useStore(useCommandsStore(), selector);
}
