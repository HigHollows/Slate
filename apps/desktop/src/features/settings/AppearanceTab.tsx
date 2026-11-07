import { useTranslation } from 'react-i18next';
import {
  ACCENT_PRESETS,
  FONT_SCALES,
  usePreferences,
  usePreferencesStore,
  type Preferences,
} from '../preferences';
import { Button, Segmented, SettingRow, cx } from '../../shared/ui';

export function AppearanceTab() {
  const { t } = useTranslation();
  const store = usePreferencesStore();
  const p = usePreferences((s) => s.prefs);
  const set = (patch: Partial<Preferences>) =>
    void store
      .getState()
      .update(patch)
      .catch(() => undefined);

  return (
    <section aria-labelledby="tab-appearance">
      <h2 id="tab-appearance" className="sr-only">
        {t('settings.tabs.appearance')}
      </h2>
      <SettingRow title={t('settings.theme')} description={t('settings.themeHint')}>
        <Segmented
          label={t('settings.theme')}
          value={p.theme}
          onChange={(theme) => set({ theme })}
          options={[
            { value: 'system', label: t('settings.themeSystem') },
            { value: 'light', label: t('settings.themeLight') },
            { value: 'dark', label: t('settings.themeDark') },
          ]}
        />
      </SettingRow>

      <SettingRow title={t('settings.accent')} description={t('settings.accentHint')}>
        <div className="flex items-center gap-2">
          <div role="radiogroup" aria-label={t('settings.accent')} className="flex gap-1.5">
            {ACCENT_PRESETS.map((a) => {
              const on = p.accent.toLowerCase() === a.hex.toLowerCase();
              return (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={t(`accent.${a.id}`)}
                  onClick={() => set({ accent: a.hex })}
                  style={{ backgroundColor: a.hex === 'auto' ? 'var(--fg)' : a.hex }}
                  className={cx(
                    'size-5 rounded-full transition-transform hover:scale-110',
                    on && 'ring-2 ring-fg ring-offset-2 ring-offset-bg border border-line',
                  )}
                />
              );
            })}
          </div>
        </div>
      </SettingRow>

      <SettingRow title={t('settings.density')} description={t('settings.densityHint')}>
        <Segmented
          label={t('settings.density')}
          value={p.density}
          onChange={(density) => set({ density })}
          options={[
            { value: 'comfortable', label: t('settings.densityComfortable') },
            { value: 'compact', label: t('settings.densityCompact') },
          ]}
        />
      </SettingRow>

      <SettingRow title={t('settings.taskStrike')} description={t('settings.taskStrikeHint')}>
        <Segmented
          label={t('settings.taskStrike')}
          value={p.taskStrike ? 'on' : 'off'}
          onChange={(v) => set({ taskStrike: v === 'on' })}
          options={[
            { value: 'on', label: t('settings.taskStrikeOn') },
            { value: 'off', label: t('settings.taskStrikeOff') },
          ]}
        />
      </SettingRow>

      <SettingRow title={t('settings.textSize')} description={t('settings.textSizeHint')}>
        <Segmented
          label={t('settings.textSize')}
          value={String(p.fontScale)}
          onChange={(v) => set({ fontScale: Number(v) })}
          options={FONT_SCALES.map((s) => ({
            value: String(s),
            label: `${Math.round(s * 100)} %`,
          }))}
        />
      </SettingRow>

      <SettingRow title={t('settings.font')} description={t('settings.fontHint')}>
        <Segmented
          label={t('settings.font')}
          value={p.font}
          onChange={(font) => set({ font })}
          options={[
            { value: 'inter', label: 'Inter' },
            { value: 'system', label: t('settings.fontSystem') },
            { value: 'serif', label: t('settings.fontSerif') },
          ]}
        />
      </SettingRow>

      <div className="pt-4">
        <Button
          variant="ghost"
          onClick={() =>
            void store
              .getState()
              .reset(['theme', 'accent', 'density', 'fontScale', 'font', 'taskStrike'])
              .catch(() => undefined)
          }
        >
          {t('settings.resetAppearance')}
        </Button>
      </div>
    </section>
  );
}
