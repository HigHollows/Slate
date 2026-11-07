import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { axe } from 'vitest-axe';
import { useWritingMode } from '../features/editor';
import { renderApp } from '../test-utils';

type PMEditor = { commands: { insertContent(c: unknown): boolean }; isEditable: boolean };
const editorOf = (): PMEditor => {
  const dom = document.querySelector('.ProseMirror') as
    (HTMLElement & { editor?: PMEditor }) | null;
  if (!dom?.editor) throw new Error('éditeur introuvable');
  return dom.editor;
};
const newPage = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getAllByRole('button', { name: 'Nouvelle page' })[0]!);
  await screen.findByRole('textbox', { name: 'Contenu de la page' });
  return editorOf();
};
const menu = async (user: ReturnType<typeof userEvent.setup>, item: string | RegExp) => {
  await user.click(screen.getByRole('button', { name: 'Affichage' }));
  await user.click(await screen.findByRole('menuitem', { name: item }));
};

beforeEach(() => useWritingMode.setState({ readMode: false, focusMode: false }));

describe('mode lecture', () => {
  it('rend le document non modifiable et masque toutes les commandes d’édition, puis revient', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('<h2>Titre</h2><p>Contenu <strong>gras</strong></p>'));
    expect(screen.getByRole('toolbar', { name: 'Barre de mise en forme' })).toBeInTheDocument();

    await menu(user, 'Mode lecture');
    await waitFor(() => expect(ed.isEditable).toBe(false));
    expect(document.querySelector('.ProseMirror')).toHaveAttribute('contenteditable', 'false');
    expect(
      screen.queryByRole('toolbar', { name: 'Barre de mise en forme' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Titre de la page' })).toHaveAttribute('readonly');
    expect(screen.getByText(/Lecture seule/)).toBeInTheDocument();
    // la hiérarchie documentaire reste là
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(document.querySelector('.ProseMirror h2')?.textContent).toBe('Titre');
    expect(document.querySelector('.ProseMirror strong')?.textContent).toBe('gras');
    expect(
      await axe(document.querySelector('[data-writing-mode]') as HTMLElement),
    ).toHaveNoViolations();
    const saves = api.pageSave.mock.calls.length;
    await user.type(document.querySelector('.ProseMirror') as HTMLElement, 'tapé');
    expect(document.querySelector('.ProseMirror')?.textContent).not.toContain('tapé');
    expect(api.pageSave.mock.calls.length).toBe(saves);

    await menu(user, 'Passer en mode édition');
    await waitFor(() => expect(ed.isEditable).toBe(true));
    expect(screen.getByRole('toolbar', { name: 'Barre de mise en forme' })).toBeInTheDocument();
  });

  it('le raccourci Ctrl+Maj+E bascule ; la recherche reste disponible mais sans remplacement', async () => {
    const user = userEvent.setup();
    await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('<p>un mot, un autre mot</p>'));
    await user.keyboard('{Control>}{Shift>}e{/Shift}{/Control}');
    await waitFor(() => expect(ed.isEditable).toBe(false));
    await user.keyboard('{Control>}f{/Control}');
    const bar = await screen.findByRole('search', { name: 'Rechercher dans le document' });
    await user.type(within(bar).getByRole('textbox', { name: 'Rechercher' }), 'mot');
    expect(await within(bar).findByText('1 / 2')).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: 'Tout remplacer' })).not.toBeInTheDocument();
  });

  it('n’est pas mémorisé : un nouveau démarrage est en mode édition', async () => {
    useWritingMode.setState({ readMode: true });
    useWritingMode.setState({ readMode: false }); // simulation d'un redémarrage : l'état n'est lu d'aucun stockage
    const { api } = await renderApp();
    expect(api.settings.has('pref.read-mode')).toBe(false);
    expect(useWritingMode.getState().readMode).toBe(false);
  });
});

describe('mode focus', () => {
  it('masque barre latérale, en-tête et éléments secondaires ; Échap ou le bouton reviennent', async () => {
    const user = userEvent.setup();
    await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('<p>texte</p>'));
    expect(screen.getByRole('navigation', { name: 'Navigation principale' })).toBeInTheDocument();

    await menu(user, 'Mode focus');
    await waitFor(() =>
      expect(
        screen.queryByRole('navigation', { name: 'Navigation principale' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('navigation', { name: "Fil d'Ariane" })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quitter le mode focus' })).toBeInTheDocument();
    // l'édition reste complète et les raccourcis fonctionnent
    expect(ed.isEditable).toBe(true);
    expect(await axe(document.body)).toHaveNoViolations();
    await user.keyboard('{Escape}');
    expect(
      await screen.findByRole('navigation', { name: 'Navigation principale' }),
    ).toBeInTheDocument();

    await user.keyboard('{Control>}{Shift>}f{/Shift}{/Control}');
    await waitFor(() =>
      expect(
        screen.queryByRole('navigation', { name: 'Navigation principale' }),
      ).not.toBeInTheDocument(),
    );
    await user.click(screen.getByRole('button', { name: 'Quitter le mode focus' }));
    expect(
      await screen.findByRole('navigation', { name: 'Navigation principale' }),
    ).toBeInTheDocument();
  });

  it('Échap ne quitte pas le mode focus quand il ferme autre chose (recherche ouverte)', async () => {
    const user = userEvent.setup();
    await renderApp();
    await newPage(user);
    useWritingMode.getState().setFocusMode(true);
    await user.keyboard('{Control>}f{/Control}');
    const bar = await screen.findByRole('search', { name: 'Rechercher dans le document' });
    await user.click(within(bar).getByRole('textbox', { name: 'Rechercher' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('search')).not.toBeInTheDocument());
    expect(useWritingMode.getState().focusMode).toBe(true);
  });
});

describe('largeur de lecture', () => {
  it('se choisit, s’applique, est enregistrée dans les préférences et se relit', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    await newPage(user);
    const page = () => document.querySelector('[data-writing-mode]') as HTMLElement;
    expect(page().className).toContain('max-w-3xl');
    for (const [label, cls] of [
      ['Largeur du document : Étroit', 'max-w-xl'],
      ['Largeur du document : Large', 'max-w-5xl'],
      ['Largeur du document : Pleine largeur', 'max-w-none'],
    ] as const) {
      await menu(user, label);
      await waitFor(() => expect(page().className).toContain(cls));
    }
    expect(api.settingsSet).toHaveBeenCalledWith('pref.reading-width', '"full"');
    await user.click(screen.getByRole('button', { name: 'Affichage' }));
    expect(
      await screen.findByRole('menuitem', { name: /Pleine largeur — actuel/ }),
    ).toBeInTheDocument();
  });
});

describe('tâches terminées barrées', () => {
  it('le réglage Apparence barre ou non les tâches cochées et est enregistré', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    await user.keyboard('{Control>},{/Control}');
    await user.click(await screen.findByRole('button', { name: 'Apparence' }));
    expect(document.documentElement.dataset['taskStrike']).toBe('true');
    const group = await screen.findByRole('radiogroup', { name: 'Tâches terminées' });
    await user.click(within(group).getByRole('radio', { name: 'Non barré' }));
    await waitFor(() => expect(document.documentElement.dataset['taskStrike']).toBe('false'));
    expect(api.settingsSet).toHaveBeenCalledWith('pref.task-strike', 'false');
    await user.click(within(group).getByRole('radio', { name: 'Barré' }));
    await waitFor(() => expect(document.documentElement.dataset['taskStrike']).toBe('true'));
  });
});
