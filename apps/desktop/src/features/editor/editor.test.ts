import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { extractLinkTargets, fromBase64, toBase64 } from './content';
import {
  SaveManager,
  flushAll,
  hasUnsavedChanges,
  registerManager,
} from '../../shared/save-manager';
import { filterSlash, SLASH_ITEMS } from './slashItems';

describe('contenu', () => {
  it('extrait les mentions de pages, dédoublonnées, y compris imbriquées', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'pageMention', attrs: { id: 'a' } },
            { type: 'text' },
            { type: 'pageMention', attrs: { id: 'a' } },
          ],
        },
        {
          type: 'callout',
          content: [{ type: 'paragraph', content: [{ type: 'pageMention', attrs: { id: 'b' } }] }],
        },
        { type: 'pageMention', attrs: { id: '' } },
        { type: 'pageMention', attrs: { id: 42 } },
      ],
    };
    expect(extractLinkTargets(doc)).toEqual(['a', 'b']);
  });
  it('base64 : aller-retour sans perte, y compris gros volumes et octets > 127', () => {
    const bytes = new Uint8Array(200_000).map((_, i) => (i * 31) % 256);
    expect(fromBase64(toBase64(bytes))).toEqual(bytes);
  });
});

describe('menu /', () => {
  const title = (id: string) =>
    ({ h1: 'Titre 1', bullet: 'Liste à puces', table: 'Tableau', callout: 'Encadré' })[id] ?? id;
  it('sans requête : tous les blocs, dans l’ordre', () => {
    expect(filterSlash('', title)).toHaveLength(SLASH_ITEMS.length);
  });
  it('filtre par titre traduit ou mot-clé, sans accents ni casse', () => {
    expect(filterSlash('ENCADRE', title).map((i) => i.id)).toEqual([
      'callout',
      'callout_info',
      'callout_warning',
      'callout_important',
      'callout_tip',
      'callout_definition',
      'callout_summary',
    ]);
    expect(filterSlash('tableau', title).map((i) => i.id)).toEqual(['table']);
    expect(filterSlash('todo', title).map((i) => i.id)).toEqual(['task']);
    expect(filterSlash('zzzz', title)).toEqual([]);
  });
  it('chaque bloc a une icône Papicons OU un repère typographique (jamais d’emoji)', () => {
    for (const it of SLASH_ITEMS) {
      expect(Boolean(it.icon) !== Boolean(it.glyph), it.id).toBe(true);
      if (it.glyph) expect(it.glyph).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

describe('SaveManager', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(save: (p: string) => Promise<void>) {
    let content = 'v0';
    const statuses: string[] = [];
    const m = new SaveManager<string>({
      getPayload: () => content,
      save,
      debounceMs: 100,
      retryDelaysMs: [1000, 2000],
      onStatus: (s) => statuses.push(s),
    });
    return { m, statuses, set: (v: string) => ((content = v), m.markDirty()) };
  }

  it('regroupe les modifications rapprochées et enregistre la dernière version', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const { m, set } = setup(save);
    set('a');
    set('ab');
    set('abc');
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith('abc');
    expect(m.status).toBe('saved');
  });

  it('une modification pendant un enregistrement déclenche un second enregistrement', async () => {
    let release!: () => void;
    const save = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockResolvedValue(undefined);
    const { m, set } = setup(save);
    set('un');
    await vi.advanceTimersByTimeAsync(100);
    expect(m.status).toBe('saving');
    set('deux');
    release();
    await vi.advanceTimersByTimeAsync(300);
    expect(save).toHaveBeenLastCalledWith('deux');
    expect(m.status).toBe('saved');
  });

  it('échec : l’état reste « à enregistrer », l’erreur est exposée, nouvelle tentative avec attente croissante', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('disque plein'))
      .mockRejectedValueOnce(new Error('encore'))
      .mockResolvedValue(undefined);
    const { m, set } = setup(save);
    set('précieux');
    await vi.advanceTimersByTimeAsync(100);
    expect(m.status).toBe('error');
    expect((m.lastError as Error).message).toBe('disque plein');
    expect(m.hasPending()).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(save).toHaveBeenCalledTimes(3);
    expect(save).toHaveBeenLastCalledWith('précieux');
    expect(m.status).toBe('saved');
    expect(m.hasPending()).toBe(false);
  });

  it('flush : attend la fin, et REJETTE si l’écriture échoue (rien n’est déclaré enregistré à tort)', async () => {
    const save = vi.fn().mockRejectedValue(new Error('panne'));
    const { m, set } = setup(save);
    set('x');
    await expect(m.flush()).rejects.toThrow('panne');
    expect(m.hasPending()).toBe(true);
    save.mockResolvedValue(undefined);
    await m.retryNow();
    expect(m.hasPending()).toBe(false);
  });

  it('release : continue d’essayer en arrière-plan puis se libère une fois tout écrit', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined);
    const released = vi.fn();
    const m = new SaveManager<string>({
      getPayload: () => 'données',
      save,
      debounceMs: 50,
      retryDelaysMs: [500],
      onReleased: released,
    });
    m.markDirty();
    m.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(released).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenLastCalledWith('données');
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('release sans modification : libération immédiate', () => {
    const released = vi.fn();
    const m = new SaveManager<string>({
      getPayload: () => '',
      save: async () => undefined,
      onReleased: released,
    });
    m.release();
    expect(released).toHaveBeenCalledTimes(1);
  });

  it('source figée : la dernière version reste enregistrable après la destruction de l’éditeur', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    let alive = true;
    const m = new SaveManager<string>({
      getPayload: () => {
        if (!alive) throw new Error('éditeur détruit');
        return 'live';
      },
      save,
      debounceMs: 50,
    });
    m.markDirty();
    const snapshot = 'figé';
    m.setSource(() => snapshot);
    alive = false;
    await m.flush();
    expect(save).toHaveBeenCalledWith('figé');
  });

  it('registre global : flushAll écrit tout et signale un échec', async () => {
    const ok = new SaveManager<string>({ getPayload: () => 'a', save: async () => undefined });
    const ko = new SaveManager<string>({
      getPayload: () => 'b',
      save: async () => Promise.reject(new Error('non')),
    });
    const un1 = registerManager(ok);
    const un2 = registerManager(ko);
    ok.markDirty();
    ko.markDirty();
    expect(hasUnsavedChanges()).toBe(true);
    await expect(flushAll()).rejects.toThrow('non');
    expect(ok.hasPending()).toBe(false);
    expect(hasUnsavedChanges()).toBe(true);
    un2();
    ko.dispose();
    expect(hasUnsavedChanges()).toBe(false);
    un1();
  });
});
