/**
 * Raccord avec le module de mise à jour de Tauri. Les mises à jour sont SIGNÉES : le module vérifie la signature avec la clé
 * publique de `tauri.conf.json` avant d'installer quoi que ce soit ; une archive modifiée ou non signée est refusée.
 * Hors de l'application installée (navigateur, tests), il n'y a pas de module : `createTauriUpdater()` renvoie `null`.
 */
export interface UpdateInfo {
  version: string;
  notes: string | null;
  date: string | null;
}

export interface UpdaterBackend {
  currentVersion(): Promise<string>;
  /** `null` : déjà à jour. Peut échouer (réseau, serveur) : l'appelant l'affiche, sans jamais bloquer l'application. */
  check(): Promise<UpdateInfo | null>;
  /** Télécharge, vérifie la signature, installe puis redémarre. `total` est inconnu (`null`) si le serveur ne le dit pas. */
  install(onProgress: (done: number, total: number | null) => void): Promise<void>;
}

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in (window as object);

export function createTauriUpdater(): UpdaterBackend | null {
  if (!isTauri()) return null;
  // Gardée entre « vérifier » et « installer » : c'est exactement la version annoncée à l'utilisateur qui est installée.
  let pending: import('@tauri-apps/plugin-updater').Update | null = null;
  return {
    async currentVersion() {
      const { getVersion } = await import('@tauri-apps/api/app');
      return getVersion();
    },
    async check() {
      const { check } = await import('@tauri-apps/plugin-updater');
      const u = await check();
      pending = u;
      return u ? { version: u.version, notes: u.body ?? null, date: u.date ?? null } : null;
    },
    async install(onProgress) {
      if (!pending) throw new Error('aucune mise à jour vérifiée');
      let done = 0;
      let total: number | null = null;
      await pending.downloadAndInstall((e) => {
        if (e.event === 'Started') total = e.data.contentLength ?? null;
        else if (e.event === 'Progress') {
          done += e.data.chunkLength;
          onProgress(done, total);
        }
      });
      const { relaunch } = await import('@tauri-apps/plugin-process');
      await relaunch();
    },
  };
}
