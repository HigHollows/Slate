import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { useNav } from '../features/navigation';
import { renderApp } from '../test-utils';

const bar = () => screen.getByRole('navigation', { name: 'Onglets ouverts' });
const tabNames = () =>
  within(bar())
    .getAllByRole('listitem')
    .map((li) => within(li).queryAllByRole('button')[0]?.textContent ?? '')
    .filter(Boolean);
const makePage = async (user: ReturnType<typeof userEvent.setup>, title: string) => {
  await user.click(screen.getAllByRole('button', { name: 'Nouvelle page' })[0]!);
  const t = await screen.findByRole('textbox', { name: 'Titre de la page' });
  await user.clear(t);
  await user.type(t, title);
};

describe('onglets : interface', () => {
  it('un onglet « Accueil » au départ ; la barre est accessible', async () => {
    await renderApp();
    expect(tabNames()).toEqual(['Accueil']);
    expect(within(bar()).getByRole('button', { name: 'Accueil' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(await axe(bar())).toHaveNoViolations();
  });

  it('nouvel onglet, activation, fermeture par le bouton ×, le dernier revient à l’accueil', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.click(within(bar()).getByRole('button', { name: 'Nouvel onglet' }));
    expect(tabNames()).toEqual(['Accueil', 'Accueil']);
    await user.click(
      screen.getByRole('button', { name: 'Paramètres' }).closest('button') ??
        screen.getAllByRole('button', { name: /Paramètres/ })[0]!,
    );
    expect(tabNames()).toContain('Paramètres');
    // fermer le premier onglet « Accueil »
    await user.click(
      within(bar()).getAllByRole('button', { name: /Fermer l'onglet « Accueil »/ })[0]!,
    );
    expect(useNav.getState().tabs).toHaveLength(1);
    await user.click(within(bar()).getByRole('button', { name: /Fermer l'onglet/ }));
    expect(tabNames()).toEqual(['Accueil']);
  });

  it('une page garde son titre dans son onglet, qui suit le renommage', async () => {
    const user = userEvent.setup();
    await renderApp();
    await makePage(user, 'Projet X');
    await waitFor(() => expect(tabNames()).toEqual(['Projet X']));
    const title = screen.getByRole('textbox', { name: 'Titre de la page' });
    await user.type(title, ' bis');
    await waitFor(() => expect(tabNames()).toEqual(['Projet X bis']));
  });

  it('Ctrl+clic sur une page de l’arbre l’ouvre dans un NOUVEL onglet ; un clic simple remplace l’onglet actif', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    await makePage(user, 'Alpha');
    await makePage(user, 'Beta');
    await waitFor(() => expect(ctx.api.nodes.filter((n) => n.kind === 'page')).toHaveLength(2));
    // Beta ouvre dans l'onglet courant (remplace Alpha), qui n'était qu'un seul onglet
    expect(useNav.getState().tabs).toHaveLength(1);
    const tree = screen.getByRole('tree');
    const alpha = within(tree).getByRole('button', { name: 'Alpha' });
    await user.keyboard('{Control>}');
    await user.click(alpha);
    await user.keyboard('{/Control}');
    await waitFor(() => expect(useNav.getState().tabs).toHaveLength(2));
    await waitFor(() => expect(tabNames()).toEqual(['Beta', 'Alpha']));
    expect(within(bar()).getByRole('button', { name: 'Alpha' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // clic du milieu sur Beta : déjà ouvert → on y retourne, pas de doublon
    fireEvent(
      within(tree).getByRole('button', { name: 'Beta' }),
      new MouseEvent('auxclick', { bubbles: true, button: 1 }),
    );
    await waitFor(() =>
      expect(within(bar()).getByRole('button', { name: 'Beta' })).toHaveAttribute(
        'aria-current',
        'page',
      ),
    );
    expect(useNav.getState().tabs).toHaveLength(2);
  });

  it('menu contextuel : fermer les autres onglets ; Suppr sur un onglet le ferme', async () => {
    const user = userEvent.setup();
    await renderApp();
    act(() => {
      useNav.getState().openTab({ name: 'trash' });
      useNav.getState().openTab({ name: 'settings', tab: 'about' });
    });
    expect(useNav.getState().tabs).toHaveLength(3);
    const trashTab = within(bar()).getByRole('button', { name: 'Corbeille' });
    fireEvent.contextMenu(trashTab.closest('li')!);
    await user.click(await screen.findByRole('menuitem', { name: 'Fermer les autres onglets' }));
    expect(tabNames()).toEqual(['Corbeille']);
    act(() => useNav.getState().openTab({ name: 'trash' })); // déjà ouvert : rien de plus
    expect(tabNames()).toEqual(['Corbeille']);
    within(bar()).getByRole('button', { name: 'Corbeille' }).focus();
    await user.keyboard('{Delete}');
    expect(tabNames()).toEqual(['Accueil']);
  });

  it('commandes et raccourcis : nouvel onglet, suivant, précédent, fermer, rouvrir', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.keyboard('{Control>}t{/Control}');
    expect(useNav.getState().tabs).toHaveLength(2);
    act(() => useNav.getState().navigate({ name: 'trash' }));
    await user.keyboard('{Control>}{Alt>}{ArrowLeft}{/Alt}{/Control}');
    expect(useNav.getState().route).toEqual({ name: 'home' });
    await user.keyboard('{Control>}{Alt>}{ArrowRight}{/Alt}{/Control}');
    expect(useNav.getState().route).toEqual({ name: 'trash' });
    await user.keyboard('{Control>}{Alt>}w{/Alt}{/Control}');
    expect(useNav.getState().tabs).toHaveLength(1);
    await user.keyboard('{Control>}{Shift>}t{/Shift}{/Control}');
    expect(useNav.getState().route).toEqual({ name: 'trash' });
    expect(useNav.getState().tabs).toHaveLength(2);
  });

  it('glisser-déposer : réordonne les onglets', async () => {
    await renderApp();
    act(() => {
      useNav.getState().openTab({ name: 'trash' });
      useNav.getState().openTab({ name: 'settings', tab: 'about' });
    });
    expect(tabNames()).toEqual(['Accueil', 'Corbeille', 'Paramètres']);
    const items = within(bar()).getAllByRole('listitem');
    const data = new Map<string, string>();
    const dt = {
      setData: (k: string, v: string) => data.set(k, v),
      getData: (k: string) => data.get(k) ?? '',
      effectAllowed: '',
    };
    fireEvent.dragStart(items[2]!, { dataTransfer: dt });
    fireEvent.dragOver(items[0]!, { dataTransfer: dt });
    fireEvent.drop(items[0]!, { dataTransfer: dt });
    await waitFor(() => expect(tabNames()).toEqual(['Paramètres', 'Accueil', 'Corbeille']));
  });

  it('page supprimée ou introuvable : l’onglet reste lisible (« Page indisponible »)', async () => {
    await renderApp();
    act(() => useNav.getState().openTab({ name: 'page', id: 'inconnue-0000' }));
    expect(tabNames()).toContain('Page indisponible');
  });
});
