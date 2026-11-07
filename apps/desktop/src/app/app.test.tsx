import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../test-utils';

const root = () => document.documentElement;

describe('application (intégration)', () => {
  it('affiche l’accueil avec une navigation accessible et sans violation axe', async () => {
    const { container } = await renderApp();
    expect(screen.getByRole('heading', { level: 1, name: 'Accueil' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Navigation principale' })).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('applique et persiste les préférences stockées au démarrage', async () => {
    await renderApp({
      'pref.theme': '"dark"',
      'pref.density': '"compact"',
      'pref.accent': '"#c9467f"',
    });
    await waitFor(() => expect(root().dataset['theme']).toBe('dark'));
    expect(root().dataset['density']).toBe('compact');
    expect(root().style.getPropertyValue('--accent')).toBe('#c9467f');
  });

  it('palette : Ctrl+K, recherche sans accents, Entrée exécute et persiste le choix', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByRole('combobox', { name: 'Rechercher une commande…' });
    await user.type(input, 'theme sombre');
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Thème sombre');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(root().dataset['theme']).toBe('dark'));
    expect(api.data.get('pref.theme')).toBe('"dark"');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // historique des commandes persisté et proposé à la réouverture
    expect(JSON.parse(api.data.get('history.commands') ?? '[]')).toEqual(['theme.dark']);
    await user.keyboard('{Control>}k{/Control}');
    expect(await screen.findByText('Récentes')).toBeInTheDocument();
  });

  it('palette : message explicite quand rien ne correspond, Échap ferme', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'zzzzqq');
    expect(screen.getByRole('status')).toHaveTextContent('Aucune commande pour « zzzzqq »');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('palette accessible (axe)', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    expect(await axe(dialog)).toHaveNoViolations();
  });

  it('paramètres : navigation, changement de thème par l’interface, historique précédent/suivant', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    await user.keyboard('{Control>},{/Control}');
    expect(
      await screen.findByRole('heading', { name: 'Paramètres', level: 1 }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Sombre' }));
    expect(root().dataset['theme']).toBe('dark');
    expect(api.data.get('pref.theme')).toBe('"dark"');
    await user.click(screen.getByRole('button', { name: 'Précédent' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Accueil' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Suivant' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Paramètres' })).toBeInTheDocument();
  });

  it('chaque onglet de paramètres est accessible (axe)', async () => {
    const user = userEvent.setup();
    const { container } = await renderApp();
    await user.keyboard('{Control>},{/Control}');
    for (const name of ['Apparence', 'Langue et formats', 'Raccourcis', 'Système et licences']) {
      await user.click(screen.getByRole('button', { name }));
      expect(await axe(container), name).toHaveNoViolations();
    }
  });

  it('un échec d’écriture restaure l’état et affiche une erreur visible', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    await user.keyboard('{Control>},{/Control}');
    api.state.failWrites = true;
    await user.click(screen.getByRole('radio', { name: 'Sombre' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('errors.io');
    expect(root().dataset['theme']).not.toBe('dark');
    const theme = within(screen.getByRole('radiogroup', { name: 'Thème' }));
    expect(theme.getByRole('radio', { name: 'Système' })).toHaveAttribute('aria-checked', 'true');
  });

  it('changement de langue immédiat, persisté', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    await user.keyboard('{Control>},{/Control}');
    await user.click(screen.getByRole('button', { name: 'Langue et formats' }));
    await user.click(screen.getByRole('radio', { name: 'English' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
    expect(root().lang).toBe('en');
    expect(api.data.get('pref.locale')).toBe('"en"');
  });

  it('barre latérale : masquer/afficher au clavier et au clic, état persisté', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    await user.keyboard('{Control>}\\{/Control}');
    await waitFor(() =>
      expect(
        screen.queryByRole('navigation', { name: 'Navigation principale' }),
      ).not.toBeInTheDocument(),
    );
    expect(api.data.get('pref.sidebar-collapsed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'Afficher la barre latérale' }));
    expect(
      await screen.findByRole('navigation', { name: 'Navigation principale' }),
    ).toBeInTheDocument();
  });

  it('barre latérale : redimensionnement au clavier borné et persisté', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    const sep = screen.getByRole('separator', { name: 'Redimensionner la barre latérale' });
    sep.focus();
    await user.keyboard('{ArrowRight}');
    await waitFor(() => expect(api.data.get('pref.sidebar-width')).toBe('272'));
    for (let i = 0; i < 20; i++) await user.keyboard('{Shift>}{ArrowRight}{/Shift}');
    await waitFor(() => expect(api.data.get('pref.sidebar-width')).toBe('420'));
  });

  it('raccourcis : remappage, détection de conflit et réinitialisation', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    await user.keyboard('{Control>},{/Control}');
    await user.click(screen.getByRole('button', { name: 'Raccourcis' }));

    await user.click(
      screen.getByRole('button', { name: "Modifier le raccourci : Aller à l'accueil" }),
    );
    await user.keyboard('{Control>}k{/Control}'); // déjà pris par la palette
    expect(
      await screen.findByText(/Déjà utilisée par « Ouvrir la palette de commandes »/),
    ).toBeInTheDocument();
    await user.keyboard('{Control>}c{/Control}'); // réservé
    expect(screen.getByText(/réservée/)).toBeInTheDocument();
    await user.keyboard('x'); // pas de modificateur
    expect(screen.getByText('Ajoutez Ctrl/⌘ ou Alt.')).toBeInTheDocument();
    await user.keyboard('{Control>}9{/Control}');
    await waitFor(() => expect(api.data.get('shortcut.nav.home')).toBe('"Mod+9"'));

    // la nouvelle combinaison fonctionne réellement
    await user.keyboard('{Control>}9{/Control}');
    expect(await screen.findByRole('heading', { level: 1, name: 'Accueil' })).toBeInTheDocument();

    await user.keyboard('{Control>},{/Control}');
    await user.click(await screen.findByRole('button', { name: 'Raccourcis' }));
    await user.click(screen.getByRole('button', { name: 'Réinitialiser' }));
    await waitFor(() => expect(api.data.has('shortcut.nav.home')).toBe(false));
  });

  it('les actions de la palette et des raccourcis ne se déclenchent pas pendant la capture', async () => {
    const user = userEvent.setup();
    await renderApp();
    await user.keyboard('{Control>},{/Control}');
    await user.click(screen.getByRole('button', { name: 'Raccourcis' }));
    await user.click(
      screen.getByRole('button', {
        name: 'Modifier le raccourci : Ouvrir la palette de commandes',
      }),
    );
    await act(async () => {
      await user.keyboard('{Escape}');
    });
    expect(within(document.body).queryByRole('dialog')).not.toBeInTheDocument();
  });
});
