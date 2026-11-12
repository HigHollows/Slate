import { useEffect } from 'react';
import { snapshotTabs, useNav } from './store';

export const TABS_KEY = 'ui.tabs';

interface SettingsApi {
  settingsGetAll(): Promise<{ key: string; valueJson: string }[]>;
  settingsSet(key: string, valueJson: string): Promise<unknown>;
}

/**
 * Retrouve ses onglets au démarrage et les enregistre (légèrement différé) à chaque changement. Seule la route courante de
 * chaque onglet est gardée : jamais de contenu. Une valeur illisible est ignorée (on repart d'un onglet « accueil »).
 */
export function useTabsPersistence(
  api: SettingsApi,
  onError: (e: unknown) => void = () => undefined,
  delayMs = 400,
) {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ready = false;
    let alive = true;
    const save = () => {
      timer = undefined;
      api.settingsSet(TABS_KEY, JSON.stringify(snapshotTabs(useNav.getState()))).catch(onError);
    };
    const off = useNav.subscribe((s, prev) => {
      if (!ready || (s.tabs === prev.tabs && s.activeId === prev.activeId)) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(save, delayMs);
    });
    void api.settingsGetAll().then(
      (rows) => {
        if (!alive) return;
        const row = rows.find((r) => r.key === TABS_KEY);
        if (row) {
          try {
            useNav.getState().hydrate(JSON.parse(row.valueJson));
          } catch {
            /* valeur illisible : un seul onglet « accueil » */
          }
        }
        ready = true;
      },
      () => {
        ready = true;
      },
    );
    return () => {
      alive = false;
      off();
      if (timer) {
        clearTimeout(timer);
        save(); // on n'oublie pas la dernière modification à la fermeture
      }
    };
  }, [api, onError, delayMs]);
}
