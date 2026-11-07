import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { SecurityProvider, createSecurityStore } from '../features/security';
import { useIdleLock } from '../features/security';
import { fakeBackend, renderApp } from '../test-utils';

afterEach(() => vi.useRealTimers());
const pinField = () => screen.getByLabelText('PIN');

describe('écran de verrouillage', () => {
  it('démarre verrouillé : aucune donnée n’est demandée avant le PIN, et l’écran est accessible', async () => {
    const ctx = await renderApp({}, { pin: { code: '1234', locked: true } });
    expect(screen.getByRole('dialog', { name: 'Slate est verrouillé' })).toBeInTheDocument();
    expect(
      screen.queryByRole('navigation', { name: 'Navigation principale' }),
    ).not.toBeInTheDocument();
    expect(ctx.api.treeList).not.toHaveBeenCalled();
    expect(ctx.api.settingsGetAll).not.toHaveBeenCalled();
    expect(await axe(document.body)).toHaveNoViolations();
  });

  it('un mauvais PIN affiche les essais restants sans rien révéler ; le bon PIN charge l’application', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp({}, { pin: { code: '1234', locked: true } });
    await user.type(pinField(), '0000{Enter}');
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'PIN incorrect. 4 essai(s) avant blocage.',
    );
    expect(pinField()).toHaveValue(''); // le champ est vidé après un échec
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.type(pinField(), '1234{Enter}');
    expect(
      await screen.findByRole('navigation', { name: 'Navigation principale' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Slate est verrouillé' })).not.toBeInTheDocument();
    await waitFor(() => expect(ctx.api.treeList).toHaveBeenCalled());
  });

  it('seuls des chiffres sont acceptés, 6 au maximum', async () => {
    const user = userEvent.setup();
    await renderApp({}, { pin: { code: '1234', locked: true } });
    await user.type(pinField(), 'ab12-34cd5678');
    expect(pinField()).toHaveValue('123456');
    expect(screen.getByRole('button', { name: 'Déverrouiller' })).toBeEnabled();
    await user.clear(pinField());
    await user.type(pinField(), '12');
    expect(screen.getByRole('button', { name: 'Déverrouiller' })).toBeDisabled();
  });

  it('blocage progressif : après 5 échecs, saisie désactivée avec décompte, même le bon PIN est refusé', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp({}, { pin: { code: '1234', locked: true } });
    for (let i = 0; i < 5; i++) {
      await user.type(pinField(), '9999{Enter}');
      await waitFor(() => expect(ctx.api.pinVerify).toHaveBeenCalledTimes(i + 1));
    }
    expect(await screen.findByText(/Trop d'essais\. Réessayez dans \d+ s\./)).toBeInTheDocument();
    expect(pinField()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Déverrouiller' })).toBeDisabled();
    expect(ctx.api.pin.locked).toBe(true);
  });

  it('si une commande de données est refusée par le cœur (verrou), l’écran de verrouillage apparaît sans erreur brute', async () => {
    const ctx = await renderApp({}, { pin: { code: '1234' } });
    expect(
      await screen.findByRole('navigation', { name: 'Navigation principale' }),
    ).toBeInTheDocument();
    ctx.api.pin.locked = true; // verrouillé côté natif (p. ex. depuis une autre fenêtre)
    await ctx.security.getState().refresh();
    expect(await screen.findByRole('dialog', { name: 'Slate est verrouillé' })).toBeInTheDocument();
    expect(screen.queryByRole('alert', { name: /errors\./ })).not.toBeInTheDocument();
  });
});

describe('paramètres de sécurité', () => {
  const openTab = async (user: ReturnType<typeof userEvent.setup>) => {
    await user.keyboard('{Control>},{/Control}');
    await user.click(await screen.findByRole('button', { name: 'Sécurité' }));
  };

  it('active un PIN : confirmation obligatoire, format 4 ou 6 chiffres, puis verrouillage immédiat et déverrouillage', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    await openTab(user);
    await user.click(screen.getByRole('button', { name: 'Activer le PIN' }));
    await user.type(screen.getByLabelText('Nouveau PIN'), '12345');
    await user.type(screen.getByLabelText('Confirmer le PIN'), '12345');
    expect(screen.getByRole('button', { name: 'Appliquer' })).toBeDisabled(); // 5 chiffres : refusé
    await user.clear(screen.getByLabelText('Nouveau PIN'));
    await user.clear(screen.getByLabelText('Confirmer le PIN'));
    await user.type(screen.getByLabelText('Nouveau PIN'), '482913');
    await user.type(screen.getByLabelText('Confirmer le PIN'), '482914');
    expect(await screen.findByText('Les deux PIN ne correspondent pas.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Appliquer' })).toBeDisabled();
    await user.clear(screen.getByLabelText('Confirmer le PIN'));
    await user.type(screen.getByLabelText('Confirmer le PIN'), '482913');
    await user.click(screen.getByRole('button', { name: 'Appliquer' }));
    await waitFor(() => expect(ctx.api.pin.code).toBe('482913'));
    expect(await screen.findByRole('button', { name: 'Verrouiller' })).toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();

    await user.click(screen.getByRole('button', { name: 'Verrouiller' }));
    expect(await screen.findByRole('dialog', { name: 'Slate est verrouillé' })).toBeInTheDocument();
    await user.type(pinField(), '482913{Enter}');
    expect(
      await screen.findByRole('navigation', { name: 'Navigation principale' }),
    ).toBeInTheDocument();
  });

  it('modifier le PIN exige l’ancien ; le désactiver exige le PIN et rétablit l’ouverture libre', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp({}, { pin: { code: '1234' } });
    await openTab(user);
    await user.click(await screen.findByRole('button', { name: 'Modifier le PIN' }));
    await user.type(screen.getByLabelText('PIN actuel'), '0000');
    await user.type(screen.getByLabelText('Nouveau PIN'), '5678');
    await user.type(screen.getByLabelText('Confirmer le PIN'), '5678');
    await user.click(screen.getByRole('button', { name: 'Appliquer' }));
    expect(await screen.findByText(/PIN incorrect/)).toBeInTheDocument();
    expect(ctx.api.pin.code).toBe('1234');
    await user.clear(screen.getByLabelText('PIN actuel'));
    await user.type(screen.getByLabelText('PIN actuel'), '1234');
    await user.click(screen.getByRole('button', { name: 'Appliquer' }));
    await waitFor(() => expect(ctx.api.pin.code).toBe('5678'));

    await user.click(await screen.findByRole('button', { name: 'Désactiver le PIN' }));
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText('PIN actuel'), '1111');
    await user.click(within(dlg).getByRole('button', { name: 'Appliquer' }));
    expect(await within(dlg).findByRole('alert')).toHaveTextContent('PIN incorrect');
    await user.type(within(dlg).getByLabelText('PIN actuel'), '5678');
    await user.click(within(dlg).getByRole('button', { name: 'Appliquer' }));
    await waitFor(() => expect(ctx.api.pin.code).toBeNull());
    expect(await screen.findByRole('button', { name: 'Activer le PIN' })).toBeInTheDocument();
  });

  it('les options de verrouillage exigent le PIN', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp({}, { pin: { code: '1234' } });
    await openTab(user);
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Verrouiller après inactivité' }),
      '5',
    );
    const dlg = await screen.findByRole('dialog');
    await user.type(within(dlg).getByLabelText('PIN actuel'), '1234');
    await user.click(within(dlg).getByRole('button', { name: 'Appliquer' }));
    await waitFor(() => expect(ctx.api.pin.idle).toBe(5));
    await user.click(screen.getByRole('switch', { name: 'Verrouiller au démarrage' }));
    const dlg2 = await screen.findByRole('dialog');
    await user.type(within(dlg2).getByLabelText('PIN actuel'), '1234');
    await user.click(within(dlg2).getByRole('button', { name: 'Appliquer' }));
    await waitFor(() => expect(ctx.api.pin.lockOnStart).toBe(false));
  });

  it('la commande « Verrouiller Slate » n’existe que lorsqu’un PIN est actif (Ctrl+L)', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp({}, { pin: { code: '1234' } });
    await screen.findByRole('navigation', { name: 'Navigation principale' });
    await user.keyboard('{Control>}l{/Control}');
    expect(await screen.findByRole('dialog', { name: 'Slate est verrouillé' })).toBeInTheDocument();
    expect(ctx.api.pinLock).toHaveBeenCalled();
  });
});

describe('verrouillage après inactivité', () => {
  function setup(idle: number) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const api = fakeBackend();
    api.pin.code = '1234';
    api.pin.idle = idle;
    const store = createSecurityStore(api);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SecurityProvider store={store}>{children}</SecurityProvider>
    );
    return { api, store, wrapper };
  }

  it('verrouille après le délai ; l’activité repousse l’échéance', async () => {
    const { api, store, wrapper } = setup(1);
    await act(async () => store.getState().refresh());
    renderHook(() => useIdleLock(), { wrapper });
    await act(async () => void (await vi.advanceTimersByTimeAsync(59_000)));
    expect(api.pinLock).not.toHaveBeenCalled();
    act(() => void window.dispatchEvent(new Event('pointermove')));
    await act(async () => void (await vi.advanceTimersByTimeAsync(59_000)));
    expect(api.pinLock).not.toHaveBeenCalled(); // l'activité a remis le compteur à zéro
    await act(async () => void (await vi.advanceTimersByTimeAsync(2_000)));
    expect(api.pinLock).toHaveBeenCalledTimes(1);
    expect(store.getState().lock?.locked).toBe(true);
  });

  it('ne fait rien sans délai configuré, sans PIN ou déjà verrouillé', async () => {
    const a = setup(0);
    await act(async () => a.store.getState().refresh());
    renderHook(() => useIdleLock(), { wrapper: a.wrapper });
    await act(async () => void (await vi.advanceTimersByTimeAsync(10 * 3_600_000)));
    expect(a.api.pinLock).not.toHaveBeenCalled();
  });
});
