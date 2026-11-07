import { describe, expect, it, vi } from 'vitest';
import { createReminderPoller, type Reminder } from './poller';

const r = (id: string, at = '2026-06-01T08:00:00Z'): Reminder => ({
  rowId: id,
  databaseId: 'd',
  propertyId: 'p',
  title: `Tâche ${id}`,
  fireAt: at,
});
const setup = (
  due: Reminder[][],
  over: Partial<Record<'notify' | 'ack', () => Promise<void>>> = {},
) => {
  const queue = [...due];
  const calls: string[] = [];
  const api = {
    remindersDue: vi.fn(async () => queue.shift() ?? []),
    reminderAck: vi.fn(async (row: string) => {
      calls.push(`ack:${row}`);
      await over.ack?.();
    }),
    reminderNotify: vi.fn(async (_t: string, b: string) => {
      calls.push(`notify:${b}`);
      await over.notify?.();
    }),
  };
  const show = vi.fn((x: Reminder) => calls.push(`show:${x.rowId}`));
  const onError = vi.fn();
  const poller = createReminderPoller({
    api,
    show,
    onError,
    text: (x) => ({ title: 'Rappel', body: x.title }),
  });
  return { api, show, onError, poller, calls };
};

describe('rappels', () => {
  it('montre, notifie puis acquitte chaque rappel, dans l’ordre reçu', async () => {
    const s = setup([[r('a'), r('b')]]);
    expect(await s.poller.tick()).toBe(2);
    expect(s.calls).toEqual([
      'show:a',
      'notify:Tâche a',
      'ack:a',
      'show:b',
      'notify:Tâche b',
      'ack:b',
    ]);
  });

  it('une notification système en échec est signalée mais le rappel est quand même acquitté', async () => {
    const s = setup([[r('a')]], {
      notify: async () => {
        throw new Error('refusée');
      },
    });
    expect(await s.poller.tick()).toBe(1);
    expect(s.onError).toHaveBeenCalledTimes(1);
    expect(s.api.reminderAck).toHaveBeenCalledWith('a', 'p', '2026-06-01T08:00:00Z');
  });

  it('un échec de lecture est signalé et n’empêche pas le tick suivant', async () => {
    const s = setup([[r('a')]]);
    s.api.remindersDue.mockRejectedValueOnce(new Error('verrouillé'));
    expect(await s.poller.tick()).toBe(0);
    expect(s.onError).toHaveBeenCalledTimes(1);
    expect(await s.poller.tick()).toBe(1);
  });

  it('deux ticks simultanés ne montrent le rappel qu’une fois', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    const s = setup([[r('a')], [r('a')]], { notify: () => gate });
    const first = s.poller.tick();
    expect(await s.poller.tick()).toBe(0); // chevauchement ignoré
    release();
    expect(await first).toBe(1);
    expect(s.show).toHaveBeenCalledTimes(1);
  });
});
