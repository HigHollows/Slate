import type * as Y from 'yjs';

/** Documents Yjs des pages actuellement ouvertes : la synchronisation y applique les mises à jour distantes en direct. */
const live = new Map<string, Y.Doc>();

export const liveDocs = {
  register(nodeId: string, doc: Y.Doc): () => void {
    live.set(nodeId, doc);
    return () => {
      if (live.get(nodeId) === doc) live.delete(nodeId);
    };
  },
  get: (nodeId: string): Y.Doc | undefined => live.get(nodeId),
};
