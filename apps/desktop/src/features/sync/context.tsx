import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useStore } from 'zustand';
import type { SyncControl } from './controller';
import { createSyncStore, type SyncStore, type SyncUiState } from './store';

interface Ctx {
  store: SyncStore;
  control: SyncControl;
}
const C = createContext<Ctx | null>(null);
export const SyncProvider = ({ value, children }: { value: Ctx; children: ReactNode }) => (
  <C.Provider value={value}>{children}</C.Provider>
);
function useCtx(): Ctx {
  const c = useContext(C);
  if (!c) throw new Error('SyncProvider manquant');
  return c;
}
export const useSyncControl = () => useCtx().control;
export function useSync<T>(selector: (s: SyncUiState) => T): T {
  return useStore(useCtx().store, selector);
}
export { createSyncStore };

const INTERVAL_MS = 15_000;
/** Passes périodiques, au retour dans la fenêtre et à la reconnexion réseau. Sans effet tant que la synchronisation est désactivée. */
export function useSyncScheduler(control: SyncControl) {
  useEffect(() => {
    void control.refreshStatus().then(() => control.syncNow());
    const tick = () => void control.syncNow();
    const id = window.setInterval(tick, INTERVAL_MS);
    window.addEventListener('focus', tick);
    window.addEventListener('online', tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', tick);
      window.removeEventListener('online', tick);
    };
  }, [control]);
}
