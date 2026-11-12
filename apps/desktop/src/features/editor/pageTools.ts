import * as Y from 'yjs';
import type { NodeRow } from '../../shared/ipc/client';
import { extractLinkTargets, fromBase64, toBase64 } from './content';
import { liveDocs } from './liveDocs';
import { snapshotFromDoc } from './derive';
import type { EditorApi } from './PageEditor';

type PagesApi = {
  getState(): {
    nodes: NodeRow[];
    createNode(a: {
      parentId: string | null;
      kind: 'folder' | 'page';
      title?: string;
    }): Promise<NodeRow | undefined>;
  };
};

/** État de la page : celui de l'éditeur ouvert (y compris les dernières frappes pas encore enregistrées), sinon l'état enregistré. */
async function stateOf(
  api: Pick<EditorApi, 'pageGet'>,
  id: string,
): Promise<{ docState: string | null }> {
  const live = liveDocs.get(id);
  if (live) return { docState: toBase64(Y.encodeStateAsUpdate(live)) };
  return api.pageGet(id);
}

/**
 * Duplique une page : même emplacement, contenu identique, titre « … (copie) ». Le contenu copié est l'état Yjs enregistré ;
 * la copie est une page indépendante (les commentaires et l'historique ne sont pas copiés).
 */
export async function duplicatePage(
  api: Pick<EditorApi, 'pageGet' | 'pageSave'>,
  pages: PagesApi,
  id: string,
  copyLabel: string,
): Promise<NodeRow | undefined> {
  const src = pages.getState().nodes.find((n) => n.id === id);
  if (!src || src.kind !== 'page') return undefined;
  const data = await stateOf(api, id);
  const row = await pages.getState().createNode({
    parentId: src.parentId,
    kind: 'page',
    title: `${src.title} ${copyLabel}`.trim().slice(0, 500),
  });
  if (!row) return undefined;
  if (data.docState) {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, fromBase64(data.docState));
    const snap = snapshotFromDoc(doc);
    await api.pageSave({
      id: row.id,
      docState: data.docState,
      contentJson: snap.contentJson,
      textPlain: snap.textPlain,
      linkTargets: extractLinkTargets(JSON.parse(snap.contentJson)),
    });
  }
  return row;
}

/** Contenu d'une page en Markdown, à partir de son état enregistré. */
export async function pageMarkdown(
  api: Pick<EditorApi, 'pageGet'>,
  id: string,
  title: string,
): Promise<string> {
  const { pageToMarkdown } = await import('./markdown');
  const data = await stateOf(api, id);
  if (!data.docState) return pageToMarkdown('{"type":"doc","content":[]}', title);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fromBase64(data.docState));
  return pageToMarkdown(snapshotFromDoc(doc).contentJson, title);
}
