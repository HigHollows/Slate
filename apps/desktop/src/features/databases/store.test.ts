import { describe, expect, it, vi } from 'vitest';
import { bus } from '../../shared/bus';
import { fakeBackend } from '../../test-utils';
import { createDatabasesStore } from './store';
import { parseViewConfig } from './types';

async function setup() {
  const api = fakeBackend();
  const onError = vi.fn();
  const store = createDatabasesStore(api, onError, 20);
  const d = await api.dbCreate({
    parentId: null,
    title: 'B',
    titlePropertyName: 'Nom',
    viewName: 'Tableau',
  });
  const n = await api.propCreate({
    databaseId: d.node.id,
    name: 'N',
    kind: 'number',
    config: {},
    beforeId: null,
    twoWayName: null,
  });
  const r1 = await api.rowCreate({ databaseId: d.node.id, title: 'L1', props: { [n.id]: 1 } });
  const r2 = await api.rowCreate({ databaseId: d.node.id, title: 'L2', props: { [n.id]: 2 } });
  await store.getState().load(d.node.id);
  return { api, onError, store, db: d.node.id, n, r1, r2, view: d.views[0]! };
}
const val = (s: Awaited<ReturnType<typeof setup>>, row: string, p: string) =>
  s.store.getState().dbs[s.db]?.rows.find((r) => r.id === row)?.props[p];

describe('store des bases', () => {
  it('charge schéma, vues et lignes', async () => {
    const s = await setup();
    const d = s.store.getState().dbs[s.db]!;
    expect(d.status).toBe('ready');
    expect(d.properties.map((p) => p.type)).toEqual(['title', 'number']);
    expect(d.rows).toHaveLength(2);
  });

  it('une ligne créée par le cœur pendant la modification (occurrence suivante) apparaît sans rechargement', async () => {
    const s = await setup();
    const real = s.api.cellsSet.getMockImplementation()!;
    s.api.cellsSet.mockImplementationOnce(async (changes) => {
      const out = await real(changes);
      const extra = await s.api.rowCreate({ databaseId: s.db, title: 'Suite', props: {} });
      return [...out, extra];
    });
    await s.store.getState().setCells(s.db, [{ rowId: s.r1.id, propertyId: s.n.id, value: 5 }]);
    const rows = s.store.getState().dbs[s.db]!.rows;
    expect(rows.map((r) => r.title)).toEqual(['L1', 'L2', 'Suite']);
    expect(new Set(rows.map((r) => r.id)).size).toBe(3);
  });

  it('modification optimiste immédiate, confirmée par le cœur', async () => {
    const s = await setup();
    const p = s.store
      .getState()
      .setCells(s.db, [{ rowId: s.r1.id, propertyId: s.n.id, value: 50 }]);
    expect(val(s, s.r1.id, s.n.id)).toBe(50); // visible avant la réponse
    expect(await p).toBe(true);
    expect(s.api.rowProps.get(s.r1.id)?.[s.n.id]).toBe(50);
  });

  it('échec : seule la cellule concernée est restaurée (une modification concurrente réussie est conservée)', async () => {
    const s = await setup();
    s.api.cellsSet.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 30));
      throw { code: 'io', messageKey: 'errors.io', retryable: true };
    });
    const failing = s.store
      .getState()
      .setCells(s.db, [{ rowId: s.r1.id, propertyId: s.n.id, value: 111 }]);
    const ok = s.store
      .getState()
      .setCells(s.db, [{ rowId: s.r2.id, propertyId: s.n.id, value: 222 }]);
    expect(await ok).toBe(true);
    expect(await failing).toBe(false);
    expect(val(s, s.r1.id, s.n.id)).toBe(1);
    expect(val(s, s.r2.id, s.n.id)).toBe(222);
    expect(s.onError).toHaveBeenCalledTimes(1);
  });

  it('échec : une cellule modifiée entre-temps par l’utilisateur n’est pas écrasée par l’annulation', async () => {
    const s = await setup();
    s.api.cellsSet.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 30));
      throw { code: 'io', messageKey: 'errors.io', retryable: true };
    });
    const failing = s.store
      .getState()
      .setCells(s.db, [{ rowId: s.r1.id, propertyId: s.n.id, value: 111 }]);
    await s.store.getState().setCells(s.db, [{ rowId: s.r1.id, propertyId: s.n.id, value: 333 }]);
    await failing;
    expect(val(s, s.r1.id, s.n.id)).toBe(333);
  });

  it('suppression d’une valeur (null) et ajout de ligne', async () => {
    const s = await setup();
    await s.store.getState().setCells(s.db, [{ rowId: s.r1.id, propertyId: s.n.id, value: null }]);
    expect(val(s, s.r1.id, s.n.id)).toBeUndefined();
    const row = await s.store.getState().createRow(s.db, { title: 'Nouvelle' });
    expect(row?.title).toBe('Nouvelle');
    expect(s.store.getState().dbs[s.db]?.rows).toHaveLength(3);
  });

  it('renommage : annulé si le cœur refuse, propagé aux autres stores via le bus sinon', async () => {
    const s = await setup();
    const seen = vi.fn();
    const off = bus.on('node-renamed', seen);
    expect(await s.store.getState().setTitle(s.db, s.r1.id, 'Neuf')).toBe(true);
    expect(seen).toHaveBeenCalledWith({ id: s.r1.id, title: 'Neuf' });
    s.api.state.failRename = true;
    expect(await s.store.getState().setTitle(s.db, s.r1.id, 'Refusé')).toBe(false);
    expect(s.store.getState().dbs[s.db]?.rows[0]?.title).toBe('Neuf');
    off();
  });

  it('un renommage venu d’ailleurs met la ligne à jour', async () => {
    const s = await setup();
    bus.emit('node-renamed', { id: s.r2.id, title: 'Depuis la page' });
    expect(s.store.getState().dbs[s.db]?.rows.find((r) => r.id === s.r2.id)?.title).toBe(
      'Depuis la page',
    );
  });

  it('configuration de vue : appliquée tout de suite, enregistrée une seule fois (regroupement), vidée à la demande', async () => {
    const s = await setup();
    const cfg = () => parseViewConfig(s.store.getState().dbs[s.db]?.views[0]?.config);
    s.store.getState().patchViewConfig(s.db, s.view.id, { hidden: ['a'] });
    s.store.getState().patchViewConfig(s.db, s.view.id, { hidden: ['a', 'b'] });
    expect(cfg().hidden).toEqual(['a', 'b']);
    expect(s.store.getState().hasPendingViews()).toBe(true);
    expect(s.api.viewUpdate).not.toHaveBeenCalled();
    await s.store.getState().flushViews();
    expect(s.api.viewUpdate).toHaveBeenCalledTimes(1);
    expect(s.store.getState().hasPendingViews()).toBe(false);
    expect(s.api.dbViews.get(s.db)![0]!.config['hidden']).toEqual(['a', 'b']);
  });

  it('échec d’enregistrement d’une vue : signalé, la modification locale est conservée', async () => {
    const s = await setup();
    s.api.state.failWrites = true;
    s.store.getState().patchViewConfig(s.db, s.view.id, { wrap: true });
    await s.store.getState().flushViews();
    expect(s.onError).toHaveBeenCalled();
    expect(parseViewConfig(s.store.getState().dbs[s.db]?.views[0]?.config).wrap).toBe(true);
  });

  it('supprimer puis restaurer des lignes recharge la base', async () => {
    const s = await setup();
    expect(await s.store.getState().deleteRows(s.db, [s.r1.id])).toBe(true);
    expect(s.store.getState().dbs[s.db]?.rows).toHaveLength(1);
    await s.api.nodeRestore(s.r1.id);
    await s.store.getState().restoreRows(s.db, [s.r1.id]);
    expect(s.store.getState().dbs[s.db]?.rows).toHaveLength(2);
  });

  it('erreur de chargement : état « error » et signalement', async () => {
    const s = await setup();
    s.api.dbGet.mockRejectedValueOnce(new Error('illisible'));
    await s.store.getState().load('autre');
    expect(s.store.getState().dbs['autre']?.status).toBe('error');
    expect(s.onError).toHaveBeenCalled();
  });
});
