export { PreferencesProvider, usePreferences, usePreferencesStore } from './context';
export { createPreferencesStore, type PreferencesStore, type SettingsApi } from './store';
export {
  ACCENT_PRESETS,
  FONT_SCALES,
  READING_WIDTHS,
  DEFAULT_PREFERENCES,
  type Preferences,
} from './model';
export { accentForeground, contrastRatio } from './apply';
