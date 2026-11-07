export interface Reminder {
  rowId: string;
  databaseId: string;
  propertyId: string;
  title: string;
  fireAt: string;
}

export interface RemindersApi {
  remindersDue(): Promise<Reminder[]>;
  reminderAck(rowId: string, propertyId: string, fireAt: string): Promise<void>;
  reminderNotify(title: string, body: string): Promise<void>;
}

export interface PollerDeps {
  api: RemindersApi;
  /** Affiche un rappel dans l'application (toast cliquable). */
  show(r: Reminder): void;
  /** Titre et corps de la notification système. */
  text(r: Reminder): { title: string; body: string };
  onError?(e: unknown): void;
}

/**
 * Interroge le cœur pour les rappels échus. Chaque rappel est : montré dans l'app, envoyé au système, puis acquitté.
 * L'acquittement a lieu même si la notification système échoue (l'échec est signalé) : on ne rejoue pas indéfiniment.
 * Les appels ne se chevauchent jamais (focus + minuterie simultanés).
 */
export function createReminderPoller(d: PollerDeps) {
  let running = false;
  const inFlight = new Set<string>();
  return {
    async tick(): Promise<number> {
      if (running) return 0;
      running = true;
      let n = 0;
      try {
        for (const r of await d.api.remindersDue()) {
          const key = `${r.rowId}|${r.propertyId}|${r.fireAt}`;
          if (inFlight.has(key)) continue;
          inFlight.add(key);
          d.show(r);
          const { title, body } = d.text(r);
          try {
            await d.api.reminderNotify(title, body);
          } catch (e) {
            d.onError?.(e);
          }
          try {
            await d.api.reminderAck(r.rowId, r.propertyId, r.fireAt);
          } finally {
            inFlight.delete(key);
          }
          n++;
        }
      } catch (e) {
        d.onError?.(e);
      } finally {
        running = false;
      }
      return n;
    },
  };
}
