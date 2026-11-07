import { Extension } from '@tiptap/core';
import { yCursorPlugin } from '@tiptap/y-tiptap';
import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { Awareness } from 'y-protocols/awareness';
import { cleanName, type PresenceService } from '../../shared/presence';

const Ctx = createContext<PresenceService | null>(null);
/** Fournit le transport de la présence ; sans fournisseur (invité, cloud absent, tests), l'éditeur reste purement local. */
export function PresenceProvider({
  value,
  children,
}: {
  value: PresenceService | null;
  children: ReactNode;
}) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
export const usePresenceService = () => useContext(Ctx);

/**
 * Curseurs et sélections des autres participants. Identité visuelle monochrome : le repère d'un participant est son NOM
 * (étiquette), jamais une couleur. Le nom est inséré comme TEXTE (jamais en HTML).
 */
export const PresenceCursors = Extension.create<{ awareness: Awareness | null }>({
  name: 'presenceCursors',
  addOptions: () => ({ awareness: null }),
  addProseMirrorPlugins() {
    const awareness = this.options.awareness;
    if (!awareness) return [];
    return [
      yCursorPlugin(awareness, {
        cursorBuilder: (user) => {
          const caret = document.createElement('span');
          caret.className = 'slate-remote-caret';
          const label = document.createElement('span');
          label.className = 'slate-remote-caret-label';
          label.textContent = cleanName((user as { name?: unknown }).name) || '?';
          caret.append(document.createTextNode('⁠'), label, document.createTextNode('⁠'));
          return caret;
        },
        selectionBuilder: () => ({ class: 'slate-remote-selection', style: '' }),
      }),
    ];
  },
});

/** Participants présents sur la page (hors nous), dédoublonnés par nom, ordre stable. */
export function usePresentNames(awareness: Awareness | null): string[] {
  const subscribe = useMemo(
    () => (cb: () => void) => {
      if (!awareness) return () => undefined;
      awareness.on('change', cb);
      return () => awareness.off('change', cb);
    },
    [awareness],
  );
  // Instantané stable (chaîne) : pas de nouvel objet à chaque lecture.
  const key = useSyncExternalStore(subscribe, () => {
    if (!awareness) return '';
    const names: string[] = [];
    awareness.getStates().forEach((st, id) => {
      if (id === awareness.clientID) return;
      names.push(cleanName((st as { user?: { name?: unknown } }).user?.name) || '?');
    });
    return JSON.stringify([...new Set(names)].sort((a, b) => a.localeCompare(b)));
  });
  return useMemo(() => JSON.parse(key || '[]') as string[], [key]);
}

/** « Avec : Bob, Ada » : annoncé poliment aux lecteurs d'écran, absent quand on est seul. */
export function PresenceBar({ awareness }: { awareness: Awareness | null }) {
  const { t } = useTranslation();
  const names = usePresentNames(awareness);
  if (names.length === 0) return null;
  const shown = names.slice(0, 5);
  const more = names.length - shown.length;
  return (
    <p role="status" aria-live="polite" className="mb-2 text-xs text-muted">
      {t('presence.with', { names: shown.join(', ') })}
      {more > 0 ? ` ${t('presence.more', { count: more })}` : ''}
    </p>
  );
}
