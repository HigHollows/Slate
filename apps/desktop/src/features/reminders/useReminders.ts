import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNav } from '../navigation';
import { toast } from '../../shared/ui';
import { createReminderPoller, type RemindersApi } from './poller';

const INTERVAL_MS = 30_000;

/** Vérifie les rappels au démarrage, toutes les 30 s et au retour dans la fenêtre. Actif seulement tant que l'application tourne. */
export function useReminders(api: RemindersApi, onError: (e: unknown) => void) {
  const { t } = useTranslation();
  useEffect(() => {
    const poller = createReminderPoller({
      api,
      onError,
      show: (r) =>
        toast.info(t('reminders.toast', { title: r.title }), {
          label: t('reminders.open'),
          run: () => useNav.getState().navigate({ name: 'page', id: r.rowId }),
        }),
      text: (r) => ({ title: t('reminders.notificationTitle'), body: r.title }),
    });
    void poller.tick();
    const id = window.setInterval(() => void poller.tick(), INTERVAL_MS);
    const onFocus = () => void poller.tick();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('focus', onFocus);
    };
  }, [api, onError, t]);
}
