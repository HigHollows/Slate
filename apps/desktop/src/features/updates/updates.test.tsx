import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../test-setup';
import { initI18n } from '../../shared/i18n';
import type { UpdaterBackend } from '../../shared/updater';
import { UpdatesProvider, useAutoUpdateCheck } from './context';
import { createUpdatesStore } from './store';
import { UpdatesSection } from './UpdatesSection';

const INFO = { version: '0.2.0', notes: 'Nouveautés\n- mieux', date: '2026-12-01T00:00:00Z' };
const settings = (rows: { key: string; valueJson: string }[] = []) => ({
  settingsGetAll: vi.fn(async () => rows),
  settingsSet: vi.fn(async () => undefined),
});
const backend = (over: Partial<UpdaterBackend> = {}): UpdaterBackend => ({
  currentVersion: vi.fn(async () => '0.1.3'),
  check: vi.fn(async () => null),
  install: vi.fn(async () => undefined),
  ...over,
});

describe('mises à jour : logique', () => {
  it('sans module (navigateur, tests) : indisponible, aucun appel', async () => {
    const st = settings();
    const s = createUpdatesStore({ backend: null, settings: st });
    expect(s.getState().status).toBe('unavailable');
    await s.getState().init();
    await s.getState().check();
    await s.getState().install();
    expect(s.getState().status).toBe('unavailable');
    expect(st.settingsGetAll).not.toHaveBeenCalled();
  });

  it('à jour, puis disponible : l’état et la date de vérification sont tenus', async () => {
    const check = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(INFO);
    const s = createUpdatesStore({
      backend: backend({ check }),
      settings: settings(),
      now: () => new Date('2026-12-02T10:00:00Z'),
    });
    await s.getState().init();
    expect(s.getState().currentVersion).toBe('0.1.3');
    await s.getState().check();
    expect(s.getState().status).toBe('upToDate');
    expect(s.getState().lastCheckedAt).toBe('2026-12-02T10:00:00.000Z');
    await s.getState().check();
    expect(s.getState().status).toBe('available');
    expect(s.getState().info).toEqual(INFO);
  });

  it('jamais d’installation sans mise à jour annoncée, ni deux à la fois', async () => {
    const install = vi.fn(async () => undefined);
    const s = createUpdatesStore({ backend: backend({ install }), settings: settings() });
    await s.getState().install(); // rien d'annoncé
    expect(install).not.toHaveBeenCalled();
  });

  it('installation : progression suivie, erreur signalée sans rien casser', async () => {
    let report: (d: number, t: number | null) => void = () => undefined;
    let fail: (e: Error) => void = () => undefined;
    const install = vi.fn(
      (cb: (d: number, t: number | null) => void) =>
        new Promise<void>((_ok, ko) => {
          report = cb;
          fail = ko;
        }),
    );
    const onError = vi.fn();
    const s = createUpdatesStore({
      backend: backend({ check: vi.fn(async () => INFO), install }),
      settings: settings(),
      onError,
    });
    await s.getState().check();
    const p = s.getState().install();
    expect(s.getState().status).toBe('downloading');
    report(25, 100);
    expect(s.getState().progress).toBe(0.25);
    report(10, null);
    expect(s.getState().progress).toBeNull();
    fail(new Error('signature invalide'));
    await p;
    expect(s.getState().status).toBe('error');
    expect(s.getState().progress).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('vérification manuelle en échec : erreur affichée ; automatique en échec : silence total', async () => {
    const onError = vi.fn();
    const check = vi.fn(async () => {
      throw new Error('réseau');
    });
    const s = createUpdatesStore({ backend: backend({ check }), settings: settings(), onError });
    await s.getState().check({ silent: true });
    expect(s.getState().status).toBe('idle');
    expect(onError).not.toHaveBeenCalled();
    await s.getState().check();
    expect(s.getState().status).toBe('error');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('préférence « vérifier automatiquement » : relue et enregistrée', async () => {
    const st = settings([{ key: 'ui.auto-update', valueJson: 'false' }]);
    const s = createUpdatesStore({ backend: backend(), settings: st });
    await s.getState().init();
    expect(s.getState().auto).toBe(false);
    await s.getState().setAuto(true);
    expect(st.settingsSet).toHaveBeenCalledWith('ui.auto-update', 'true');
  });
});

describe('mises à jour : contrôle automatique et interface', () => {
  beforeEach(async () => {
    await initI18n('fr');
  });
  afterEach(() => vi.useRealTimers());

  function Harness({ store }: { store: ReturnType<typeof createUpdatesStore> }) {
    useAutoUpdateCheck(store);
    return null;
  }

  it('contrôle discret : après 8 s puis toutes les 6 h, seulement si activé', async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => null);
    const s = createUpdatesStore({ backend: backend({ check }), settings: settings() });
    const { unmount } = render(<Harness store={s} />);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    expect(check).toHaveBeenCalledTimes(2);
    unmount();
    await vi.advanceTimersByTimeAsync(7 * 60 * 60_000);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it('désactivé : aucun contrôle automatique', async () => {
    vi.useFakeTimers();
    const check = vi.fn(async () => null);
    const s = createUpdatesStore({
      backend: backend({ check }),
      settings: settings([{ key: 'ui.auto-update', valueJson: 'false' }]),
    });
    render(<Harness store={s} />);
    await vi.advanceTimersByTimeAsync(7 * 60 * 60_000);
    expect(check).not.toHaveBeenCalled();
  });

  it('interface : chercher, voir les nouveautés, installer sur clic (jamais avant)', async () => {
    const install = vi.fn(async () => undefined);
    const s = createUpdatesStore({
      backend: backend({ check: vi.fn(async () => INFO), install }),
      settings: settings(),
    });
    await act(() => s.getState().init());
    const user = userEvent.setup();
    render(
      <UpdatesProvider store={s}>
        <UpdatesSection />
      </UpdatesProvider>,
    );
    expect(screen.getByText('Version installée : 0.1.3')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Rechercher une mise à jour' }));
    expect(await screen.findByText('La version 0.2.0 est disponible.')).toBeInTheDocument();
    expect(screen.getByText(/Nouveautés/)).toBeInTheDocument();
    expect(install).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Installer et redémarrer' }));
    await waitFor(() => expect(install).toHaveBeenCalledTimes(1));
  });

  it('interface sans module : message clair, aucune action proposée', () => {
    const s = createUpdatesStore({ backend: null, settings: settings() });
    render(
      <UpdatesProvider store={s}>
        <UpdatesSection />
      </UpdatesProvider>,
    );
    expect(
      screen.getByText(
        /uniquement disponibles dans l.application installée|que dans l.application installée/,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Rechercher une mise à jour' }),
    ).not.toBeInTheDocument();
  });
});
