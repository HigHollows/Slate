import { createStore, useStore } from 'zustand';
import type { UpdateInfo, UpdaterBackend } from '../../shared/updater';

export type UpdateStatus =
  'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'error' | 'unavailable';

export const AUTO_UPDATE_KEY = 'ui.auto-update';

export interface UpdatesState {
  status: UpdateStatus;
  currentVersion: string | null;
  info: UpdateInfo | null;
  /** 0 à 1, ou `null` si la taille est inconnue. */
  progress: number | null;
  lastCheckedAt: string | null;
  /** Vérification automatique au démarrage puis toutes les 6 h (désactivable). Une installation demande toujours un clic. */
  auto: boolean;
  init(): Promise<void>;
  check(opts?: { silent?: boolean }): Promise<void>;
  install(): Promise<void>;
  setAuto(v: boolean): Promise<void>;
}

export interface UpdatesDeps {
  /** `null` : pas de module de mise à jour (navigateur, tests). */
  backend: UpdaterBackend | null;
  settings: {
    settingsGetAll(): Promise<{ key: string; valueJson: string }[]>;
    settingsSet(key: string, valueJson: string): Promise<unknown>;
  };
  now?: () => Date;
  onError?(e: unknown): void;
}

export function createUpdatesStore(d: UpdatesDeps) {
  const now = d.now ?? (() => new Date());
  return createStore<UpdatesState>((set, get) => ({
    status: d.backend ? 'idle' : 'unavailable',
    currentVersion: null,
    info: null,
    progress: null,
    lastCheckedAt: null,
    auto: true,

    async init() {
      if (!d.backend) return;
      try {
        set({ currentVersion: await d.backend.currentVersion() });
      } catch {
        /* version inconnue : sans gravité */
      }
      try {
        const row = (await d.settings.settingsGetAll()).find((r) => r.key === AUTO_UPDATE_KEY);
        if (row) set({ auto: JSON.parse(row.valueJson) !== false });
      } catch {
        /* préférence illisible : vérification automatique par défaut */
      }
    },

    async check(opts) {
      const st = get().status;
      if (!d.backend || st === 'checking' || st === 'downloading') return;
      // Un contrôle automatique n'affiche ni « recherche en cours » ni erreur.
      if (!opts?.silent) set({ status: 'checking' });
      try {
        const info = await d.backend.check();
        set({
          lastCheckedAt: now().toISOString(),
          info,
          status: info ? 'available' : 'upToDate',
        });
      } catch (e) {
        if (!opts?.silent) {
          set({ status: 'error' });
          d.onError?.(e);
        }
      }
    },

    async install() {
      if (!d.backend || get().status !== 'available') return;
      set({ status: 'downloading', progress: null });
      try {
        await d.backend.install((done, total) =>
          set({ progress: total ? Math.min(1, done / total) : null }),
        );
        // Si on arrive ici sans redémarrage, l'installation a abouti : on le dit plutôt que de laisser « en cours ».
        set({ status: 'upToDate', info: null, progress: null });
      } catch (e) {
        set({ status: 'error', progress: null });
        d.onError?.(e);
      }
    },

    async setAuto(v) {
      set({ auto: v });
      try {
        await d.settings.settingsSet(AUTO_UPDATE_KEY, JSON.stringify(v));
      } catch (e) {
        d.onError?.(e);
      }
    },
  }));
}
export type UpdatesStore = ReturnType<typeof createUpdatesStore>;
export const useUpdatesState = <T>(s: UpdatesStore, sel: (x: UpdatesState) => T): T =>
  useStore(s, sel);
