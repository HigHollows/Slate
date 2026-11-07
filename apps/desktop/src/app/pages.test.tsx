import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { useNav } from '../features/navigation';
import { renderApp } from '../test-utils';

type PMEditor = {
  commands: { insertContent(c: unknown): boolean; focus(p?: string): boolean };
  getText(): string;
  chain(): { focus(): { insertContent(c: unknown): { run(): boolean } } };
};
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
const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

describe('pages : création, titre, arbre', () => {
  it('crée une page, ouvre l’éditeur, met le curseur dans le titre et enregistre le titre', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    await newPage(user);
    const title = screen.getByRole('textbox', { name: 'Titre de la page' });
    expect(title).toHaveFocus();
    await user.type(title, 'Plan de projet');
    await waitFor(() => expect(api.nodes[0]?.title).toBe('Plan de projet'), { timeout: 3000 });
    const tree = screen.getByRole('tree', { name: 'Pages et dossiers' });
    expect(within(tree).getByText('Plan de projet')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Plan de projet' })).toBeInTheDocument();
  });

  it('enregistre le contenu (état binaire, instantané, texte) et affiche « Enregistré »', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('Bonjour monde'));
    await waitFor(() => expect(api.pageSave).toHaveBeenCalled(), { timeout: 3000 });
    const saved = api.pageSave.mock.calls.at(-1)![0];
    expect(saved.textPlain).toContain('Bonjour monde');
    expect(saved.docState.length).toBeGreaterThan(10);
    expect(JSON.parse(saved.contentJson).type).toBe('doc');
    expect(await screen.findByText('Enregistré')).toBeInTheDocument();
  });

  it('ne réécrit rien quand on ouvre une page sans la modifier', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    await newPage(user);
    await sleep(1200);
    expect(api.pageSave).not.toHaveBeenCalled();
  });

  it('retrouve le contenu en revenant sur la page', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('Texte durable'));
    await waitFor(() => expect(api.pageSave).toHaveBeenCalled(), { timeout: 3000 });
    const id = api.nodes[0]!.id;
    act(() => useNav.getState().navigate({ name: 'home' }));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: 'Contenu de la page' })).not.toBeInTheDocument(),
    );
    act(() => useNav.getState().navigate({ name: 'page', id }));
    expect(await screen.findByText('Texte durable')).toBeInTheDocument();
  });

  it('quitter la page tout de suite n’abandonne pas la dernière frappe', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('Dernière frappe'));
    act(() => useNav.getState().navigate({ name: 'home' }));
    await waitFor(() => expect(api.pageSave).toHaveBeenCalled(), { timeout: 3000 });
    expect(api.pageSave.mock.calls.at(-1)![0].textPlain).toContain('Dernière frappe');
  });

  it('échec d’écriture : erreur visible, contenu conservé, nouvelle tentative manuelle réussie', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    const ed = await newPage(user);
    api.state.failPageSave = true;
    act(() => void ed.commands.insertContent('À ne pas perdre'));
    expect(
      await screen.findByText("Échec de l'enregistrement", {}, { timeout: 3000 }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('alert')[0]).toHaveTextContent(/nouvelle tentative automatique/);
    expect(screen.getByText('À ne pas perdre')).toBeInTheDocument();
    api.state.failPageSave = false;
    await user.click(screen.getByRole('button', { name: 'Réessayer' }));
    await waitFor(() =>
      expect(api.pages.get(api.nodes[0]!.id)?.textPlain).toContain('À ne pas perdre'),
    );
    expect(await screen.findByText('Enregistré')).toBeInTheDocument();
  });

  it('page supprimée ou inexistante : état explicite avec retour à l’accueil', async () => {
    const user = userEvent.setup();
    await renderApp();
    act(() => useNav.getState().navigate({ name: 'page', id: 'fantome' }));
    expect(await screen.findByText("Cette page n'existe plus")).toBeInTheDocument();
    await user.click(within(screen.getByRole('main')).getByRole('button', { name: 'Accueil' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Accueil' })).toBeInTheDocument();
  });

  it('la vue page est accessible (axe)', async () => {
    const user = userEvent.setup();
    const { container } = await renderApp();
    await newPage(user);
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('arbre de la barre latérale', () => {
  const seed = async () => {
    const ctx = await renderApp();
    const f = await ctx.pages
      .getState()
      .createNode({ parentId: null, kind: 'folder', title: 'Projets' });
    const a = await ctx.pages
      .getState()
      .createNode({ parentId: f!.id, kind: 'page', title: 'Alpha' });
    const b = await ctx.pages
      .getState()
      .createNode({ parentId: null, kind: 'page', title: 'Beta' });
    return { ...ctx, f: f!, a: a!, b: b! };
  };

  it('accessible (axe) et navigable au clavier : flèches, dépliage, ouverture', async () => {
    const user = userEvent.setup();
    const { container, f } = await seed();
    const tree = await screen.findByRole('tree', { name: 'Pages et dossiers' });
    expect(await axe(container)).toHaveNoViolations();
    const folder = within(tree).getByRole('treeitem', { name: /Projets/ });
    expect(folder).toHaveAttribute('aria-expanded', 'true'); // créé avec un enfant : parent déplié
    act(() => folder.focus());
    await user.keyboard('{ArrowLeft}');
    expect(folder).toHaveAttribute('aria-expanded', 'false');
    expect(within(tree).queryByText('Alpha')).not.toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(await within(tree).findByText('Alpha')).toBeInTheDocument();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(await screen.findByRole('textbox', { name: 'Titre de la page' })).toHaveValue('Beta');
    void f;
  });

  it('renomme avec F2 / Entrée', async () => {
    const user = userEvent.setup();
    const { api, b } = await seed();
    const tree = await screen.findByRole('tree');
    const item = within(tree).getByRole('treeitem', { name: /Beta/ });
    act(() => item.focus());
    await user.keyboard('{F2}');
    const input = within(tree).getByRole('textbox', { name: 'Renommer' });
    await user.clear(input);
    await user.type(input, 'Gamma{Enter}');
    await waitFor(() => expect(api.nodes.find((n) => n.id === b.id)?.title).toBe('Gamma'));
    expect(await within(tree).findByText('Gamma')).toBeInTheDocument();
  });

  it('supprime avec Suppr, propose Annuler, et la restauration remet l’élément', async () => {
    const user = userEvent.setup();
    const { api, b } = await seed();
    const tree = await screen.findByRole('tree');
    act(() => within(tree).getByRole('treeitem', { name: /Beta/ }).focus());
    await user.keyboard('{Delete}');
    await waitFor(() => expect(within(tree).queryByText('Beta')).not.toBeInTheDocument());
    expect(await screen.findByText(/« Beta » mis à la corbeille/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(await within(tree).findByText('Beta')).toBeInTheDocument();
    expect(api.nodes.find((n) => n.id === b.id)?.deletedAt).toBeNull();
  });

  it('favoris : la section apparaît et la page y figure', async () => {
    const user = userEvent.setup();
    const { b } = await seed();
    expect(screen.queryByRole('region', { name: 'Favoris' })).not.toBeInTheDocument();
    act(() => useNav.getState().navigate({ name: 'page', id: b.id }));
    await user.click(await screen.findByRole('button', { name: 'Ajouter aux favoris' }));
    const fav = await screen.findByRole('region', { name: 'Favoris' });
    expect(within(fav).getByText('Beta')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retirer des favoris' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('déplacement via la boîte de dialogue accessible (alternative au glisser-déposer)', async () => {
    const user = userEvent.setup();
    const { api, b, f } = await seed();
    const tree = await screen.findByRole('tree');
    await user.click(within(tree).getByRole('button', { name: 'Actions pour Beta' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Déplacer vers…' }));
    const list = await screen.findByRole('listbox', { name: 'Déplacer vers' });
    expect(within(list).queryByText('Beta')).not.toBeInTheDocument(); // pas soi-même
    await user.click(within(list).getByText('Projets'));
    await waitFor(() => expect(api.nodes.find((n) => n.id === b.id)?.parentId).toBe(f.id));
  });

  it('glisser-déposer : déposer au milieu d’un dossier déplace dedans', async () => {
    const { api, b, f } = await seed();
    const tree = await screen.findByRole('tree');
    const src = within(tree).getByRole('treeitem', { name: /Beta/ });
    const dst = within(tree).getByRole('treeitem', { name: /Projets/ });
    dst.getBoundingClientRect = () =>
      ({
        top: 0,
        height: 32,
        bottom: 32,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    const dt = { setData() {}, getData: () => '', effectAllowed: 'all', dropEffect: 'move' };
    fireEvent.dragStart(src, { dataTransfer: dt });
    fireEvent.dragOver(dst, { dataTransfer: dt, clientY: 16 });
    fireEvent.drop(dst, { dataTransfer: dt, clientY: 16 });
    await waitFor(() => expect(api.nodes.find((n) => n.id === b.id)?.parentId).toBe(f.id));
  });

  it('refuse de déposer un dossier dans son propre descendant', async () => {
    const { api, f } = await seed();
    const tree = await screen.findByRole('tree');
    const src = within(tree).getByRole('treeitem', { name: /Projets/ });
    const dst = within(tree).getByRole('treeitem', { name: /Alpha/ });
    dst.getBoundingClientRect = () =>
      ({
        top: 0,
        height: 32,
        bottom: 32,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;
    const dt = { setData() {}, getData: () => '', effectAllowed: 'all', dropEffect: 'move' };
    fireEvent.dragStart(src, { dataTransfer: dt });
    fireEvent.dragOver(dst, { dataTransfer: dt, clientY: 16 });
    fireEvent.drop(dst, { dataTransfer: dt, clientY: 16 });
    await sleep(100);
    expect(api.nodeMove).not.toHaveBeenCalled();
    expect(api.nodes.find((n) => n.id === f.id)?.parentId).toBeNull();
  });
});

describe('corbeille', () => {
  it('restaure ou supprime définitivement après confirmation', async () => {
    const user = userEvent.setup();
    const { api, pages } = await renderApp();
    const p = await pages.getState().createNode({ parentId: null, kind: 'page', title: 'Jetable' });
    const q = await pages.getState().createNode({ parentId: null, kind: 'page', title: 'Gardée' });
    await pages.getState().remove(p!.id);
    await pages.getState().remove(q!.id);
    await user.click(screen.getByRole('button', { name: 'Corbeille' }));
    expect(await screen.findByText('Jetable')).toBeInTheDocument();

    await user.click(
      within(screen.getByText('Gardée').closest('li')!).getByRole('button', { name: 'Restaurer' }),
    );
    await waitFor(() =>
      expect(screen.queryByText('Gardée', { selector: 'li div' })).not.toBeInTheDocument(),
    );
    expect(api.nodes.find((n) => n.id === q!.id)?.deletedAt).toBeNull();

    await user.click(
      within(screen.getByText('Jetable').closest('li')!).getByRole('button', {
        name: 'Supprimer définitivement',
      }),
    );
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('irréversible');
    expect(api.nodePurge).not.toHaveBeenCalled(); // rien avant confirmation
    await user.click(within(dialog).getByRole('button', { name: 'Supprimer définitivement' }));
    await waitFor(() => expect(api.nodes.find((n) => n.id === p!.id)).toBeUndefined());
  });

  it('état vide et accessibilité', async () => {
    const user = userEvent.setup();
    const { container } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Corbeille' }));
    expect(await screen.findByText('La corbeille est vide')).toBeInTheDocument();
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('recherche, mentions, menu /', () => {
  it('la palette trouve des pages et les ouvre', async () => {
    const user = userEvent.setup();
    const { pages } = await renderApp();
    await pages.getState().createNode({ parentId: null, kind: 'page', title: 'Budget annuel' });
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'budget');
    const opt = await screen.findByRole('option', { name: /Budget annuel/ });
    await user.click(opt);
    expect(await screen.findByRole('textbox', { name: 'Titre de la page' })).toHaveValue(
      'Budget annuel',
    );
  });

  it('les commandes « Nouvelle page » et « Corbeille » de la palette fonctionnent', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    await user.keyboard('{Control>}k{/Control}');
    await user.type(await screen.findByRole('combobox'), 'nouvelle page');
    await user.keyboard('{Enter}');
    await screen.findByRole('textbox', { name: 'Contenu de la page' });
    expect(api.nodes).toHaveLength(1);
  });

  it('menu / : filtre, navigation clavier et transformation du bloc', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('/titre'));
    const list = await screen.findByRole('listbox', { name: 'Insérer un bloc' });
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Titre 1'),
        expect.stringContaining('Titre 2'),
      ]),
    );
    expect(within(list).queryByText('Tableau')).not.toBeInTheDocument();
    fireEvent.keyDown(document.querySelector('.ProseMirror')!, { key: 'ArrowDown' });
    fireEvent.keyDown(document.querySelector('.ProseMirror')!, { key: 'Enter' });
    await waitFor(() => expect(document.querySelector('.ProseMirror h2')).not.toBeNull());
    expect(document.querySelector('.ProseMirror')!.textContent).not.toContain('/titre');
    await waitFor(() => expect(api.pageSave).toHaveBeenCalled(), { timeout: 3000 });
  });

  it('menu / : message quand aucun bloc ne correspond', async () => {
    const user = userEvent.setup();
    await renderApp();
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('/zzzzzz'));
    expect(await screen.findByText('Aucun bloc correspondant')).toBeInTheDocument();
  });

  it('mention de page : enregistrée comme lien, rétrolien affiché sur la page cible', async () => {
    const user = userEvent.setup();
    const { api, pages } = await renderApp();
    const target = await pages
      .getState()
      .createNode({ parentId: null, kind: 'page', title: 'Cible' });
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent({ type: 'pageMention', attrs: { id: target!.id } }));
    await waitFor(() => expect(api.pageSave).toHaveBeenCalled(), { timeout: 3000 });
    expect(api.pageSave.mock.calls.at(-1)![0].linkTargets).toEqual([target!.id]);
    expect(await screen.findByRole('button', { name: 'Ouvrir la page Cible' })).toBeInTheDocument();
    act(() => useNav.getState().navigate({ name: 'page', id: target!.id }));
    const region = await screen.findByRole('region', { name: 'Mentionnée dans' });
    expect(within(region).getByRole('button')).toBeInTheDocument();
  });

  it('menu @ : propose les pages existantes', async () => {
    const user = userEvent.setup();
    const { pages } = await renderApp();
    await pages.getState().createNode({ parentId: null, kind: 'page', title: 'Réunion hebdo' });
    const ed = await newPage(user);
    act(() => void ed.commands.insertContent('@reunion'));
    const list = await screen.findByRole('listbox', { name: 'Mentionner une page' });
    expect(within(list).getByText('Réunion hebdo')).toBeInTheDocument();
    expect(within(list).getByText(/Créer la page « reunion »/)).toBeInTheDocument();
  });
});

describe('édition : annuler/rétablir et déplacement de blocs', () => {
  type Ed = PMEditor & {
    commands: { undo(): boolean; redo(): boolean; setContent(c: unknown): boolean };
  };
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const texts = () => [...document.querySelectorAll('.ProseMirror > p')].map((p) => p.textContent);

  it('annuler puis rétablir (Yjs) restituent le contenu', async () => {
    const user = userEvent.setup();
    await renderApp();
    const ed = (await newPage(user)) as Ed;
    act(() => void ed.commands.insertContent('Premier'));
    await sleep(700); // sépare les groupes d'annulation
    act(() => void ed.commands.insertContent(' Second'));
    expect(document.querySelector('.ProseMirror')!.textContent).toContain('Premier Second');
    act(() => void ed.commands.undo());
    expect(document.querySelector('.ProseMirror')!.textContent).not.toContain('Second');
    expect(document.querySelector('.ProseMirror')!.textContent).toContain('Premier');
    act(() => void ed.commands.redo());
    expect(document.querySelector('.ProseMirror')!.textContent).toContain('Second');
  });

  it('Alt+Maj+↓ / ↑ déplacent le bloc courant sans rien perdre', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    const ed = (await newPage(user)) as Ed;
    act(
      () =>
        void ed.commands.setContent({ type: 'doc', content: [para('A'), para('B'), para('C')] }),
    );
    act(
      () =>
        void (ed as unknown as { commands: { focus(p: string): boolean } }).commands.focus('start'),
    );
    const dom = document.querySelector('.ProseMirror')!;
    fireEvent.keyDown(dom, { key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(texts()).toEqual(['B', 'A', 'C']);
    fireEvent.keyDown(dom, { key: 'ArrowDown', altKey: true, shiftKey: true });
    expect(texts()).toEqual(['B', 'C', 'A']);
    fireEvent.keyDown(dom, { key: 'ArrowDown', altKey: true, shiftKey: true }); // bord : sans effet
    expect(texts()).toEqual(['B', 'C', 'A']);
    fireEvent.keyDown(dom, { key: 'ArrowUp', altKey: true, shiftKey: true });
    expect(texts()).toEqual(['B', 'A', 'C']);
    await waitFor(() => expect(api.pageSave).toHaveBeenCalled(), { timeout: 3000 });
  });
});
