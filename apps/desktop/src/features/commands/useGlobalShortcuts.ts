import { useEffect } from 'react';
import { isMac } from '../../shared/ui';
import { eventToCombo, resolveBindings, type Command } from './model';
import { useCommandsState } from './context';

/** Écoute le clavier et exécute la commande liée à la combinaison (hors capture d'un nouveau raccourci). */
export function useGlobalShortcuts(commands: Command[], enabled = true): void {
  const overrides = useCommandsState((s) => s.overrides);
  useEffect(() => {
    if (!enabled) return;
    const bindings = resolveBindings(commands, overrides);
    const byCombo = new Map<string, Command>();
    for (const c of commands) {
      const combo = bindings.get(c.id);
      if (combo) byCombo.set(combo, c);
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const combo = eventToCombo(e, isMac());
      const cmd = combo ? byCombo.get(combo) : undefined;
      if (!cmd) return;
      e.preventDefault();
      cmd.run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [commands, overrides, enabled]);
}
