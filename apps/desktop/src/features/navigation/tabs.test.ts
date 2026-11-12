import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_TABS, snapshotTabs, useNav } from './store';
import { TABS_KEY, useTabsPersistence } from './persist';
import { renderHook } from '@testing-library/react';

const s = () => useNav.getState();
const page = (id: string) => ({ name: 'page', id }) as const;
const open = (...ids: string[]) => ids.forEach((id) => s().openTab(page(id)));
const routes = () => s().tabs.map((t) => t.stack[t.index]);

beforeEach(() => s().reset());

describe('onglets : modèle', () => {
  it('démarre avec un seul onglet « accueil »', () => {
    expect(s().tabs).toHaveLength(1);
    expect(s().route).toEqual({ name: 'home' });
  });

  it('naviguer remplace la page DE L’ONGLET ACTIF seulement, avec son propre historique', () => {
    s().navigate(page('a'));
    s().openTab(page('b'));
    expect(s().tabs).toHaveLength(2);
    expect(s().route).toEqual(page('b'));
    s().navigate(page('c')); // remplace b dans l'onglet 2
    expect(routes()).toEqual([page('a'), page('c')]);
    s().back();
    expect(s().route).toEqual(page('b'));
    s().activateTab(s().tabs[0]!.id);
    expect(s().route).toEqual(page('a'));
    expect(s().canForward).toBe(false); // l'avenir de l'autre onglet n'est pas le sien
    s().back();
    expect(s().route).toEqual({ name: 'home' });
  });

  it('ouvrir une page déjà ouverte active son onglet au lieu d’en créer un second', () => {
    open('a', 'b');
    const first = s().tabs[1]!.id;
    s().openTab(page('b'));
    expect(s().tabs).toHaveLength(3);
    s().activateTab(s().tabs[0]!.id);
    s().openTab(page('a'));
    expect(s().activeId).toBe(s().tabs[1]!.id);
    expect(s().tabs.map((t) => t.id)).toContain(first);
    // l'accueil, lui, peut exister plusieurs fois (onglet vide)
    s().openTab();
    s().openTab();
    expect(s().tabs.filter((t) => t.stack[t.index]!.name === 'home').length).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('ouverture en arrière-plan : l’onglet s’ajoute à droite sans changer l’actif', () => {
    open('a');
    const active = s().activeId;
    s().openTab(page('b'), { background: true });
    expect(s().activeId).toBe(active);
    expect(routes()).toEqual([{ name: 'home' }, page('a'), page('b')]);
  });

  it('un nouvel onglet s’insère à droite de l’onglet actif', () => {
    open('a', 'b');
    s().activateTab(s().tabs[0]!.id);
    s().openTab(page('c'));
    expect(routes()).toEqual([{ name: 'home' }, page('c'), page('a'), page('b')]);
  });

  it('fermer : l’actif passe au voisin de droite (sinon de gauche) ; le dernier onglet revient à l’accueil', () => {
    open('a', 'b', 'c');
    const [h, a, b, c] = s().tabs;
    s().activateTab(b!.id);
    s().closeTab(b!.id);
    expect(s().activeId).toBe(c!.id);
    s().closeTab(c!.id);
    expect(s().activeId).toBe(a!.id);
    s().closeTab(h!.id);
    s().closeTab(a!.id);
    expect(s().tabs).toHaveLength(1);
    expect(s().route).toEqual({ name: 'home' });
    s().closeTab('inconnu'); // sans effet
    expect(s().tabs).toHaveLength(1);
  });

  it('fermer un onglet inactif ne change pas l’onglet actif', () => {
    open('a', 'b');
    const active = s().activeId;
    s().closeTab(s().tabs[0]!.id);
    expect(s().activeId).toBe(active);
  });

  it('fermer les autres / à droite', () => {
    open('a', 'b', 'c');
    const [h, a, b] = s().tabs;
    s().closeToRight(a!.id);
    expect(routes()).toEqual([{ name: 'home' }, page('a')]);
    expect(s().activeId).toBe(a!.id); // l'actif (c) a disparu : on tombe sur l'onglet de référence
    s().openTab(page('x'));
    s().closeOthers(a!.id);
    expect(s().tabs.map((t) => t.id)).toEqual([a!.id]);
    expect(h && b).toBeTruthy();
  });

  it('rouvrir le dernier onglet fermé (pile, sans doublon ni accueil)', () => {
    open('a', 'b');
    s().closeTab(s().tabs[2]!.id);
    s().closeTab(s().tabs[1]!.id);
    s().openTab(); // un accueil fermé n'est jamais mémorisé
    s().closeTab(s().activeId);
    s().reopenClosed();
    expect(s().route).toEqual(page('a'));
    s().reopenClosed();
    expect(s().route).toEqual(page('b'));
    const n = s().tabs.length;
    s().reopenClosed(); // plus rien à rouvrir
    expect(s().tabs).toHaveLength(n);
  });

  it('réordonner et parcourir (circulaire)', () => {
    open('a', 'b');
    const [h, a, b] = s().tabs;
    s().moveTab(b!.id, 0);
    expect(s().tabs.map((t) => t.id)).toEqual([b!.id, h!.id, a!.id]);
    s().moveTab(b!.id, 99);
    expect(s().tabs.map((t) => t.id)).toEqual([h!.id, a!.id, b!.id]);
    s().activateTab(b!.id);
    s().cycleTab(1);
    expect(s().activeId).toBe(h!.id);
    s().cycleTab(-1);
    expect(s().activeId).toBe(b!.id);
  });

  it(`plafond de ${MAX_TABS} onglets : au-delà, la page remplace celle de l’onglet actif`, () => {
    for (let i = 0; i < MAX_TABS + 5; i++) s().openTab(page(`p${i}`));
    expect(s().tabs).toHaveLength(MAX_TABS);
    expect(s().route).toEqual(page(`p${MAX_TABS + 4}`));
  });
});

describe('onglets : enregistrement', () => {
  it('instantané : une route par onglet, sans historique', () => {
    open('a', 'b');
    s().navigate({ name: 'settings', tab: 'about' });
    s().activateTab(s().tabs[1]!.id);
    expect(snapshotTabs(s())).toEqual({
      tabs: [{ name: 'home' }, page('a'), { name: 'settings', tab: 'about' }],
      active: 1,
    });
  });

  it('restauration : valide, déduplique, borne, ignore tout ce qui est invalide', () => {
    s().hydrate({
      tabs: [
        page('a'),
        page('a'),
        { name: 'database', id: 'd1' },
        { name: 'settings', tab: 'nimporte' },
        { name: 'page', id: '../../x' },
        { name: 'rien' },
        42,
        null,
        { name: 'trash' },
      ],
      active: 2,
    });
    expect(routes()).toEqual([page('a'), { name: 'database', id: 'd1' }, { name: 'trash' }]);
    expect(s().route).toEqual({ name: 'trash' });
    // contenu inutilisable : l'état courant est conservé
    for (const bad of [null, 'x', {}, { tabs: 'x' }, { tabs: [] }, { tabs: [{ name: 'zzz' }] }]) {
      const before = s().tabs;
      s().hydrate(bad);
      expect(s().tabs).toBe(before);
    }
    s().hydrate({ tabs: [page('z')], active: 99 });
    expect(s().route).toEqual(page('z'));
  });

  it('persistance : relit au démarrage puis enregistre (différé) chaque changement', async () => {
    vi.useFakeTimers();
    const rows = [
      { key: TABS_KEY, valueJson: JSON.stringify({ tabs: [page('a'), page('b')], active: 1 }) },
    ];
    const api = {
      settingsGetAll: vi.fn(async () => rows),
      settingsSet: vi.fn(async () => undefined),
    };
    const { unmount } = renderHook(() => useTabsPersistence(api, undefined, 200));
    await vi.advanceTimersByTimeAsync(0);
    expect(routes()).toEqual([page('a'), page('b')]);
    expect(api.settingsSet).not.toHaveBeenCalled(); // la restauration elle-même n'écrit rien
    s().openTab(page('c'));
    s().navigate(page('d'));
    expect(api.settingsSet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(api.settingsSet).toHaveBeenCalledTimes(1); // regroupé
    const saved = JSON.parse((api.settingsSet.mock.calls[0] as unknown as [string, string])[1]) as {
      tabs: unknown[];
      active: number;
    };
    expect(saved.tabs).toEqual([page('a'), page('b'), page('d')]);
    // dernier changement non enregistré : sauvé à la fermeture
    s().closeTab(s().activeId);
    unmount();
    expect(api.settingsSet).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('valeur enregistrée illisible : un onglet « accueil », aucune exception', async () => {
    const api = {
      settingsGetAll: vi.fn(async () => [{ key: TABS_KEY, valueJson: '{pas du json' }]),
      settingsSet: vi.fn(async () => undefined),
    };
    renderHook(() => useTabsPersistence(api));
    await new Promise((r) => setTimeout(r, 10));
    expect(s().tabs).toHaveLength(1);
    expect(s().route).toEqual({ name: 'home' });
  });
});
