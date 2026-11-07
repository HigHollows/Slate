import { createStore, useStore } from 'zustand';
import {
  DEFAULT_PREFERENCES,
  parsePreferences,
  storageKey,
  validatePatch,
  type PreferenceKey,
  type Preferences,
} from './model';

export interface SettingsApi {
  settingsGetAll(): Promise<{ key: string; valueJson: string }[]>;
  settingsSet(key: string, valueJson: string): Promise<void>;
  settingsDelete(key: string): Promise<void>;
}

export interface PreferencesState {
  prefs: Preferences;
  loaded: boolean;
  /** Clés stockées illisibles au chargement (retombées sur la valeur par défaut). */
  invalidKeys: string[];
  hydrate(): Promise<void>;
  /** Mise à jour optimiste ; en cas d'échec d'écriture, l'état est restauré et l'erreur est rejetée. */
  update(patch: Partial<Preferences>): Promise<void>;
  reset(keys?: PreferenceKey[]): Promise<void>;
}

export function createPreferencesStore(api: SettingsApi, onError: (e: unknown) => void = () => {}) {
  return createStore<PreferencesState>((set, get) => ({
    prefs: DEFAULT_PREFERENCES,
    loaded: false,
    invalidKeys: [],

    async hydrate() {
      try {
        const { prefs, invalidKeys } = parsePreferences(await api.settingsGetAll());
        set({ prefs, invalidKeys, loaded: true });
      } catch (e) {
        set({ loaded: true });
        onError(e);
      }
    },

    async update(patch) {
      const valid = validatePatch(patch);
      const previous = get().prefs;
      set({ prefs: { ...previous, ...valid } });
      try {
        for (const k of Object.keys(valid) as PreferenceKey[]) {
          await api.settingsSet(storageKey(k), JSON.stringify(valid[k]));
        }
      } catch (e) {
        set({ prefs: previous });
        onError(e);
        throw e;
      }
    },

    async reset(keys) {
      const names = keys ?? (Object.keys(DEFAULT_PREFERENCES) as PreferenceKey[]);
      const previous = get().prefs;
      const next = { ...previous };
      for (const k of names) (next[k] as unknown) = DEFAULT_PREFERENCES[k];
      set({ prefs: next });
      try {
        for (const k of names) await api.settingsDelete(storageKey(k));
      } catch (e) {
        set({ prefs: previous });
        onError(e);
        throw e;
      }
    },
  }));
}

export type PreferencesStore = ReturnType<typeof createPreferencesStore>;
export const usePreferencesState = <T>(
  store: PreferencesStore,
  selector: (s: PreferencesState) => T,
): T => useStore(store, selector);
