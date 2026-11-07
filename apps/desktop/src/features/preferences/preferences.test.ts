import { describe, expect, it, vi } from 'vitest';
import { accentForeground, applyPreferences, contrastRatio, resolveTheme } from './apply';
import {
  DEFAULT_PREFERENCES,
  ACCENT_PRESETS,
  parsePreferences,
  storageKey,
  validatePatch,
} from './model';
import { createPreferencesStore, type SettingsApi } from './store';

describe('modèle', () => {
  it('mappe les clés vers le format accepté par le cœur Rust', () => {
    expect(storageKey('fontScale')).toBe('pref.font-scale');
    expect(storageKey('sidebarCollapsed')).toBe('pref.sidebar-collapsed');
    for (const k of Object.keys(DEFAULT_PREFERENCES) as (keyof typeof DEFAULT_PREFERENCES)[]) {
      expect(storageKey(k)).toMatch(/^pref\.[a-z0-9.-]+$/);
    }
  });
  it('retombe sur le défaut pour une valeur corrompue sans perdre les valeurs valides', () => {
    const { prefs, invalidKeys } = parsePreferences([
      { key: 'pref.theme', valueJson: '"dark"' },
      { key: 'pref.accent', valueJson: '"rouge"' },
      { key: 'pref.sidebar-width', valueJson: '9999' },
      { key: 'pref.density', valueJson: '{pas du json' },
    ]);
    expect(prefs.theme).toBe('dark');
    expect(prefs.accent).toBe(DEFAULT_PREFERENCES.accent);
    expect(prefs.sidebarWidth).toBe(DEFAULT_PREFERENCES.sidebarWidth);
    expect(invalidKeys.sort()).toEqual(['pref.accent', 'pref.density', 'pref.sidebar-width']);
  });
  it('refuse un patch invalide avant toute écriture', () => {
    expect(() => validatePatch({ accent: 'javascript:alert(1)' })).toThrow();
    expect(() => validatePatch({ fontScale: 5 })).toThrow();
  });
});

describe('application au document', () => {
  it('choisit un texte d’accent lisible (≥ 4,5:1, AA) pour chaque couleur proposée', () => {
    for (const a of ACCENT_PRESETS.filter((x) => x.hex !== 'auto')) {
      const fg = accentForeground(a.hex);
      expect(contrastRatio(a.hex, fg), a.id).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('l’accent « auto » (encre) suit le thème et ne fige aucune couleur', () => {
    const root = document.createElement('html');
    applyPreferences({ ...DEFAULT_PREFERENCES, accent: '#4a4a46' }, false, root);
    expect(root.style.getPropertyValue('--accent')).toBe('#4a4a46');
    applyPreferences({ ...DEFAULT_PREFERENCES }, false, root);
    expect(DEFAULT_PREFERENCES.accent).toBe('auto');
    expect(root.style.getPropertyValue('--accent')).toBe('');
    expect(root.style.getPropertyValue('--accent-fg')).toBe('');
  });
  it('seuls des neutres sont proposés comme accent (identité monochrome)', () => {
    for (const a of ACCENT_PRESETS) {
      if (a.hex === 'auto') continue;
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(a.hex.slice(i, i + 2), 16)) as [
        number,
        number,
        number,
      ];
      expect(Math.max(r, g, b) - Math.min(r, g, b), a.id).toBeLessThanOrEqual(8);
    }
  });
  it('résout le thème système', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
  });
  it('écrit thème, accent, densité, police et échelle sur la racine', () => {
    const root = document.createElement('html');
    applyPreferences(
      {
        ...DEFAULT_PREFERENCES,
        theme: 'dark',
        density: 'compact',
        fontScale: 1.2,
        accent: '#ffff00',
      },
      false,
      root,
    );
    expect(root.dataset['theme']).toBe('dark');
    expect(root.dataset['density']).toBe('compact');
    expect(root.style.fontSize).toBe('19.2px');
    expect(root.style.getPropertyValue('--accent')).toBe('#ffff00');
    expect(root.style.getPropertyValue('--accent-fg')).toBe('#0a0a0a');
  });
});

function api(over: Partial<SettingsApi> = {}): SettingsApi {
  return {
    settingsGetAll: vi.fn().mockResolvedValue([]),
    settingsSet: vi.fn().mockResolvedValue(undefined),
    settingsDelete: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('store', () => {
  it('hydrate depuis le stockage', async () => {
    const s = createPreferencesStore(
      api({
        settingsGetAll: vi.fn().mockResolvedValue([{ key: 'pref.theme', valueJson: '"dark"' }]),
      }),
    );
    await s.getState().hydrate();
    expect(s.getState().prefs.theme).toBe('dark');
    expect(s.getState().loaded).toBe(true);
  });
  it('met à jour de façon optimiste puis persiste', async () => {
    const a = api();
    const s = createPreferencesStore(a);
    const p = s.getState().update({ theme: 'light' });
    expect(s.getState().prefs.theme).toBe('light');
    await p;
    expect(a.settingsSet).toHaveBeenCalledWith('pref.theme', '"light"');
  });
  it('restaure l’état et signale l’erreur si l’écriture échoue (rien ne disparaît en silence)', async () => {
    const onError = vi.fn();
    const s = createPreferencesStore(
      api({ settingsSet: vi.fn().mockRejectedValue(new Error('disque plein')) }),
      onError,
    );
    await expect(s.getState().update({ theme: 'dark' })).rejects.toThrow('disque plein');
    expect(s.getState().prefs.theme).toBe('system');
    expect(onError).toHaveBeenCalledTimes(1);
  });
  it('signale un échec de chargement et reste utilisable avec les défauts', async () => {
    const onError = vi.fn();
    const s = createPreferencesStore(
      api({ settingsGetAll: vi.fn().mockRejectedValue(new Error('x')) }),
      onError,
    );
    await s.getState().hydrate();
    expect(onError).toHaveBeenCalled();
    expect(s.getState().prefs).toEqual(DEFAULT_PREFERENCES);
  });
  it('réinitialise en supprimant les clés stockées', async () => {
    const a = api();
    const s = createPreferencesStore(a);
    await s.getState().update({ density: 'compact' });
    await s.getState().reset(['density']);
    expect(s.getState().prefs.density).toBe('comfortable');
    expect(a.settingsDelete).toHaveBeenCalledWith('pref.density');
  });
});

describe('largeur de lecture', () => {
  it('valeur par défaut, relecture valide, valeur invalide retombe sur le défaut', async () => {
    const { parsePreferences, validatePatch, DEFAULT_PREFERENCES } = await import('./model');
    expect(DEFAULT_PREFERENCES.readingWidth).toBe('normal');
    expect(
      parsePreferences([{ key: 'pref.reading-width', valueJson: '"wide"' }]).prefs.readingWidth,
    ).toBe('wide');
    const bad = parsePreferences([{ key: 'pref.reading-width', valueJson: '"gigantesque"' }]);
    expect(bad.prefs.readingWidth).toBe('normal');
    expect(bad.invalidKeys).toEqual(['pref.reading-width']);
    expect(() => validatePatch({ readingWidth: 'x' as never })).toThrow();
  });
});

describe('tâches terminées barrées', () => {
  it('préférence validée, appliquée à la racine, relue', async () => {
    const { parsePreferences, validatePatch, DEFAULT_PREFERENCES } = await import('./model');
    expect(DEFAULT_PREFERENCES.taskStrike).toBe(true);
    expect(
      parsePreferences([{ key: 'pref.task-strike', valueJson: 'false' }]).prefs.taskStrike,
    ).toBe(false);
    expect(
      parsePreferences([{ key: 'pref.task-strike', valueJson: '"oui"' }]).prefs.taskStrike,
    ).toBe(true);
    expect(() => validatePatch({ taskStrike: 'x' as never })).toThrow();
    const root = document.createElement('div');
    applyPreferences({ ...DEFAULT_PREFERENCES, taskStrike: false }, false, root);
    expect(root.dataset['taskStrike']).toBe('false');
    applyPreferences(DEFAULT_PREFERENCES, false, root);
    expect(root.dataset['taskStrike']).toBe('true');
  });
});
