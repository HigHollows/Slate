import type { Ipc } from '../../shared/ipc/client';
import { SlateError } from '../../shared/ipc/errors';
import { fromBase64, toBase64 } from './content';

export type MediaApi = Pick<Ipc, 'mediaPut' | 'mediaGet'>;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TYPES = /^image\/(png|jpeg|gif|webp)$/;

/** Service d'images de l'éditeur : envoi vers le stockage local, affichage par URL blob mise en cache. */
export function createMedia(api: MediaApi, onError: (e: unknown) => void) {
  const urls = new Map<string, Promise<string>>();
  return {
    async upload(file: File): Promise<string | undefined> {
      try {
        if (!TYPES.test(file.type))
          throw new SlateError('image.type', 'editor.image.errorType', false);
        if (file.size > MAX_IMAGE_BYTES)
          throw new SlateError('image.size', 'editor.image.errorSize', false);
        const info = await api.mediaPut(toBase64(new Uint8Array(await file.arrayBuffer())));
        return info.hash;
      } catch (e) {
        onError(e);
        return undefined;
      }
    },
    load(hash: string): Promise<string> {
      let p = urls.get(hash);
      if (!p) {
        p = api
          .mediaGet(hash)
          .then((d) =>
            URL.createObjectURL(new Blob([fromBase64(d.data) as BlobPart], { type: d.mime })),
          );
        p.catch(() => urls.delete(hash)); // un échec ne reste pas en cache
        urls.set(hash, p);
      }
      return p;
    },
  };
}
