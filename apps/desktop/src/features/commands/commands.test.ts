import { describe, expect, it, vi } from 'vitest';
import {
  eventToCombo,
  findConflict,
  fuzzyScore,
  isBindable,
  resolveBindings,
  searchCommands,
  type Command,
} from './model';
import { createCommandsStore, HISTORY_KEY } from './store';

const ev = (o: Partial<KeyboardEvent>) => ({
  key: '',
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...o,
});

describe('eventToCombo', () => {
  it('utilise ⌘ comme Mod sur macOS et Ctrl ailleurs', () => {
    expect(eventToCombo(ev({ key: 'k', code: 'KeyK', metaKey: true }), true)).toBe('Mod+k');
    expect(eventToCombo(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), false)).toBe('Mod+k');
    expect(eventToCombo(ev({ key: 'k', code: 'KeyK', ctrlKey: true }), true)).toBe('Ctrl+k');
  });
  it('ignore les modificateurs seuls et la touche Windows', () => {
    expect(eventToCombo(ev({ key: 'Shift', shiftKey: true }), true)).toBeNull();
    expect(eventToCombo(ev({ key: 'k', code: 'KeyK', metaKey: true }), false)).toBeNull();
  });
  it('est stable avec Alt sur macOS (utilise code, pas le caractère produit)', () => {
    expect(eventToCombo(ev({ key: 'å', code: 'KeyA', altKey: true }), true)).toBe('Alt+a');
  });
  it('ordonne les modificateurs et gère les symboles', () => {
    expect(
      eventToCombo(ev({ key: '\\', code: 'Backslash', ctrlKey: true, shiftKey: true }), false),
    ).toBe('Mod+Shift+\\');
    expect(eventToCombo(ev({ key: ',', code: 'Comma', metaKey: true }), true)).toBe('Mod+,');
  });
});

describe('liaisons', () => {
  it('exige un modificateur', () => {
    expect(isBindable('k')).toBe(false);
    expect(isBindable('Shift+k')).toBe(false);
    expect(isBindable('Mod+k')).toBe(true);
    expect(isBindable('Alt+Shift+x')).toBe(true);
  });
  const cmds = [
    { id: 'a', defaultShortcut: 'Mod+1' },
    { id: 'b', defaultShortcut: 'Mod+2' },
    { id: 'c' },
  ];
  it('applique les surcharges, y compris le retrait (null)', () => {
    const b = resolveBindings(cmds, { a: 'Mod+9', b: null });
    expect(b.get('a')).toBe('Mod+9');
    expect(b.get('b')).toBeNull();
    expect(b.get('c')).toBeNull();
  });
  it('détecte conflits entre commandes et combinaisons réservées', () => {
    const b = resolveBindings(cmds, {});
    expect(findConflict(b, 'c', 'Mod+1')).toEqual({ kind: 'command', id: 'a' });
    expect(findConflict(b, 'a', 'Mod+1')).toBeNull();
    expect(findConflict(b, 'c', 'Mod+c')).toEqual({ kind: 'reserved' });
    expect(findConflict(b, 'c', 'Mod+7')).toBeNull();
  });
});

describe('recherche', () => {
  const mk = (id: string, title: string, keywords: string[] = []): Command => ({
    id,
    title,
    group: 'view',
    icon: 'home',
    keywords,
    run: () => {},
  });
  const list = [
    mk('t', 'Thème sombre', ['dark']),
    mk('s', 'Ouvrir les paramètres', ['settings']),
    mk('l', 'Langue : English'),
  ];
  it('ignore la casse et les accents', () => {
    expect(fuzzyScore('theme', 'Thème sombre')).toBeGreaterThan(0);
    expect(fuzzyScore('PARAMETRES', 'Ouvrir les paramètres')).toBeGreaterThan(0);
    expect(fuzzyScore('zzz', 'Thème sombre')).toBe(-1);
  });
  it('trouve par mots-clés et par sous-séquence, meilleur résultat en premier', () => {
    expect(searchCommands(list, 'dark').map((c) => c.id)).toEqual(['t']);
    expect(searchCommands(list, 'ouvpar').map((c) => c.id)).toEqual(['s']);
    expect(searchCommands(list, 'th')[0]?.id).toBe('t');
    expect(searchCommands(list, '')).toHaveLength(3);
    expect(searchCommands(list, 'introuvable')).toHaveLength(0);
  });
});

describe('store des commandes', () => {
  const api = () => ({
    settingsSet: vi.fn().mockResolvedValue(undefined),
    settingsDelete: vi.fn().mockResolvedValue(undefined),
  });
  it('hydrate les surcharges et l’historique, ignore les valeurs invalides', () => {
    const s = createCommandsStore(api());
    s.getState().hydrate([
      { key: 'shortcut.nav.home', valueJson: '"Mod+h"' },
      { key: 'shortcut.nav.back', valueJson: 'null' },
      { key: 'shortcut.bad', valueJson: '42' },
      { key: HISTORY_KEY, valueJson: '["a","b"]' },
    ]);
    expect(s.getState().overrides).toEqual({ 'nav.home': 'Mod+h', 'nav.back': null });
    expect(s.getState().history).toEqual(['a', 'b']);
  });
  it('limite et dédoublonne l’historique', async () => {
    const a = api();
    const s = createCommandsStore(a);
    for (let i = 0; i < 12; i++) await s.getState().recordRun(`c${i}`);
    await s.getState().recordRun('c5');
    expect(s.getState().history).toHaveLength(8);
    expect(s.getState().history[0]).toBe('c5');
    expect(new Set(s.getState().history).size).toBe(8);
  });
  it('annule la surcharge locale si la persistance échoue', async () => {
    const onError = vi.fn();
    const s = createCommandsStore(
      { ...api(), settingsSet: vi.fn().mockRejectedValue(new Error('x')) },
      onError,
    );
    await expect(s.getState().setShortcut('nav.home', 'Mod+h')).rejects.toThrow();
    expect(s.getState().overrides).toEqual({});
    expect(onError).toHaveBeenCalled();
  });
});
