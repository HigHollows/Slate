import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import { describe, expect, it } from 'vitest';
import { useNav } from '../features/navigation';
import { renderApp } from '../test-utils';

type Ctx = Awaited<ReturnType<typeof renderApp>>;
const sleep = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)));

/** Base prête à l'emploi (données créées via l'API, puis ouverte dans l'interface). */
async function seed(ctx: Ctx, opts: { rows?: number } = {}) {
  const { api, pages } = ctx;
  const d = await api.dbCreate({
    parentId: null,
    title: 'Projets',
    titlePropertyName: 'Nom',
    viewName: 'Tableau',
  });
  const prix = await api.propCreate({
    databaseId: d.node.id,
    name: 'Prix',
    kind: 'number',
    config: {},
    beforeId: null,
    twoWayName: null,
  });
  const statut = await api.propCreate({
    databaseId: d.node.id,
    name: 'Statut',
    kind: 'status',
    config: {
      options: [
        { id: 'todo', name: 'À faire', group: 'todo' },
        { id: 'doing', name: 'En cours', group: 'doing' },
        { id: 'done', name: 'Terminé', group: 'done' },
      ],
    },
    beforeId: null,
    twoWayName: null,
  });
  const note = await api.propCreate({
    databaseId: d.node.id,
    name: 'Note',
    kind: 'text',
    config: {},
    beforeId: null,
    twoWayName: null,
  });
  const titles = ['Alpha', 'Beta', 'Gamma', 'Delta'].slice(0, opts.rows ?? 4);
  const rows = [];
  for (const [i, t] of titles.entries()) {
    rows.push(
      await api.rowCreate({
        databaseId: d.node.id,
        title: t,
        props: { [prix.id]: (i + 1) * 10, ...(i % 2 === 0 ? { [statut.id]: 'doing' } : {}) },
      }),
    );
  }
  await pages.getState().refresh();
  act(() => useNav.getState().navigate({ name: 'database', id: d.node.id }));
  await screen.findByRole('grid', { name: 'Tableau de la base de données' });
  return { db: d.node, prix, statut, note, rows };
}
const grid = () => screen.getByRole('grid', { name: 'Tableau de la base de données' });
const cell = (r: number, c: number) =>
  grid().querySelector(`[data-cell="${r}:${c}"]`) as HTMLElement;
const titlesInGrid = () =>
  [...grid().querySelectorAll('[data-cell$=":0"]')].map((c) =>
    c.textContent?.replace(/Ouvrir$/, '').trim(),
  );

describe('bases de données : création et structure', () => {
  it('crée une base depuis la barre latérale : titre, colonne « Nom », vue Tableau, aucune ligne', async () => {
    const user = userEvent.setup();
    const { api } = await renderApp();
    await user.click(screen.getByRole('button', { name: 'Nouvelle base de données' }));
    expect(
      await screen.findByRole('grid', { name: 'Tableau de la base de données' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Nom/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Tableau', selected: true })).toBeInTheDocument();
    expect(screen.getByText('Aucune ligne pour le moment.')).toBeInTheDocument();
    expect(api.nodes.some((n) => n.kind === 'database')).toBe(true);
    // La base apparaît dans l'arbre avec sa propre icône et ne contient pas de sous-pages à créer.
    expect(within(screen.getByRole('tree')).getByRole('treeitem')).toBeInTheDocument();
  });

  it('ajoute une propriété via le dialogue, la colonne apparaît et la base reste accessible (axe)', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { db } = await seed(ctx);
    await user.click(screen.getByRole('button', { name: 'Ajouter une propriété' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(
      within(dialog).getByRole('textbox', { name: 'Nom de la propriété' }),
      'Quantité',
    );
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Type' }), 'number');
    expect(await axe(dialog)).toHaveNoViolations();
    await user.click(within(dialog).getByRole('button', { name: 'Créer' }));
    expect(await screen.findByRole('columnheader', { name: /Quantité/ })).toBeInTheDocument();
    expect(
      ctx.api.dbProps.get(db.id)?.some((p) => p.name === 'Quantité' && p.type === 'number'),
    ).toBe(true);
  });

  it('refuse un nom de propriété déjà utilisé et affiche l’erreur', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    await seed(ctx);
    await user.click(screen.getByRole('button', { name: 'Ajouter une propriété' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Nom de la propriété' }), 'prix');
    await user.click(within(dialog).getByRole('button', { name: 'Créer' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Rien n’a été modifié'.replace('’', "'"),
    );
    expect(screen.getByRole('dialog')).toBeInTheDocument(); // le dialogue reste ouvert, rien n'est perdu
  });

  it('valide la syntaxe d’une formule en direct et affiche son résultat par ligne', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    await seed(ctx);
    await user.click(screen.getByRole('button', { name: 'Ajouter une propriété' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('textbox', { name: 'Nom de la propriété' }), 'Total');
    await user.selectOptions(within(dialog).getByRole('combobox', { name: 'Type' }), 'formula');
    const f = within(dialog).getByRole('textbox', { name: 'Formule' });
    await user.type(f, 'prop("Prix") *');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Syntaxe');
    expect(within(dialog).getByRole('button', { name: 'Créer' })).toBeDisabled();
    await user.type(f, ' 2');
    await waitFor(() => expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument());
    await user.click(within(dialog).getByRole('button', { name: 'Créer' }));
    await screen.findByRole('columnheader', { name: /Total/ });
    expect(cell(0, 4).textContent).toBe('20');
    expect(cell(3, 4).textContent).toBe('80');
  });
});

describe('table type tableur', () => {
  it('navigation au clavier, saisie directe (nombre) et validation par Entrée', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { prix, rows } = await seed(ctx);
    act(() => grid().focus());
    expect(cell(0, 0)).toHaveAttribute('aria-selected', 'true'); // le focus du tableau active la première cellule
    await user.keyboard('{ArrowRight}{ArrowDown}'); // Prix, ligne 2
    expect(cell(1, 1)).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('77');
    expect(await screen.findByRole('textbox', { name: 'Prix' })).toHaveValue('77');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(ctx.api.rowProps.get(rows[1]!.id)?.[prix.id]).toBe(77));
    expect(cell(1, 1).textContent).toContain('77');
    expect(cell(2, 1)).toHaveAttribute('aria-selected', 'true'); // Entrée descend, comme un tableur
  });

  it('Échap annule l’édition ; une valeur invalide reste dans le champ sans rien écrire', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { prix, rows } = await seed(ctx);
    act(() => grid().focus());
    await user.keyboard('{ArrowRight}');
    await user.keyboard('abc{Enter}');
    expect(await screen.findByRole('textbox', { name: 'Prix' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(ctx.api.cellsSet).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Prix' })).not.toBeInTheDocument();
    expect(ctx.api.rowProps.get(rows[0]!.id)?.[prix.id]).toBe(10);
  });

  it('Suppr efface la cellule, y compris sur une plage sélectionnée avec Maj+flèches', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { prix, rows } = await seed(ctx);
    act(() => grid().focus());
    await user.keyboard('{ArrowRight}{Shift>}{ArrowDown}{ArrowDown}{/Shift}{Delete}');
    await waitFor(() => expect(ctx.api.rowProps.get(rows[0]!.id)?.[prix.id]).toBeUndefined());
    expect(ctx.api.rowProps.get(rows[1]!.id)?.[prix.id]).toBeUndefined();
    expect(ctx.api.rowProps.get(rows[2]!.id)?.[prix.id]).toBeUndefined();
    expect(ctx.api.rowProps.get(rows[3]!.id)?.[prix.id]).toBe(40);
    expect(ctx.api.cellsSet).toHaveBeenCalledTimes(1); // une seule transaction pour toute la plage
  });

  it('modifie une case à cocher à l’espace, un titre à l’édition, une date au format JJ/MM/AAAA', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { db, rows } = await seed(ctx);
    for (const [name, kind] of [
      ['Fait', 'checkbox'],
      ['Échéance', 'date'],
    ] as const) {
      await ctx.api.propCreate({
        databaseId: db.id,
        name,
        kind,
        config: {},
        beforeId: null,
        twoWayName: null,
      });
    }
    await ctx.databases.getState().load(db.id, true);
    act(() => grid().focus());
    await user.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}{ArrowRight}'); // colonne « Fait »
    await user.keyboard(' ');
    const fait = ctx.api.dbProps.get(db.id)!.find((p) => p.name === 'Fait')!;
    await waitFor(() => expect(ctx.api.rowProps.get(rows[0]!.id)?.[fait.id]).toBe(true));
    await user.keyboard('{ArrowRight}5/3/2025{Enter}');
    const ech = ctx.api.dbProps.get(db.id)!.find((p) => p.name === 'Échéance')!;
    await waitFor(() => expect(ctx.api.rowProps.get(rows[0]!.id)?.[ech.id]).toBe('2025-03-05'));
    await user.keyboard('{Home}{Enter}');
    const input = await screen.findByRole('textbox', { name: 'Nom' });
    await user.clear(input);
    await user.type(input, 'Renommée{Enter}');
    // Entrée a fait descendre le curseur après la saisie de la date : on renomme donc la ligne suivante.
    await waitFor(() =>
      expect(ctx.api.nodes.find((n) => n.id === rows[1]!.id)?.title).toBe('Renommée'),
    );
  });

  it('copier-coller TSV multi-cellules : valeurs valides appliquées en un lot, refus comptés', async () => {
    const ctx = await renderApp();
    const { prix, note, rows } = await seed(ctx);
    act(() => grid().focus());
    act(() => cell(1, 1).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    const data = {
      getData: () => '111\t\tune note\n222\t\tautre\nPAS UN NOMBRE\t\tx',
      setData: () => undefined,
    };
    fireEvent.paste(grid(), { clipboardData: data });
    await waitFor(() => expect(ctx.api.rowProps.get(rows[1]!.id)?.[prix.id]).toBe(111));
    expect(ctx.api.rowProps.get(rows[1]!.id)?.[note.id]).toBe('une note');
    expect(ctx.api.rowProps.get(rows[2]!.id)?.[prix.id]).toBe(222);
    expect(ctx.api.rowProps.get(rows[3]!.id)?.[prix.id]).toBe(40); // refusée : inchangée
    expect(ctx.api.rowProps.get(rows[3]!.id)?.[note.id]).toBe('x'); // la cellule valide de la même ligne est appliquée
    expect(await screen.findByText(/1 refusée/)).toBeInTheDocument();
    expect(ctx.api.cellsSet).toHaveBeenCalledTimes(1);
  });

  it('copier : la sélection est placée dans le presse-papiers en TSV', async () => {
    const ctx = await renderApp();
    await seed(ctx);
    act(() => grid().focus());
    act(() => cell(0, 0).dispatchEvent(new MouseEvent('mousedown', { bubbles: true })));
    const store: Record<string, string> = {};
    fireEvent.keyDown(grid(), { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(grid(), { key: 'ArrowRight', shiftKey: true });
    fireEvent.copy(grid(), {
      clipboardData: { setData: (k: string, v: string) => (store[k] = v), getData: () => '' },
    });
    expect(store['text/plain']).toBe('Alpha\t10\nBeta\t20');
  });

  it('échec d’écriture : la cellule revient à sa valeur et une erreur est affichée (aucune perte silencieuse)', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { prix, rows } = await seed(ctx);
    ctx.api.state.failCells = true;
    act(() => grid().focus());
    await user.keyboard('{ArrowRight}99{Enter}');
    expect((await screen.findAllByRole('alert'))[0]).toHaveTextContent('errors.io');
    expect(ctx.api.rowProps.get(rows[0]!.id)?.[prix.id]).toBe(10);
    await waitFor(() => expect(cell(0, 1).textContent).toContain('10'));
    expect(ctx.api.cellsSet).toHaveBeenCalledTimes(1); // une seule tentative d'écriture par validation
    expect(cell(0, 1).textContent).not.toContain('99');
  });

  it('sélection de lignes + suppression avec annulation', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { rows } = await seed(ctx);
    await user.click(screen.getByRole('checkbox', { name: 'Sélectionner Beta' }));
    await user.click(screen.getByRole('checkbox', { name: 'Sélectionner Gamma' }));
    expect(screen.getByText('2 ligne(s) sélectionnée(s)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mettre à la corbeille' }));
    await waitFor(() => expect(titlesInGrid()).toEqual(['Alpha', 'Delta']));
    expect(ctx.api.nodes.find((n) => n.id === rows[1]!.id)?.deletedAt).not.toBeNull();
    await user.click(await screen.findByRole('button', { name: 'Annuler' }));
    await waitFor(() => expect(titlesInGrid()).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']));
  });

  it('largeur de colonne : poignée et menu, persistée dans la vue', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { prix, db } = await seed(ctx);
    await user.click(screen.getByRole('button', { name: /^Prix/ }));
    await user.click(await screen.findByRole('menuitem', { name: 'Élargir la colonne' }));
    await waitFor(() =>
      expect(ctx.api.dbViews.get(db.id)![0]!.config['widths']).toEqual({ [prix.id]: 220 }),
    );
  });

  it('virtualisation : 2 000 lignes, seules quelques-unes sont dans le DOM', async () => {
    const ctx = await renderApp();
    const { db } = await seed(ctx, { rows: 0 });
    const many = Array.from({ length: 2000 }, (_, i) =>
      ctx.api.rowCreate({ databaseId: db.id, title: `Ligne ${i}`, props: null }),
    );
    await Promise.all(many);
    await ctx.databases.getState().load(db.id, true);
    await waitFor(() => expect(screen.getByText('2000 sur 2000 lignes')).toBeInTheDocument());
    expect(grid().querySelectorAll('[role="row"]').length).toBeLessThan(80);
    expect(grid().getAttribute('aria-rowcount')).toBe('2001');
  });
});

describe('filtres, tris, recherche', () => {
  it('filtre par statut, combine en OU, compte les lignes, et se persiste dans la vue', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { db } = await seed(ctx);
    await user.click(screen.getByRole('button', { name: 'Filtrer' }));
    const pop = await screen.findByRole('dialog', { name: 'Filtrer' });
    await user.click(within(pop).getByRole('button', { name: 'Ajouter un filtre' }));
    await user.selectOptions(within(pop).getByRole('combobox', { name: 'Propriété' }), 'Statut');
    await user.selectOptions(within(pop).getByRole('combobox', { name: 'Valeur' }), 'En cours');
    await waitFor(() => expect(titlesInGrid()).toEqual(['Alpha', 'Gamma']));
    expect(screen.getByText('2 sur 4 lignes')).toBeInTheDocument();
    await waitFor(() =>
      expect(ctx.api.dbViews.get(db.id)![0]!.config['filter']).toMatchObject({
        children: [{ op: 'is', value: 'doing' }],
      }),
    );
    expect(await axe(pop)).toHaveNoViolations();
    // Ajout d'une règle en OU
    await user.click(within(pop).getByRole('button', { name: 'Ajouter un filtre' }));
    const props = within(pop).getAllByRole('combobox', { name: 'Propriété' });
    await user.selectOptions(props[1]!, 'Nom');
    await user.selectOptions(within(pop).getByRole('combobox', { name: 'Combiner' }), 'or');
    const values = within(pop).getAllByRole('textbox', { name: 'Valeur' });
    await user.type(values[0]!, 'delta');
    await waitFor(() => expect(titlesInGrid()).toEqual(['Alpha', 'Gamma', 'Delta']));
  });

  it('trie plusieurs colonnes et l’indique dans l’en-tête (aria-sort)', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    await seed(ctx);
    await user.click(screen.getByRole('button', { name: 'Trier' }));
    const pop = await screen.findByRole('dialog', { name: 'Trier' });
    await user.click(within(pop).getByRole('button', { name: 'Ajouter un tri' }));
    await user.selectOptions(within(pop).getByRole('combobox', { name: 'Propriété' }), 'Prix');
    await user.click(within(pop).getByRole('radio', { name: 'Décroissant' }));
    await waitFor(() => expect(titlesInGrid()).toEqual(['Delta', 'Gamma', 'Beta', 'Alpha']));
    expect(screen.getByRole('columnheader', { name: /Prix/ })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
  });

  it('recherche dans la vue (insensible aux accents) et message quand rien ne correspond', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    await seed(ctx);
    await user.type(screen.getByRole('searchbox', { name: 'Rechercher dans la vue' }), 'GAMMA');
    await waitFor(() => expect(titlesInGrid()).toEqual(['Gamma']));
    await user.clear(screen.getByRole('searchbox', { name: 'Rechercher dans la vue' }));
    await user.type(screen.getByRole('searchbox', { name: 'Rechercher dans la vue' }), 'zzz');
    expect(
      await screen.findByText('Aucune ligne ne correspond aux filtres ou à la recherche.'),
    ).toBeInTheDocument();
  });

  it('propriétés : masquer une colonne, l’état est conservé par vue', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { note, db } = await seed(ctx);
    await user.click(screen.getByRole('button', { name: 'Propriétés' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Afficher Note' }));
    await waitFor(() =>
      expect(screen.queryByRole('columnheader', { name: /Note/ })).not.toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(ctx.api.dbViews.get(db.id)![0]!.config['hidden']).toEqual([note.id]),
    );
  });
});

describe('vues partagées : mêmes données partout', () => {
  it('une modification dans le tableau est immédiatement visible dans le kanban, la liste et la galerie', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { statut, rows } = await seed(ctx);
    for (const [name, layout] of [
      ['Kanban', 'kanban'],
      ['Liste', 'list'],
      ['Galerie', 'gallery'],
    ] as const) {
      await user.click(screen.getByRole('button', { name: 'Ajouter une vue' }));
      await user.click(
        await screen.findByRole('menuitem', {
          name: layout === 'kanban' ? 'Kanban' : layout === 'list' ? 'Liste' : 'Galerie',
        }),
      );
      expect(await screen.findByRole('tab', { name, selected: true })).toBeInTheDocument();
    }
    // Kanban : colonnes par statut, regroupement automatique.
    await user.click(screen.getByRole('tab', { name: 'Kanban' }));
    const doing = await screen.findByRole('region', { name: 'En cours' });
    expect(within(doing).getByText('Alpha')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'À faire' })).queryByText('Beta'),
    ).not.toBeInTheDocument();
    // Édition depuis le tableau…
    await user.click(screen.getByRole('tab', { name: 'Tableau' }));
    await ctx.databases
      .getState()
      .setCells(rows[0]!.databaseId, [
        { rowId: rows[0]!.id, propertyId: statut.id, value: 'done' },
      ]);
    // …visible dans toutes les autres vues, sans rechargement.
    await user.click(screen.getByRole('tab', { name: 'Kanban' }));
    expect(
      within(await screen.findByRole('region', { name: 'Terminé' })).getByText('Alpha'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Liste' }));
    expect(await screen.findByRole('list', { name: 'Liste des lignes' })).toBeInTheDocument();
    expect(screen.getByText('Terminé')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Galerie' }));
    expect(
      within(await screen.findByRole('list', { name: 'Galerie des lignes' })).getByText('Terminé'),
    ).toBeInTheDocument();
  });

  it('kanban : glisser une carte change la valeur de groupement, et le menu clavier fait de même', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { statut, rows, db } = await seed(ctx);
    await ctx.api.viewCreate({
      databaseId: db.id,
      name: 'Kanban',
      layout: 'kanban',
      config: { groupBy: statut.id },
    });
    await ctx.databases.getState().load(db.id, true);
    await user.click(await screen.findByRole('tab', { name: 'Kanban' }));
    const dt = { setData() {}, getData: () => '', effectAllowed: 'all', dropEffect: 'move' };
    const card = within(await screen.findByRole('region', { name: 'En cours' }))
      .getByText('Alpha')
      .closest('article')!;
    const target = screen.getByRole('region', { name: 'Terminé' });
    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.dragOver(target, { dataTransfer: dt });
    fireEvent.drop(target, { dataTransfer: dt });
    await waitFor(() => expect(ctx.api.rowProps.get(rows[0]!.id)?.[statut.id]).toBe('done'));
    // Alternative accessible
    await user.click(screen.getByRole('button', { name: 'Déplacer la carte Gamma' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Déplacer vers « À faire »' }));
    await waitFor(() => expect(ctx.api.rowProps.get(rows[2]!.id)?.[statut.id]).toBe('todo'));
  });

  it('kanban sans propriété de groupement : état vide explicite', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const d = await ctx.api.dbCreate({
      parentId: null,
      title: 'Vide',
      titlePropertyName: 'Nom',
      viewName: 'Tableau',
    });
    await ctx.api.viewCreate({
      databaseId: d.node.id,
      name: 'Kanban',
      layout: 'kanban',
      config: {},
    });
    await ctx.pages.getState().refresh();
    act(() => useNav.getState().navigate({ name: 'database', id: d.node.id }));
    await user.click(await screen.findByRole('tab', { name: 'Kanban' }));
    expect(
      await screen.findByText('Ajoutez une propriété de statut ou de sélection'),
    ).toBeInTheDocument();
  });

  it('une vue peut être renommée puis supprimée, la dernière est protégée côté interface', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { db } = await seed(ctx);
    await ctx.api.viewCreate({ databaseId: db.id, name: 'Autre', layout: 'list', config: {} });
    await ctx.databases.getState().load(db.id, true);
    await user.click(await screen.findByRole('tab', { name: 'Autre' }));
    await user.click(screen.getByRole('button', { name: 'Actions de la vue Autre' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Renommer la vue' }));
    const dlg = await screen.findByRole('dialog');
    const input = within(dlg).getByRole('textbox', { name: 'Nom de la vue' });
    await user.clear(input);
    await user.type(input, 'Backlog{Enter}');
    expect(await screen.findByRole('tab', { name: 'Backlog' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Actions de la vue Backlog' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Supprimer la vue' }));
    await waitFor(() =>
      expect(screen.queryByRole('tab', { name: 'Backlog' })).not.toBeInTheDocument(),
    );
  });
});

describe('ligne = page complète, relations', () => {
  it('ouvre une ligne comme page : propriétés éditables, contenu, et la base se met à jour', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { rows, prix } = await seed(ctx);
    await user.click(within(cell(0, 0)).getByRole('button', { name: 'Ouvrir la ligne Alpha' }));
    expect(await screen.findByRole('textbox', { name: 'Titre de la page' })).toHaveValue('Alpha');
    const panel = await screen.findByRole('region', { name: 'Propriétés de la ligne' });
    expect(within(panel).getByRole('button', { name: 'Modifier : Prix' })).toHaveTextContent('10');
    await user.click(within(panel).getByRole('button', { name: 'Modifier : Prix' }));
    const input = within(panel).getByRole('textbox', { name: 'Prix' });
    await user.clear(input);
    await user.type(input, '555{Enter}');
    await waitFor(() => expect(ctx.api.rowProps.get(rows[0]!.id)?.[prix.id]).toBe(555));
    await user.click(within(panel).getByRole('button', { name: 'Projets' }));
    expect(
      (await screen.findByRole('grid', { name: 'Tableau de la base de données' })).textContent,
    ).toContain('555');
    // L'éditeur de la ligne est un vrai éditeur de page.
    act(() => useNav.getState().navigate({ name: 'page', id: rows[0]!.id }));
    expect(await screen.findByRole('textbox', { name: 'Contenu de la page' })).toBeInTheDocument();
  });

  it('renommer la ligne depuis sa page met à jour le tableau', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { rows } = await seed(ctx);
    act(() => useNav.getState().navigate({ name: 'page', id: rows[1]!.id }));
    const title = await screen.findByRole('textbox', { name: 'Titre de la page' });
    await user.clear(title);
    await user.type(title, 'Bêta v2');
    await waitFor(
      () => expect(ctx.api.nodes.find((n) => n.id === rows[1]!.id)?.title).toBe('Bêta v2'),
      { timeout: 3000 },
    );
    act(() => useNav.getState().navigate({ name: 'database', id: rows[1]!.databaseId }));
    await screen.findByRole('grid', { name: 'Tableau de la base de données' });
    expect(titlesInGrid()).toContain('Bêta v2');
  });

  it('relation à double sens : choisir une ligne met à jour les deux bases', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const a = await ctx.api.dbCreate({
      parentId: null,
      title: 'Clients',
      titlePropertyName: 'Nom',
      viewName: 'Tableau',
    });
    const ra = await ctx.api.rowCreate({ databaseId: a.node.id, title: 'ACME', props: null });
    const b = await ctx.api.dbCreate({
      parentId: null,
      title: 'Commandes',
      titlePropertyName: 'Nom',
      viewName: 'Tableau',
    });
    const rb = await ctx.api.rowCreate({ databaseId: b.node.id, title: 'CMD-1', props: null });
    const rel = await ctx.api.propCreate({
      databaseId: b.node.id,
      name: 'Client',
      kind: 'relation',
      config: { targetDatabaseId: a.node.id },
      beforeId: null,
      twoWayName: 'Commandes liées',
    });
    await ctx.pages.getState().refresh();
    act(() => useNav.getState().navigate({ name: 'database', id: b.node.id }));
    await screen.findByRole('grid', { name: 'Tableau de la base de données' });
    act(() => grid().focus());
    await user.keyboard('{ArrowRight}{Enter}');
    const list = await screen.findByRole('listbox', { name: 'Client' });
    await user.click(within(list).getByRole('option', { name: /ACME/ }));
    await waitFor(() => expect(ctx.api.rowProps.get(rb.id)?.[rel.id]).toEqual([ra.id]));
    const reverse = rel.config['reversePropertyId'] as string;
    expect(ctx.api.rowProps.get(ra.id)?.[reverse]).toEqual([rb.id]);
    expect(cell(0, 1).textContent).toContain('ACME');
    // Côté inverse (base déjà chargée dans le cache) : valeur rafraîchie par le retour du cœur.
    expect(ctx.databases.getState().dbs[a.node.id]?.rows[0]?.props[reverse]).toEqual([rb.id]);
  });
});

describe('accessibilité des vues', () => {
  it('tableau, kanban, liste, galerie : aucune violation axe', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { statut, db } = await seed(ctx);
    for (const [name, layout] of [
      ['Kanban', 'kanban'],
      ['Liste', 'list'],
      ['Galerie', 'gallery'],
    ] as const) {
      await ctx.api.viewCreate({
        databaseId: db.id,
        name,
        layout,
        config: layout === 'kanban' ? { groupBy: statut.id } : {},
      });
    }
    await ctx.databases.getState().load(db.id, true);
    const container = document.body;
    const r0 = await axe(container);
    expect(
      r0.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      'tableau',
    ).toEqual([]);
    for (const n of ['Kanban', 'Liste', 'Galerie']) {
      await user.click(await screen.findByRole('tab', { name: n }));
      await sleep(30);
      expect(await axe(container), n).toHaveNoViolations();
    }
  });
});
