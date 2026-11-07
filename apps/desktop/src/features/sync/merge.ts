import * as Y from 'yjs';
import { fromBase64, toBase64 } from '../editor/content';

export interface MergeResult {
  /** `true` si les mises à jour distantes ont apporté du contenu nouveau. */
  changed: boolean;
  doc: Y.Doc;
  state: string;
}

/**
 * Fusionne des mises à jour Yjs distantes dans l'état local (ou dans un document vide). Appliquer une mise à jour déjà
 * connue est sans effet : `changed` reste faux, ce qui évite toute écriture (et tout écho) inutile.
 */
export function mergeUpdates(localState: string | null, updates: string[]): MergeResult {
  const doc = new Y.Doc();
  if (localState) Y.applyUpdate(doc, fromBase64(localState));
  const before = Y.encodeStateVector(doc);
  for (const u of updates) Y.applyUpdate(doc, fromBase64(u), 'remote');
  const after = Y.encodeStateVector(doc);
  const changed = before.length !== after.length || before.some((b, i) => b !== after[i]);
  return { changed, doc, state: toBase64(Y.encodeStateAsUpdate(doc)) };
}
