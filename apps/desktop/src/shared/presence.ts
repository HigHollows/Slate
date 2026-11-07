import type * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

/**
 * Raccord entre l'éditeur (qui affiche curseurs et présents) et le réseau (qui les transporte) : l'éditeur ne connaît
 * que ce contrat, jamais Realtime. `attach` rend la fonction qui détache (fermeture de la page).
 */
export interface PresenceService {
  attach(nodeId: string, ydoc: Y.Doc, awareness: Awareness): () => void;
}

const MAX_NAME = 60;
/** Contrôles C0/C1 et marques de direction (usurpation visuelle) : jamais affichés. */
const hidden = (c: number) =>
  c < 0x20 ||
  (c >= 0x7f && c <= 0x9f) ||
  c === 0x200e ||
  c === 0x200f ||
  (c >= 0x202a && c <= 0x202e) ||
  (c >= 0x2066 && c <= 0x2069);
/** Nom affichable : texte seul, sans caractères de contrôle ni de direction, borné. */
export function cleanName(v: unknown): string {
  if (typeof v !== 'string') return '';
  let out = '';
  for (const ch of v) if (!hidden(ch.codePointAt(0) ?? 0)) out += ch;
  return out.trim().slice(0, MAX_NAME);
}
