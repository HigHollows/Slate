import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { createUpdatesStore, type UpdatesState, type UpdatesStore } from './store';

const C = createContext<UpdatesStore | null>(null);
export const UpdatesProvider = ({
  store,
  children,
}: {
  store: UpdatesStore;
  children: ReactNode;
}) => <C.Provider value={store}>{children}</C.Provider>;
export function useUpdatesStore(): UpdatesStore {
  const s = useContext(C);
  if (!s) throw new Error('UpdatesProvider manquant');
  return s;
}
export function useUpdates<T>(selector: (s: UpdatesState) => T): T {
  return useStore(useUpdatesStore(), selector);
}
export { createUpdatesStore };

const FIRST_CHECK_MS = 8_000;
const EVERY_MS = 6 * 60 * 60_000;
/** Contrôle discret : peu après le démarrage puis toutes les 6 h, seulement si la préférence est active. */
export function useAutoUpdateCheck(store: UpdatesStore) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interval: ReturnType<typeof setInterval> | undefined;
    void store
      .getState()
      .init()
      .then(() => {
        const run = () => {
          if (store.getState().auto) void store.getState().check({ silent: true });
        };
        timer = setTimeout(run, FIRST_CHECK_MS);
        interval = setInterval(run, EVERY_MS);
      });
    return () => {
      if (timer) clearTimeout(timer);
      if (interval) clearInterval(interval);
    };
  }, [store]);
}
