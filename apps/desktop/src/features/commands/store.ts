import { createStore } from 'zustand';
import { z } from 'zod';
import type { Overrides } from './model';

export interface CommandsApi {
  settingsSet(key: string, valueJson: string): Promise<void>;
  settingsDelete(key: string): Promise<void>;
}

const MAX_HISTORY = 8;
const comboSchema = z.string().min(1).max(40).nullable();
const historySchema = z.array(z.string()).max(50);
export const shortcutKey = (id: string) => `shortcut.${id}`;
export const HISTORY_KEY = 'history.commands';

export interface CommandsState {
  overrides: Overrides;
  history: string[];
  paletteOpen: boolean;
  hydrate(rows: { key: string; valueJson: string }[]): void;
  setPaletteOpen(open: boolean): void;
  setShortcut(id: string, combo: string | null): Promise<void>;
  resetShortcut(id: string): Promise<void>;
  recordRun(id: string): Promise<void>;
}

export function createCommandsStore(api: CommandsApi, onError: (e: unknown) => void = () => {}) {
  return createStore<CommandsState>((set, get) => ({
    overrides: {},
    history: [],
    paletteOpen: false,

    hydrate(rows) {
      const overrides: Overrides = {};
      let history: string[] = [];
      for (const r of rows) {
        try {
          const v: unknown = JSON.parse(r.valueJson);
          if (r.key === HISTORY_KEY) {
            const h = historySchema.safeParse(v);
            if (h.success) history = h.data;
          } else if (r.key.startsWith('shortcut.')) {
            const c = comboSchema.safeParse(v);
            if (c.success) overrides[r.key.slice('shortcut.'.length)] = c.data;
          }
        } catch {
          /* valeur illisible : ignorée, la commande retombe sur son raccourci par défaut */
        }
      }
      set({ overrides, history });
    },

    setPaletteOpen: (open) => set({ paletteOpen: open }),

    async setShortcut(id, combo) {
      const prev = get().overrides;
      set({ overrides: { ...prev, [id]: combo } });
      try {
        await api.settingsSet(shortcutKey(id), JSON.stringify(combo));
      } catch (e) {
        set({ overrides: prev });
        onError(e);
        throw e;
      }
    },

    async resetShortcut(id) {
      const prev = get().overrides;
      const next = { ...prev };
      delete next[id];
      set({ overrides: next });
      try {
        await api.settingsDelete(shortcutKey(id));
      } catch (e) {
        set({ overrides: prev });
        onError(e);
        throw e;
      }
    },

    async recordRun(id) {
      const history = [id, ...get().history.filter((h) => h !== id)].slice(0, MAX_HISTORY);
      set({ history });
      try {
        await api.settingsSet(HISTORY_KEY, JSON.stringify(history));
      } catch (e) {
        onError(e); // l'historique est un confort : on signale sans bloquer l'exécution
      }
    },
  }));
}
export type CommandsStore = ReturnType<typeof createCommandsStore>;
