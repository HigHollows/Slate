import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { renderApp } from '../test-utils';

beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 5, 17, 10, 0, 0) }));
afterEach(() => vi.useRealTimers());

async function fromPalette(user: ReturnType<typeof userEvent.setup>, query: string) {
  await user.keyboard('{Control>}k{/Control}');
  await user.type(await screen.findByRole('combobox'), query);
  await user.keyboard('{Enter}');
}

describe('objectifs', () => {
  it('crée une base d’objectifs : statut, échéance (rôle), progression saisie, sous-objectifs', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    await fromPalette(user, 'liste d’objectifs');
    await screen.findByRole('grid', { name: 'Tableau de la base de données' }, { timeout: 4000 });
    const db = [...ctx.api.dbProps.keys()][0]!;
    const props = ctx.api.dbProps.get(db)!;
    expect(props.map((p) => `${p.name}:${p.type}`)).toEqual([
      'Objectif:title',
      'Statut:status',
      'Échéance:date',
      'Progression:percent',
      'Objectif parent:relation',
      'Sous-objectifs:relation',
    ]);
    expect(props.find((p) => p.name === 'Échéance')!.config['role']).toBe('due');
    await waitFor(() =>
      expect(ctx.api.dbViews.get(db)!.map((v) => `${v.name}:${v.layout}`)).toEqual([
        'Liste:table',
        'Tableau:kanban',
      ]),
    );
  });
});

describe('habitudes', () => {
  it('suivi quotidien : pointer et dépointer un jour, série et accessibilité', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    await fromPalette(user, 'suivi d’habitudes');
    await screen.findByRole('grid', { name: 'Tableau de la base de données' }, { timeout: 4000 });
    const db = [...ctx.api.dbProps.keys()][0]!;
    expect(
      ctx.api.dbProps.get(db)!.find((p) => p.name === 'Objectif / semaine')!.config['role'],
    ).toBe('habit_goal');
    expect(await screen.findByText(/Aucune habitude/)).toBeInTheDocument();

    await ctx.databases.getState().createRow(db, { title: 'Lire' });
    const today = screen.getAllByRole('button', { name: /^Lire — / }).at(-1)!;
    expect(today).toHaveAttribute('aria-pressed', 'false');
    await user.click(today);
    await waitFor(() => expect(today).toHaveAttribute('aria-pressed', 'true'));
    expect(ctx.api.habitLogSet).toHaveBeenCalledWith(
      expect.any(String),
      '2026-06-17',
      true,
      '2026-06-17',
    );
    expect(await screen.findByText('1 jour')).toBeInTheDocument();
    expect(await axe(document.body)).toHaveNoViolations();

    await user.click(today);
    await waitFor(() => expect(today).toHaveAttribute('aria-pressed', 'false'));
    expect(ctx.api.habitLogSet).toHaveBeenLastCalledWith(
      expect.any(String),
      '2026-06-17',
      false,
      '2026-06-17',
    );
  });

  it('un refus du cœur annule le pointage à l’écran', async () => {
    const user = userEvent.setup();
    const ctx = await renderApp();
    await fromPalette(user, 'suivi d’habitudes');
    await screen.findByRole('grid', { name: 'Tableau de la base de données' }, { timeout: 4000 });
    const db = [...ctx.api.dbProps.keys()][0]!;
    await ctx.databases.getState().createRow(db, { title: 'Marcher' });
    const today = (await screen.findAllByRole('button', { name: /^Marcher — / })).at(-1)!;
    ctx.api.habitLogSet.mockRejectedValueOnce({
      code: 'ipc.invalid',
      messageKey: 'errors.invalid',
    });
    await user.click(today);
    await waitFor(() => expect(ctx.onError).toHaveBeenCalled());
    expect(today).toHaveAttribute('aria-pressed', 'false');
  });
});
