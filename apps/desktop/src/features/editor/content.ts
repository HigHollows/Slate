/** Utilitaires purs sur le contenu ProseMirror (JSON) et l'encodage binaire. */

export interface PMNode {
  type?: string | undefined;
  attrs?: Record<string, unknown> | undefined;
  marks?: { type?: string; attrs?: Record<string, unknown> }[] | undefined;
  content?: PMNode[] | undefined;
}

import { internalPageId } from './link';

/** Identifiants des pages mentionnées (@) ou liées par un lien interne (dédoublonnés, ordre d'apparition). */
export function extractLinkTargets(doc: PMNode): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (n: PMNode) => {
    if (n.type === 'pageMention') {
      const id = n.attrs?.['id'];
      if (typeof id === 'string' && id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    for (const m of n.marks ?? []) {
      const id = m.type === 'link' ? internalPageId(m.attrs?.['href']) : null;
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
    n.content?.forEach(walk);
  };
  walk(doc);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
