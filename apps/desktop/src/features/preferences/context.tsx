import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { applyPreferences } from './apply';
import type { PreferencesState, PreferencesStore } from './store';

const Ctx = createContext<PreferencesStore | null>(null);

/** Fournit le store et applique les préférences au document (thème système suivi en direct). */
export function PreferencesProvider({
  store,
  children,
}: {
  store: PreferencesStore;
  children: ReactNode;
}) {
  const prefs = useStore(store, (s) => s.prefs);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const run = () => applyPreferences(prefs, mq.matches);
    run();
    mq.addEventListener('change', run);
    return () => mq.removeEventListener('change', run);
  }, [prefs]);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function usePreferencesStore(): PreferencesStore {
  const s = useContext(Ctx);
  if (!s) throw new Error('PreferencesProvider manquant');
  return s;
}
export function usePreferences<T>(selector: (s: PreferencesState) => T): T {
  return useStore(usePreferencesStore(), selector);
}
