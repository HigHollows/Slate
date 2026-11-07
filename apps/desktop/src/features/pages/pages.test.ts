import { describe, expect, it, vi } from 'vitest';
import type { NodeRow } from '../../shared/ipc/client';
import {
  ancestors,
  buildTree,
  computeDrop,
  descendantIds,
  flattenVisible,
  zoneFromOffset,
} from './model';
import { createPagesStore, EXPANDED_KEY } from './store';
import { fakeBackend } from '../../test-utils';

const n = (
  id: string,
  parentId: string | null,
  position: string,
  kind: 'page' | 'folder' = 'page',
): NodeRow => ({
  id,
  workspaceId: 'w',
  parentId,
  kind,
  title: id,
  position,
  isFavorite: false,
  updatedAt: '',
  deletedAt: null,
});
const NODES = [
  n('a', null, '1'),
  n('b', null, '2', 'folder'),
  n('b1', 'b', '1'),
  n('b2', 'b', '2'),
  n('b11', 'b1', '1'),
  n('orphan', 'inconnu', '3'),
];

describe('arbre', () => {
  it('construit la forêt triée, un parent absent devient racine', () => {
    const t = buildTree(NODES);
    expect(t.map((i) => i.node.id)).toEqual(['a', 'b', 'orphan']);
    expect(t[1]!.children.map((i) => i.node.id)).toEqual(['b1', 'b2']);
    expect(t[1]!.children[0]!.depth).toBe(1);
  });
  it('aplatit uniquement les branches dépliées', () => {
    const t = buildTree(NODES);
    expect(flattenVisible(t, new Set()).map((i) => i.node.id)).toEqual(['a', 'b', 'orphan']);
    expect(flattenVisible(t, new Set(['b', 'b1'])).map((i) => i.node.id)).toEqual([
      'a',
      'b',
      'b1',
      'b11',
      'b2',
      'orphan',
    ]);
  });
  it('descendants et ancêtres', () => {
    expect([...descendantIds(NODES, 'b')].sort()).toEqual(['b1', 'b11', 'b2']);
    expect(ancestors(NODES, 'b11').map((x) => x.id)).toEqual(['b', 'b1']);
    expect(ancestors(NODES, 'a')).toEqual([]);
  });
  it('ne boucle pas sur des données cycliques corrompues', () => {
    const bad = [n('x', 'y', '1'), n('y', 'x', '1')];
    expect(ancestors(bad, 'x').length).toBeLessThan(3);
    expect(descendantIds(bad, 'x').size).toBeLessThan(3);
  });
});

describe('glisser-déposer', () => {
  it('zones : haut / milieu / bas', () => {
    expect(zoneFromOffset(1, 32)).toBe('before');
    expect(zoneFromOffset(16, 32)).toBe('inside');
    expect(zoneFromOffset(31, 32)).toBe('after');
  });
  it('destinations calculées', () => {
    expect(computeDrop(NODES, 'a', 'b', 'inside')).toEqual({ parentId: 'b', beforeId: null });
    expect(computeDrop(NODES, 'a', 'b2', 'before')).toEqual({ parentId: 'b', beforeId: 'b2' });
    expect(computeDrop(NODES, 'a', 'b1', 'after')).toEqual({ parentId: 'b', beforeId: 'b2' });
    expect(computeDrop(NODES, 'a', 'b2', 'after')).toEqual({ parentId: 'b', beforeId: null });
  });
  it('« après » ignore l’élément déplacé lui-même parmi les frères', () => {
    expect(computeDrop(NODES, 'b2', 'b1', 'after')).toEqual({ parentId: 'b', beforeId: null });
  });
  it('refuse soi-même, un descendant et une cible inconnue', () => {
    expect(computeDrop(NODES, 'b', 'b', 'inside')).toBeNull();
    expect(computeDrop(NODES, 'b', 'b11', 'inside')).toBeNull();
    expect(computeDrop(NODES, 'b', 'b1', 'before')).toBeNull();
    expect(computeDrop(NODES, 'a', 'inconnu', 'inside')).toBeNull();
  });
});

describe('store des pages', () => {
  const setup = (initial: Record<string, string> = {}) => {
    const api = fakeBackend(initial);
    const onError = vi.fn();
    return { api, onError, store: createPagesStore(api, onError) };
  };
  it('initialise : espace, arbre et dossiers dépliés restaurés', async () => {
    const { store } = setup({ [EXPANDED_KEY]: '["x","y"]' });
    await store.getState().init();
    expect(store.getState().status).toBe('ready');
    expect(store.getState().workspaceId).toBe('ws');
    expect(store.getState().expanded).toEqual(['x', 'y']);
  });
  it('ignore une liste de dossiers dépliés corrompue', async () => {
    const { store } = setup({ [EXPANDED_KEY]: '{pas json' });
    await store.getState().init();
    expect(store.getState().expanded).toEqual([]);
  });
  it('crée, renomme, déplace, met en favori', async () => {
    const { store } = setup();
    await store.getState().init();
    const f = await store
      .getState()
      .createNode({ parentId: null, kind: 'folder', title: 'Dossier' });
    const p = await store.getState().createNode({ parentId: null, kind: 'page', title: 'Page' });
    await store.getState().rename(p!.id, 'Renommée');
    await store.getState().move(p!.id, f!.id, null);
    await store.getState().toggleFavorite(p!.id);
    const node = store.getState().nodes.find((x) => x.id === p!.id)!;
    expect(node).toMatchObject({ title: 'Renommée', parentId: f!.id, isFavorite: true });
    expect(store.getState().expanded).toContain(f!.id);
  });
  it('corbeille : supprimer, restaurer, supprimer définitivement', async () => {
    const { store } = setup();
    await store.getState().init();
    const p = await store.getState().createNode({ parentId: null, kind: 'page', title: 'P' });
    expect(await store.getState().remove(p!.id)).toBe(1);
    expect(store.getState().nodes).toHaveLength(0);
    await store.getState().loadTrash();
    expect(store.getState().trash).toHaveLength(1);
    await store.getState().restore(p!.id);
    expect(store.getState().nodes).toHaveLength(1);
    await store.getState().remove(p!.id);
    expect(await store.getState().purge(p!.id)).toBe(true);
    expect(store.getState().trash).toHaveLength(0);
  });
  it('signale les erreurs sans lever d’exception et sans changer l’état', async () => {
    const { store, api, onError } = setup();
    await store.getState().init();
    api.state.failWrites = true;
    const row = await store.getState().createNode({ parentId: null, kind: 'page', title: 'X' });
    expect(row).toBeUndefined();
    expect(onError).toHaveBeenCalled();
    expect(store.getState().nodes).toHaveLength(0);
  });
  it('erreur d’initialisation : statut « error » signalé', async () => {
    const { store, api, onError } = setup();
    api.workspaceDefault.mockRejectedValueOnce(new Error('base absente'));
    await store.getState().init();
    expect(store.getState().status).toBe('error');
    expect(onError).toHaveBeenCalled();
  });
  it('espaces partagés : changement mémorisé, lecteur = modification impossible', async () => {
    const { store, api } = setup();
    const SH = '0192f0a0-0000-7000-8000-0000000000aa';
    api.extraWorkspaces.push({ id: SH, name: 'Équipe', kind: 'shared' });
    await store.getState().init();
    expect(store.getState().workspaces.map((w) => w.id)).toEqual(['ws', SH]);
    expect(store.getState().canEdit).toBe(true);
    api.syncStatus.mockResolvedValueOnce({
      enabled: true,
      deviceId: 'd',
      pending: 0,
      rejected: 0,
      workspaces: [
        {
          workspaceId: SH,
          name: 'Équipe',
          kind: 'shared',
          role: 'viewer',
          nodeCursor: 0,
          docCursor: 0,
          structCursor: 0,
          lastPushAt: null,
          lastPullAt: null,
          lastError: null,
        },
      ],
    });
    await store.getState().setWorkspace(SH);
    expect(store.getState().workspaceId).toBe(SH);
    expect(store.getState().canEdit).toBe(false);
    expect(api.settingsSet).toHaveBeenCalledWith('ui.workspace', JSON.stringify(SH));
    // un identifiant inconnu est ignoré
    await store.getState().setWorkspace('inconnu');
    expect(store.getState().workspaceId).toBe(SH);
  });
});
