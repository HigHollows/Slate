import { flushAll, hasUnsavedChanges } from '../../shared/save-manager';

/**
 * Fermeture de la fenêtre (Tauri) : écrire tout ce qui est en attente avant de quitter.
 * Si l'écriture échoue, la fermeture est ANNULÉE et `onBlocked` prévient l'utilisateur
 * (une seconde demande de fermeture dans les 5 s force la sortie, en connaissance de cause).
 */
export async function installCloseGuard(
  onBlocked: () => void,
  extra?: { pending(): boolean; flush(): Promise<void> },
): Promise<() => void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return () => undefined;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  let blockedAt = 0;
  const unlisten = await win.onCloseRequested(async (event) => {
    if (!hasUnsavedChanges() && !extra?.pending()) return;
    event.preventDefault();
    try {
      await flushAll();
      await extra?.flush();
    } catch {
      if (Date.now() - blockedAt < 5000) {
        await win.destroy();
        return;
      }
      blockedAt = Date.now();
      onBlocked();
      return;
    }
    await win.destroy();
  });
  return unlisten;
}
