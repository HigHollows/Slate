import { useTranslation } from 'react-i18next';
import { usePreferences, usePreferencesStore, type Preferences } from '../preferences';
import { Segmented, SettingRow } from '../../shared/ui';

export function LanguageTab() {
  const { t, i18n } = useTranslation();
  const store = usePreferencesStore();
  const locale = usePreferences((s) => s.prefs.locale);
  const lang = i18n.language;
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const set = (patch: Partial<Preferences>) =>
    void store
      .getState()
      .update(patch)
      .catch(() => undefined);

  return (
    <section aria-labelledby="tab-language">
      <h2 id="tab-language" className="sr-only">
        {t('settings.tabs.language')}
      </h2>
      <SettingRow title={t('settings.language')} description={t('settings.languageHint')}>
        <Segmented
          label={t('settings.language')}
          value={locale}
          onChange={(l) => set({ locale: l })}
          options={[
            { value: 'auto', label: t('settings.languageAuto') },
            { value: 'fr', label: 'Français' },
            { value: 'en', label: 'English' },
          ]}
        />
      </SettingRow>
      <div className="mt-4 rounded-lg bg-surface p-4">
        <p className="mb-2 font-medium">{t('settings.formatsPreview')}</p>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-muted">
          <dt>{t('settings.formatDate')}</dt>
          <dd className="text-fg">
            {new Intl.DateTimeFormat(lang, { dateStyle: 'full' }).format(now)}
          </dd>
          <dt>{t('settings.formatTime')}</dt>
          <dd className="text-fg">
            {new Intl.DateTimeFormat(lang, { timeStyle: 'short' }).format(now)}
          </dd>
          <dt>{t('settings.formatNumber')}</dt>
          <dd className="text-fg">{new Intl.NumberFormat(lang).format(1234567.89)}</dd>
          <dt>{t('settings.formatTimezone')}</dt>
          <dd className="text-fg">{tz}</dd>
        </dl>
      </div>
    </section>
  );
}
