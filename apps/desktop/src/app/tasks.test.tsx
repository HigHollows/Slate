import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { useNav } from '../features/navigation';
import { renderApp } from '../test-utils';

type Ctx = Awaited<ReturnType<typeof renderApp>>;

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 5, 17, 10, 0, 0) })); // mercredi 17 juin 2026
afterEach(() => vi.useRealTimers());

async function newTaskList(user: ReturnType<typeof userEvent.setup>) {
  await user.keyboard('{Control>}k{/Control}');
  await user.type(await screen.findByRole('combobox'), 'liste de tâches');
  await user.keyboard('{Enter}');
  await screen.findByRole('grid', { name: 'Tableau de la base de données' }, { timeout: 4000 });
}

describe('modèle « liste de tâches »', () => {
  it('crée une base de tâches complète : propriétés, vues liste/kanban/calendrier', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    await newTaskList(user);
    const db = [...ctx.api.dbProps.keys()][0]!;
    const names = ctx.api.dbProps.get(db)!.map((p) => `${p.name}:${p.type}`);
    expect(names).toEqual([
      'Tâche:title',
      'Statut:status',
      'Priorité:select',
      'Début:date',
      'Échéance:date',
      'Répétition:select',
      'Rappel:datetime',
      'Progression:percent',
      'Temps passé:number',
      'Tâche parente:relation',
      'Sous-tâches:relation',
      'Bloquée par:relation',
      'Bloque:relation',
      'En retard:formula',
    ]);
    await waitFor(() =>
      expect(ctx.api.dbViews.get(db)!.map((v) => `${v.name}:${v.layout}`)).toEqual([
        'Liste:table',
        'Kanban:kanban',
        'Calendrier:calendar',
      ]),
    );
    const due = ctx.api.dbProps.get(db)!.find((p) => p.name === 'Échéance')!;
    expect(ctx.api.dbViews.get(db)![0]!.config['sorts']).toEqual([
      { propertyId: due.id, direction: 'asc' },
    ]);
    expect(ctx.api.dbViews.get(db)![2]!.config['dateProperty']).toBe(due.id);
    expect(screen.getByRole('tab', { name: 'Calendrier' })).toBeInTheDocument();
    // sous-tâches et dépendances sont des relations à double sens
    const parent = ctx.api.dbProps.get(db)!.find((p) => p.name === 'Tâche parente')!;
    expect(parent.config['reversePropertyId']).toBe(
      ctx.api.dbProps.get(db)!.find((p) => p.name === 'Sous-tâches')!.id,
    );
  });

  it('une tâche est un seul objet : statut, échéance, sous-tâche et retard cohérents partout', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    await newTaskList(user);
    const db = [...ctx.api.dbProps.keys()][0]!;
    const P = (n: string) => ctx.api.dbProps.get(db)!.find((p) => p.name === n)!;
    const status = P('Statut');
    const optId = (name: string) =>
      (status.config['options'] as { id: string; name: string }[]).find((o) => o.name === name)!.id;
    const t1 = await ctx.api.rowCreate({
      databaseId: db,
      title: 'Écrire le rapport',
      props: { [P('Échéance').id]: '2026-06-10', [status.id]: optId('En cours') },
    });
    const t2 = await ctx.api.rowCreate({
      databaseId: db,
      title: 'Relire',
      props: { [P('Échéance').id]: '2026-06-10', [status.id]: optId('Terminé') },
    });
    const t3 = await ctx.api.rowCreate({
      databaseId: db,
      title: 'Plus tard',
      props: { [P('Échéance').id]: '2026-07-01' },
    });
    await ctx.databases.getState().load(db, true);
    const evalLate = (id: string) => {
      const d = ctx.databases.getState().dbs[db]!;
      return d.rows.find((r) => r.id === id)!;
    };
    await screen.findByRole('grid', { name: 'Tableau de la base de données' });
    const text = (r: number, c: number) =>
      (screen.getByRole('grid').querySelector(`[data-cell="${r}:${c}"]`) as HTMLElement)
        .textContent;
    // tri par échéance : les deux échues d'abord ; « En retard » = oui pour la non terminée seulement
    await waitFor(() =>
      expect(screen.getByRole('grid').querySelectorAll('[data-cell$=":0"]').length).toBe(3),
    );
    const titles = [...screen.getByRole('grid').querySelectorAll('[data-cell$=":0"]')].map((c) =>
      c.textContent?.replace(/Ouvrir$/, ''),
    );
    expect(titles[2]).toBe('Plus tard');
    const col = 13; // « En retard »
    const byTitle = (title: string) => titles.indexOf(title);
    expect(text(byTitle('Écrire le rapport'), col)).toBe('Oui');
    expect(text(byTitle('Relire'), col)).toBe('Non');
    expect(text(byTitle('Plus tard'), col)).toBe('Non');
    // sous-tâche : relation à double sens
    await ctx.databases
      .getState()
      .setCells(db, [{ rowId: t3.id, propertyId: P('Tâche parente').id, value: [t1.id] }]);
    expect(ctx.api.rowProps.get(t1.id)?.[P('Sous-tâches').id]).toEqual([t3.id]);
    expect(evalLate(t1.id).props[P('Sous-tâches').id]).toEqual([t3.id]);
    // terminer la tâche en retard : le retard disparaît immédiatement
    await ctx.databases
      .getState()
      .setCells(db, [{ rowId: t1.id, propertyId: status.id, value: optId('Terminé') }]);
    await waitFor(() => expect(text(byTitle('Écrire le rapport'), col)).toBe('Non'));
    void t2;
  });
});

describe('vue calendrier', () => {
  async function seedCalendar(ctx: Ctx) {
    const d = await ctx.api.dbCreate({
      parentId: null,
      title: 'Agenda',
      titlePropertyName: 'Nom',
      viewName: 'Tableau',
    });
    const due = await ctx.api.propCreate({
      databaseId: d.node.id,
      name: 'Date',
      kind: 'date',
      config: {},
      beforeId: null,
      twoWayName: null,
    });
    await ctx.api.viewCreate({
      databaseId: d.node.id,
      name: 'Cal',
      layout: 'calendar',
      config: { dateProperty: due.id },
    });
    const a = await ctx.api.rowCreate({
      databaseId: d.node.id,
      title: 'Réunion',
      props: { [due.id]: '2026-06-17' },
    });
    const b = await ctx.api.rowCreate({
      databaseId: d.node.id,
      title: 'Dentiste',
      props: { [due.id]: '2026-06-19' },
    });
    const c = await ctx.api.rowCreate({
      databaseId: d.node.id,
      title: 'Idée sans date',
      props: null,
    });
    await ctx.pages.getState().refresh();
    act(() => useNav.getState().navigate({ name: 'database', id: d.node.id }));
    await screen.findByRole('grid', { name: 'Tableau de la base de données' });
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Cal' }));
    await screen.findByRole('grid', { name: 'Calendrier' });
    return { d, due, a, b, c };
  }
  const dayCell = (label: RegExp) =>
    screen.getAllByRole('gridcell').find((c) => label.test(c.getAttribute('aria-label') ?? ''))!;

  it('place chaque ligne sur son jour, affiche le mois courant et les lignes sans date', async () => {
    const ctx = await renderApp();
    await seedCalendar(ctx);
    expect(screen.getByRole('heading', { name: /juin 2026/i })).toBeInTheDocument();
    expect(within(dayCell(/mercredi 17 juin 2026/i)).getByText('Réunion')).toBeInTheDocument();
    expect(within(dayCell(/vendredi 19 juin 2026/i)).getByText('Dentiste')).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Sans date' })).getByText('Idée sans date'),
    ).toBeInTheDocument();
    expect(dayCell(/mercredi 17 juin 2026/i).getAttribute('aria-label')).toMatch(/1 élément/);
    // la semaine commence le lundi
    expect(screen.getAllByRole('columnheader')[0]).toHaveTextContent(/lun/i);
  });

  it('glisser une ligne sur un autre jour change sa date ; le menu clavier fait de même', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { due, a, b } = await seedCalendar(ctx);
    const dt = { setData() {}, getData: () => '', effectAllowed: 'all', dropEffect: 'move' };
    const card = within(dayCell(/mercredi 17 juin 2026/i))
      .getByText('Réunion')
      .closest('[draggable]')!;
    fireEvent.dragStart(card, { dataTransfer: dt });
    fireEvent.dragOver(dayCell(/jeudi 18 juin 2026/i), { dataTransfer: dt });
    fireEvent.drop(dayCell(/jeudi 18 juin 2026/i), { dataTransfer: dt });
    await waitFor(() => expect(ctx.api.rowProps.get(a.id)?.[due.id]).toBe('2026-06-18'));
    expect(within(dayCell(/jeudi 18 juin 2026/i)).getByText('Réunion')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Déplacer la date de Dentiste' }));
    await user.click(await screen.findByRole('menuitem', { name: 'La semaine suivante' }));
    await waitFor(() => expect(ctx.api.rowProps.get(b.id)?.[due.id]).toBe('2026-06-26'));
  });

  it('créer une ligne depuis un jour, planifier une ligne sans date, naviguer de mois en mois', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { d, due, c } = await seedCalendar(ctx);
    await user.click(
      within(dayCell(/lundi 22 juin 2026/i)).getByRole('button', {
        name: /Ajouter une ligne le 22 juin 2026/i,
      }),
    );
    await waitFor(() =>
      expect(ctx.api.rowCreate).toHaveBeenCalledWith(
        expect.objectContaining({ databaseId: d.node.id, props: { [due.id]: '2026-06-22' } }),
      ),
    );
    await user.click(
      screen.getByRole('button', {
        name: 'Planifier Idée sans date aujourd’hui'.replace('’', "'"),
      }),
    );
    await waitFor(() => expect(ctx.api.rowProps.get(c.id)?.[due.id]).toBe('2026-06-17'));
    await user.click(screen.getByRole('button', { name: 'Période suivante' }));
    expect(screen.getByRole('heading', { name: /juillet 2026/i })).toBeInTheDocument();
    expect(screen.queryByText('Réunion')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: "Aujourd'hui" }));
    expect(screen.getByRole('heading', { name: /juin 2026/i })).toBeInTheDocument();
  });

  it('vue semaine, changement de propriété date, état vide sans propriété date, accessibilité', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    await seedCalendar(ctx);
    await user.click(screen.getByRole('radio', { name: 'Semaine' }));
    expect(
      await screen.findByRole('heading', { name: /Semaine du 15 juin 2026/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('gridcell')).toHaveLength(7);
    expect(await axe(document.body)).toHaveNoViolations();

    const d2 = await ctx.api.dbCreate({
      parentId: null,
      title: 'Sans date',
      titlePropertyName: 'Nom',
      viewName: 'Tableau',
    });
    await ctx.api.viewCreate({
      databaseId: d2.node.id,
      name: 'Cal',
      layout: 'calendar',
      config: {},
    });
    await ctx.pages.getState().refresh();
    act(() => useNav.getState().navigate({ name: 'database', id: d2.node.id }));
    await user.click(await screen.findByRole('tab', { name: 'Cal' }));
    expect(await screen.findByText('Ajoutez une propriété date')).toBeInTheDocument();
  });

  it('un jour chargé affiche « + n autre(s) » qui ouvre la semaine', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    const { d, due } = await seedCalendar(ctx);
    for (const n of ['A', 'B', 'C', 'D', 'E'])
      await ctx.api.rowCreate({
        databaseId: d.node.id,
        title: n,
        props: { [due.id]: '2026-06-17' },
      });
    await ctx.databases.getState().load(d.node.id, true);
    const more = await screen.findByRole('button', { name: /\+ 3 autre\(s\)/ });
    await user.click(more);
    expect(
      await screen.findByRole('heading', { name: /Semaine du 15 juin 2026/i }),
    ).toBeInTheDocument();
    expect(within(dayCell(/mercredi 17 juin 2026/i)).getAllByText(/^[A-E]$|Réunion/)).toHaveLength(
      6,
    );
  });
});
