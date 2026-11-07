/** Petit bus d'événements typé pour synchroniser des stores indépendants (pages ↔ bases de données). */
export interface BusEvents {
  'node-renamed': { id: string; title: string };
  /** Un nœud a été restauré ou supprimé définitivement (les listes de lignes doivent se recharger). */
  'nodes-changed': { ids: string[] };
  /** Des données distantes viennent d'être appliquées localement (les panneaux ouverts doivent se relire). */
  'sync-applied': Record<string, never>;
}
type Handler<K extends keyof BusEvents> = (e: BusEvents[K]) => void;

const handlers = new Map<keyof BusEvents, Set<Handler<never>>>();

export const bus = {
  on<K extends keyof BusEvents>(k: K, h: Handler<K>): () => void {
    const set = handlers.get(k) ?? new Set();
    set.add(h as Handler<never>);
    handlers.set(k, set);
    return () => set.delete(h as Handler<never>);
  },
  emit<K extends keyof BusEvents>(k: K, e: BusEvents[K]): void {
    for (const h of handlers.get(k) ?? []) (h as Handler<K>)(e);
  },
};
